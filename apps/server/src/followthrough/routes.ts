import { isChannelId } from "../channels/id";
import { GitHubError } from "../github/client";
import { StorageError } from "../storage/errors";
import { resultEvidence } from "./source";
import { followthroughView } from "./view";
import type { HostedAuth } from "../auth/routes";
import type { Router } from "../http/router";
import type { Followthrough } from "../storage/followthrough";
import type { Lease } from "../storage/model";

function json(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: {
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});
}

async function revision(request: Request): Promise<number | undefined> {
	if (!request.body) return;
	let bytes: Uint8Array[] = [];
	let size = 0;
	for await (let chunk of request.body) {
		size += chunk.length;
		if (size > 256) return;
		bytes.push(chunk);
	}
	try {
		let value = JSON.parse(Buffer.concat(bytes).toString("utf8"));
		if (
			value && typeof value === "object" && !Array.isArray(value)
			&& Object.keys(value).length === 1 && Number.isSafeInteger(value.revision)
			&& value.revision >= 0
		) return value.revision;
	} catch {}
}

/** Review controls change scheduling only; they never claim a Planner owner or launch evidence work. */
export function registerFollowthroughRoutes(router: Router, auth: HostedAuth, options: {
	lease: () => Lease;
	changed: (value: Followthrough) => void;
	wake: (channelId: string) => void;
}): void {
	for (let action of ["retry", "dismiss"] as const) {
		router.on(
			"POST",
			`/api/channels/:channelId/followthrough/:id/${action}`,
			async (request, _url, params) => {
				if (request.headers.get("origin") !== auth.config.origin) {
					return json({ error: "origin is not allowed" }, 403);
				}
				try {
					let session = await auth.sessions.authenticate(request);
					if (!session) return json({ error: "authentication required" }, 401);
					if (!isChannelId(params.channelId!) || !/^[a-f0-9]{64}$/.test(params.id!)) {
						return json({ error: "review not found" }, 404);
					}
					let channel = await auth.storage.channels.get(params.channelId!);
					if (!channel || channel.parentChannelId) return json({ error: "review not found" }, 404);
					let checked = await auth.sessions.use(session, token =>
						auth.github.repositoryAccess(
							token,
							channel.repositoryOwner,
							channel.repositoryName,
						));
					let repository = checked.value;
					if (
						!repository || repository.id !== channel.repositoryId || !repository.permissions.pull
					) {
						return json({ error: "review not found" }, 404);
					}
					if (!repository.permissions.push && !repository.permissions.admin) {
						return json({ error: "repository write access is required" }, 403);
					}
					if (channel.archivedAt) return json({ error: "document is archived" }, 409);
					let expected = await revision(request);
					if (expected === undefined) return json({ error: "review revision is required" }, 400);
					let store = auth.storage.followthrough;
					let current = await store.get(channel.id, params.id!);
					if (!current) return json({ error: "review not found" }, 404);
					if (action === "retry" && !await resultEvidence(auth.storage, current)) {
						return json({ error: "the result is no longer available in this document" }, 409);
					}
					let saved = await store[action](channel.id, current.id, expected, options.lease());
					if (!saved) return json({ error: "review changed; refresh and try again" }, 409);
					options.changed(saved);
					if (action === "retry") options.wake(channel.id);
					return json(followthroughView(saved));
				} catch (error) {
					if (error instanceof GitHubError) {
						return json(
							{ error: "repository access could not be checked" },
							error.status === 401 ? 401 : 403,
						);
					}
					if (error instanceof StorageError && error.failure === "conflict") {
						return json({ error: "review changed; refresh and try again" }, 409);
					}
					return json({ error: "review could not be saved; try again" }, 503);
				}
			},
		);
	}
}
