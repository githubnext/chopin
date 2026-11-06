import { SERVICE_RESTART } from "@chopin/protocol/restart";

import type { ServerWebSocket } from "bun";

type Listener = { stop(closeActiveConnections?: boolean): Promise<void> };

/**
 * Every socket the server has open, so that stopping can end each with the code that says why.
 *
 * `server.stop(true)` closes every socket with 1001, "going away", which a browser cannot tell
 * from a server it lost for good. A restart is closed with 1012 first.
 */
export class OpenSockets {
	readonly #open = new Set<ServerWebSocket<unknown>>();

	opened(ws: ServerWebSocket<unknown>): void {
		this.#open.add(ws);
	}

	closed(ws: ServerWebSocket<unknown>): void {
		this.#open.delete(ws);
	}

	/** Stop accepting connections, close every open socket with 1012, then drop what is left. */
	async stopForRestart(server: Listener): Promise<void> {
		let stopping = server.stop();
		for (let ws of this.#open) ws.close(SERVICE_RESTART, "server restarting");
		await server.stop(true);
		await stopping;
	}
}
