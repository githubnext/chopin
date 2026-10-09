import { isChannelId } from "../channels/id";
import { GitHubError } from "../github/client";
import { uid } from "../ids";
import { StorageError } from "../storage/errors";
import { decisionWatch } from "./decision-watch";

import type { HostedAuth } from "../auth/routes";
import type { SidebarSocketData, SocketData } from "../wire";

export type Admission = { data: SocketData } | { status: number; reason: string };

export type SidebarAdmission = { data: SidebarSocketData } | { status: number; reason: string };

function probing(request: Request): boolean {
	return request.headers.get("x-chopin-socket-probe") === "1"
		&& request.headers.get("upgrade")?.toLowerCase() !== "websocket";
}

export async function admitSidebar(request: Request, auth: HostedAuth): Promise<SidebarAdmission> {
	try {
		if (!probing(request) && request.headers.get("origin") !== auth.config.origin) {
			return { status: 403, reason: "origin is not allowed" };
		}
		let session = await auth.sessions.authenticate(request);
		let credential = auth.sessions.credential(request);
		if (!session || !credential) return { status: 401, reason: "authentication required" };
		return {
			data: {
				sidebar: true,
				handle: session.user.login,
				principalId: session.user.id,
				sessionId: session.session.id,
				authorizedUntil: session.session.expiresAt.getTime(),
				credential,
				decisionWatch: decisionWatch(),
			},
		};
	} catch (err) {
		if (err instanceof StorageError && err.failure === "unavailable") {
			return { status: 503, reason: "session storage is temporarily unavailable" };
		}
		return { status: 500, reason: "admission failed" };
	}
}

export async function admit(
	request: Request,
	url: URL,
	auth: HostedAuth,
	options: {
		deleting?: (channelId: string) => boolean;
		readOnly?: (channelId: string) => boolean;
	} = {},
): Promise<Admission> {
	try {
		if (!probing(request) && request.headers.get("origin") !== auth.config.origin) {
			return { status: 403, reason: "origin is not allowed" };
		}
		let session = await auth.sessions.authenticate(request);
		if (!session) return { status: 401, reason: "authentication required" };
		let id = (url.searchParams.get("channel") || "").toLowerCase();
		if (!isChannelId(id)) return { status: 400, reason: "bad channel" };
		if (options.deleting?.(id)) return { status: 404, reason: "channel not found" };
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
		let canManage = repository.permissions.push || repository.permissions.admin;
		return {
			data: {
				room: channel.id,
				channelTitle: channel.title,
				channelSlug: channel.slug,
				channelUpdatedAt: channel.updatedAt.toISOString(),
				channelDescriptionRevision: channel.description?.revision ?? 0,
				...(channel.description ? { channelDescription: channel.description.value } : {}),
				...(channel.archivedAt
					? { channelArchivedAt: channel.archivedAt.toISOString() }
					: {}),
				handle: session.user.login,
				client: uid(),
				canEdit: canManage && !channel.archivedAt && !options.readOnly?.(channel.id),
				canManage,
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
