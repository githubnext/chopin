import { SERVICE_RESTART } from "@chopin/protocol/restart";

import { tell } from "../wire";

import type { ServerWebSocket } from "bun";

type Listener = { stop(closeActiveConnections?: boolean): Promise<void> };

/** What a server end of an agent link does when the server restarts. */
export type AgentLinkRestart = { restart(reconnectWithinMs: number): void };

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

	/**
	 * Tell every open socket that it is about to close because the server is restarting, and that a
	 * new process is expected within `reconnectWithinMs`. A client that hears it treats whatever
	 * close follows as a restart; an older one ignores the frame.
	 *
	 * An agent link speaks its own protocol, so `agentLink` names the link a socket carries, if it
	 * is one: that link tells its client and closes itself. Any other socket is sent the frame.
	 */
	announceRestart(
		reconnectWithinMs: number,
		agentLink: (ws: ServerWebSocket<unknown>) => AgentLinkRestart | undefined = () => undefined,
	): void {
		for (let ws of this.#open) {
			let link = agentLink(ws);
			if (link) link.restart(reconnectWithinMs);
			else tell(ws, { kind: "session:restarting", ts: 0, reconnectWithinMs });
		}
	}

	/** Stop accepting connections, close every open socket with 1012, then drop what is left. */
	async stopForRestart(server: Listener): Promise<void> {
		let stopping = server.stop();
		for (let ws of this.#open) ws.close(SERVICE_RESTART, "server restarting");
		await server.stop(true);
		await stopping;
	}
}
