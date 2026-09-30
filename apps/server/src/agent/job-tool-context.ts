import type { DocumentRoom } from "./tools";

export type Context =
	& Pick<DocumentRoom, "plan" | "server" | "exclusive" | "anchors" | "changes">
	& {
		room: string;
	};

export function jobToolContext(room: DocumentRoom): Context {
	return {
		plan: room.plan,
		server: room.server,
		room: room.id,
		exclusive: room.exclusive,
		anchors: room.anchors,
		changes: room.changes,
	};
}
