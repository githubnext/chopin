import { GitHubError } from "../github/client";
import { extensionType, HOSTED_IMAGE_FILE } from "./format";

import type { HostedAuth } from "../auth/routes";
import type { Router } from "../http/router";

function plain(status: number, message: string): Response {
	return new Response(message, {
		status,
		headers: {
			"cache-control": "no-store",
			"content-type": "text/plain; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}

/**
 * Serve uploaded document images to people who can read a document holding
 * them. Every refusal is the same 404, so a URL reveals nothing to anyone else.
 */
export function registerImageRoutes(router: Router, auth: HostedAuth): void {
	router.on("GET", "/images/:file", async (request, _url, params) => {
		let missing = plain(404, "image not found");
		let match = HOSTED_IMAGE_FILE.exec(params.file!);
		let type = match ? extensionType(match[2]!) : undefined;
		if (!match || !type) return missing;
		let sha256 = match[1]!;
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return missing;
			let denied = new Set<string>();
			for (let channelId of await auth.storage.images.channels(sha256)) {
				let channel = await auth.storage.channels.get(channelId);
				if (!channel || denied.has(channel.repositoryId)) continue;
				let { value: repository } = await auth.sessions.use(
					session,
					token =>
						auth.github.repositoryAccess(token, channel.repositoryOwner, channel.repositoryName),
				);
				if (repository?.id !== channel.repositoryId || !repository.permissions.pull) {
					denied.add(channel.repositoryId);
					continue;
				}
				let image = await auth.storage.images.get(channelId, sha256);
				if (!image || image.mimeType !== type) return missing;
				return new Response(image.bytes.slice(), {
					headers: {
						"cache-control": "private, max-age=31536000, immutable",
						"content-disposition": "inline",
						"content-security-policy": "default-src 'none'; sandbox",
						"content-type": image.mimeType,
						"x-content-type-options": "nosniff",
					},
				});
			}
			return missing;
		} catch (err) {
			if (err instanceof GitHubError && err.status === 401) return missing;
			return plain(503, "image is temporarily unavailable");
		}
	});
}
