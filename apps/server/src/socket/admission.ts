import { isChannelId } from "../channels/id";
import { GitHubError } from "../github/client";
import { uid } from "../ids";
import { StorageError } from "../storage/errors";

import type { HostedAuth } from "../auth/routes";
import type { SocketData } from "../wire";

export type Admission = { data: SocketData } | { status: number; reason: string };

export async function admit(
	request: Request,
	url: URL,
	auth: HostedAuth,
): Promise<Admission> {
	try {
		let probe = request.headers.get("x-chopin-socket-probe") === "1"
			&& request.headers.get("upgrade")?.toLowerCase() !== "websocket";
		if (!probe && request.headers.get("origin") !== auth.config.origin) {
			return { status: 403, reason: "origin is not allowed" };
		}
		let session = await auth.sessions.authenticate(request);
		if (!session) return { status: 401, reason: "authentication required" };
		let id = (url.searchParams.get("channel") || "").toLowerCase();
		if (!isChannelId(id)) return { status: 400, reason: "bad channel" };
		let channel = await auth.storage.channels.get(id);
		if (!channel) return { status: 404, reason: "channel not found" };
		let access = await auth.sessions.use(
			session,
			token =>
				auth.github.repositoryAccess(
					token,
					channel.repositoryOwner,
					channel.repositoryName,
				),
		);
		let repository = access.value;
		if (!repository || repository.id !== channel.repositoryId || !repository.permissions.pull) {
			return { status: 404, reason: "channel not found" };
		}
		let credential = auth.sessions.credential(request);
		if (!credential) return { status: 401, reason: "authentication required" };
		return {
			data: {
				room: channel.id,
				channelTitle: channel.title,
				channelSlug: channel.slug,
				channelUpdatedAt: channel.updatedAt.toISOString(),
				handle: session.user.login,
				client: uid(),
				canEdit: repository.permissions.push || repository.permissions.admin,
				principalId: session.user.id,
				sessionId: session.session.id,
				authorizedUntil: session.session.expiresAt.getTime(),
				credential,
				repositoryId: repository.id,
				repositoryOwner: repository.owner,
				repositoryName: repository.name,
				repositoryDefaultBranch: repository.defaultBranch,
				accessCheckedAt: Date.now(),
			},
		};
	} catch (err) {
		if (err instanceof GitHubError) {
			let transient = err.status === 429 || err.status === 502 || err.status === 503;
			return {
				status: err.status === 401 ? 401 : transient ? 503 : 403,
				reason: err.status === 401
					? "GitHub authorization expired"
					: transient
					? "repository access is temporarily unavailable"
					: "repository access failed",
			};
		}
		if (err instanceof StorageError) {
			return {
				status: err.failure === "unavailable" ? 503 : 500,
				reason: "channel storage failed",
			};
		}
		return { status: 500, reason: "admission failed" };
	}
}
