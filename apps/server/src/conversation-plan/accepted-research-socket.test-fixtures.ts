import type { Socket, SocketData } from "../wire";
import type { headingMemory } from "../chat/job-heading-memory.test-fixtures";

export function researchSocket(
	h: Awaited<ReturnType<typeof headingMemory>>,
	session: { id: string; cookie: string; expiresAt: Date },
) {
	let frames: Array<Record<string, unknown>> = [];
	let closes: number[] = [];
	let data: SocketData = {
		handle: "test",
		client: "consent-client",
		room: h.room.id,
		channelTitle: h.opened.channel.title,
		channelSlug: h.opened.channel.slug,
		channelUpdatedAt: h.opened.channel.updatedAt.toISOString(),
		channelDescriptionRevision: 0,
		canEdit: true,
		canManage: true,
		principalId: "U_test",
		sessionId: session.id,
		authorizedUntil: session.expiresAt.getTime(),
		credential: session.cookie.split(";")[0]!,
		repositoryId: h.opened.channel.repositoryId,
		repositoryOwner: "owner",
		repositoryName: "repository",
		repositoryDefaultBranch: "main",
		accessCheckedAt: Date.now(),
	};
	let ws = {
		data,
		send(value: string) {
			frames.push(JSON.parse(value));
		},
		close(code: number) {
			closes.push(code);
		},
	} as unknown as Socket;
	h.room.members.set(data.client, ws);
	return { ws, frames, closes, data };
}
