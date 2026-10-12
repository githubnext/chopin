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
 * next frame or periodic recheck. A login can also end between a socket's
 * admission and its open, before the socket is here to be closed, so `opened`
 * asks `live` first and closes a socket whose login has already ended.
 */
export class SessionSockets {
	readonly #open = new Map<string, Set<Admitted>>();
	readonly #live: (sessionId: string) => boolean;

	constructor(live: (sessionId: string) => boolean) {
		this.#live = live;
	}

	/**
	 * Track an opening socket, or close it with 4401 if its login has already
	 * ended. Call first in `open`, and subscribe or send only when this returns
	 * true, in the same synchronous turn, so no revocation can slip between.
	 */
	opened(ws: Admitted): boolean {
		if (!this.#live(ws.data.sessionId)) {
			ws.close(SESSION_ENDED, "session ended");
			return false;
		}
		let sockets = this.#open.get(ws.data.sessionId);
		if (!sockets) this.#open.set(ws.data.sessionId, sockets = new Set());
		sockets.add(ws);
		return true;
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
