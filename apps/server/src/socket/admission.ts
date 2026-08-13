import { GitHubError } from "../github/client";
import { uid } from "../ids";
import * as Rooms from "../rooms";
import { StorageError } from "../storage/errors";

import type { HostedAuth } from "../auth/routes";
import type { SocketData } from "../wire";

type Dependencies = {
	key: string | undefined;
	auth: HostedAuth | undefined;
};

export type Admission = { data: SocketData } | { status: number; reason: string };

export async function admit(
	request: Request,
	url: URL,
	dependencies: Dependencies,
): Promise<Admission> {
	if (!dependencies.auth) return legacy(url, dependencies.key);
	let auth = dependencies.auth;
	try {
		if (request.headers.get("origin") !== auth.config.origin) {
			return { status: 403, reason: "origin is not allowed" };
		}
		let session = await auth.sessions.authenticate(request);
		if (!session) return { status: 401, reason: "authentication required" };
		let room = (url.searchParams.get("room") || "").toLowerCase();
		if (!Rooms.validRoom(room)) return { status: 400, reason: "bad channel" };
		let channel = await auth.storage.channels.get(room);
		if (!channel) return { status: 404, reason: "channel not found" };
		let repository = await auth.github.repositoryAccess(
			session.oauthToken,
			channel.repositoryOwner,
			channel.repositoryName,
		);
		if (!repository || repository.id !== channel.repositoryId || !repository.permissions.pull) {
			return { status: 404, reason: "channel not found" };
		}
		return {
			data: {
				room: channel.id,
				handle: session.user.login,
				client: uid(),
				canEdit: repository.permissions.push || repository.permissions.admin,
				principalId: session.user.id,
				sessionId: session.session.id,
				authorizedUntil: session.session.expiresAt.getTime(),
				credential: auth.sessions.credential(request),
				repositoryId: repository.id,
				repositoryOwner: repository.owner,
				repositoryName: repository.name,
				repositoryDefaultBranch: repository.defaultBranch,
				accessCheckedAt: Date.now(),
			},
		};
	} catch (err) {
		if (err instanceof GitHubError) {
			if (err.status === 401) await auth.sessions.revoke(request).catch(() => {});
			return {
				status: err.status === 401 ? 401 : err.status === 429 ? 429 : 403,
				reason: err.status === 401 ? "GitHub authorization expired" : "repository access failed",
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

function legacy(url: URL, key: string | undefined): Admission {
	if (key && url.searchParams.get("key") !== key) {
		return { status: 403, reason: "access key required" };
	}
	let room = (url.searchParams.get("room") || "").toLowerCase();
	if (!Rooms.validRoom(room)) return { status: 400, reason: "bad room" };
	let handle = url.searchParams.get("as") || "";
	if (!Rooms.validHandle(handle)) return { status: 400, reason: "bad handle" };
	return {
		data: { room, handle, client: uid(), canEdit: true },
	};
}
