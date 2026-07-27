/**
 * What the connection says about itself.
 *
 * The failure this guards against was visible but silent: the header reported
 * a connection that had been thrown away, while a live socket sat behind it.
 * Status is the only account a user gets of why the editor will not accept
 * typing, so it being wrong is worse than it being absent.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { Wire } from "./wire";

import type { Server } from "bun";
import type { Status } from "./wire";

let servers: Array<Server<undefined>> = [];
let wires: Wire[] = [];

afterEach(() => {
	for (let wire of wires) wire.dispose();
	wires = [];
	for (let server of servers) server.stop(true);
	servers = [];
});

/** A socket endpoint that accepts anything, or refuses everything. */
function endpoint(accept: boolean): number {
	let server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, self) {
			if (!accept) return new Response("nope", { status: 403 });
			return self.upgrade(req) ? undefined : new Response("no", { status: 400 });
		},
		websocket: { message() {} },
	});
	servers.push(server);
	return server.port!;
}

function connect(port: number, seen: Status[]): Wire {
	// `location` is what the client derives its URL from, and there is none in
	// a test runtime.
	globalThis.location = { href: `http://127.0.0.1:${port}/`, protocol: "http:" } as Location;
	let wire = new Wire({
		room: "main",
		handle: "octocat",
		onStatus: status => seen.push(status),
	});
	wires.push(wire);
	return wire;
}

async function until(check: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (check()) return;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${label}`);
}

describe("status", () => {
	it("announces itself on construction", async () => {
		let seen: Status[] = [];
		connect(endpoint(true), seen);

		await until(() => seen.includes("connected"), "connected");
		expect(seen[0]).toBe("connecting");
	});

	/**
	 * The regression. A discarded instance reports `closed`; a replacement must
	 * overwrite that immediately rather than waiting until it happens to reach
	 * some other state — which, if its socket never opens, is never.
	 */
	it("does not leave a discarded connection's state as the last word", async () => {
		let port = endpoint(true);
		let seen: Status[] = [];

		let first = connect(port, seen);
		await until(() => seen.includes("connected"), "first connected");
		first.dispose();
		expect(seen.at(-1)).toBe("closed");

		connect(port, seen);
		// Before the replacement can possibly have opened.
		expect(seen.at(-1)).toBe("connecting");
	});

	it("reports why a refused connection was refused", async () => {
		let seen: Status[] = [];
		let wire = connect(endpoint(false), seen);

		await until(() => wire.status === "denied", "denied");
		expect(seen).toContain("denied");
	});

	it("rejects a pending request when the connection goes away", async () => {
		let port = endpoint(true);
		let seen: Status[] = [];
		let wire = connect(port, seen);
		await until(() => seen.includes("connected"), "connected");

		let pending = wire.ask("session:ping");
		wire.dispose();

		await expect(pending).rejects.toThrow();
	});
});
