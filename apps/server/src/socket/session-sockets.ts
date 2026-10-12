import type { ServerWebSocket } from "bun";

/** The close code a browser socket gets when the login that admitted it ends. */
export const SESSION_ENDED = 4401;

type Admitted = ServerWebSocket<{ sessionId: string }>;

/**
 * Every open browser socket, by the login session that admitted it.
 *
 * A socket's admission is a snapshot of its login, so when that login ends —
 * signed out, expired and swept, or rejected by GitHub — its sockets must close
 * at once, before the room can broadcast to them again, rather than at their
 * next frame or periodic recheck.
 */
export class SessionSockets {
	readonly #open = new Map<string, Set<Admitted>>();

	opened(ws: Admitted): void {
		let sockets = this.#open.get(ws.data.sessionId);
		if (!sockets) this.#open.set(ws.data.sessionId, sockets = new Set());
		sockets.add(ws);
	}

	closed(ws: Admitted): void {
		let sockets = this.#open.get(ws.data.sessionId);
		if (!sockets?.delete(ws)) return;
		if (sockets.size === 0) this.#open.delete(ws.data.sessionId);
	}

	/** Close every socket the ended login admitted. */
	revoke(sessionId: string): void {
		let sockets = this.#open.get(sessionId);
		if (!sockets) return;
		this.#open.delete(sessionId);
		for (let ws of sockets) ws.close(SESSION_ENDED, "session ended");
	}
}
