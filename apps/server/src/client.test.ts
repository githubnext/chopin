/**
 * One origin, in both modes.
 *
 * The browser reaches the socket and the client through the same host and
 * port, whether the client is being served off disk or forwarded to a running
 * Vite. What matters is that `/ws` is never mistaken for a page, and that a
 * deep link into a room still returns the app.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Server, Subprocess } from "bun";

const SERVER = join(import.meta.dir, "main.ts");

let running: Subprocess[] = [];
let stubs: Array<Server<undefined>> = [];
let dirs: string[] = [];

afterEach(async () => {
	for (let server of running) server.kill();
	running = [];
	for (let stub of stubs) stub.stop(true);
	stubs = [];
	for (let dir of dirs) await rm(dir, { recursive: true, force: true });
	dirs = [];
});

function scratch(): string {
	let dir = join(tmpdir(), `chopin-client-${crypto.randomUUID().slice(0, 8)}`);
	dirs.push(dir);
	return dir;
}

async function start(port: number, env: Record<string, string>): Promise<void> {
	running.push(Bun.spawn(["bun", SERVER], {
		env: {
			...process.env,
			PORT: String(port),
			SERVER_HOST: "127.0.0.1",
			AGENT: "off",
			AUTH_DRIVER: "off",
			STORAGE_DRIVER: "legacy",
			DATA_DIR: scratch(),
			...env,
		},
		stdout: "ignore",
		stderr: "inherit",
	}));

	for (let i = 0; i < 200; i++) {
		try {
			await fetch(`http://127.0.0.1:${port}/`);
			return;
		} catch {
			await Bun.sleep(20);
		}
	}
	throw new Error("server did not start");
}

/** Stands in for Vite: echoes back what it was asked for. */
function stub(): string {
	let server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			let url = new URL(req.url);
			return new Response(`stub:${url.pathname}${url.search}`, {
				headers: {
					"content-type": "text/plain",
					"x-received-authorization": req.headers.get("authorization") ?? "",
					"x-received-cookie": req.headers.get("cookie") ?? "",
					"x-received-host": req.headers.get("host") ?? "",
					"x-stub": "yes",
				},
			});
		},
	});
	stubs.push(server);
	return `http://127.0.0.1:${server.port}`;
}

async function upgrades(port: number): Promise<boolean> {
	let socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=main&as=octocat`);
	let opened = await new Promise<boolean>(resolve => {
		let timer = setTimeout(() => resolve(false), 3000);
		socket.addEventListener("open", () => {
			clearTimeout(timer);
			resolve(true);
		});
		socket.addEventListener("close", () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
	socket.close();
	return opened;
}

describe("development", () => {
	it("forwards pages and assets to the dev client", async () => {
		let port = 8940;
		let devClient = stub();
		await start(port, { DEV_CLIENT: devClient });

		let page = await fetch(`http://127.0.0.1:${port}/r/main?as=octocat`, {
			headers: {
				authorization: "Bearer private",
				cookie: "chopin_session=private",
				host: "sandbox--8787.adcproxy.io",
			},
		});
		expect(await page.text()).toBe("stub:/r/main?as=octocat");
		expect(page.headers.get("x-stub")).toBe("yes");
		expect(page.headers.get("x-received-host")).toBe(new URL(devClient).host);
		expect(page.headers.get("x-received-authorization")).toBeNull();
		expect(page.headers.get("x-received-cookie")).toBeNull();

		let asset = await fetch(`http://127.0.0.1:${port}/@fs/some/module.tsx`);
		expect(await asset.text()).toBe("stub:/@fs/some/module.tsx");

		let api = await fetch(`http://127.0.0.1:${port}/api/missing`);
		expect(api.status).toBe(404);
		expect(await api.text()).toBe("API route not found");
		let session = await fetch(`http://127.0.0.1:${port}/api/session`);
		expect(await session.json()).toEqual({ user: null });
	});

	it("keeps the socket for itself", async () => {
		let port = 8941;
		await start(port, { DEV_CLIENT: stub() });

		// The stub would happily answer /ws with a page. It must never see it.
		expect(await upgrades(port)).toBe(true);
	});

	it("says so when the dev client is not up", async () => {
		let port = 8942;
		// A port nothing is listening on.
		await start(port, { DEV_CLIENT: "http://127.0.0.1:9" });

		let response = await fetch(`http://127.0.0.1:${port}/`);
		expect(response.status).toBe(502);
		expect(await response.text()).toContain("Is Vite running?");
	});
});

describe("production", () => {
	it("serves built files, and the app for anything else", async () => {
		let port = 8943;
		let dist = join(import.meta.dir, "../../web/dist");
		await mkdir(dist, { recursive: true });
		let marker = join(dist, "index.html");
		let existing = await Bun.file(marker).exists() ? await Bun.file(marker).text() : undefined;
		await writeFile(marker, "<!doctype html><title>chopin</title>");

		try {
			await start(port, {});

			let asset = await fetch(`http://127.0.0.1:${port}/index.html`);
			expect(await asset.text()).toContain("chopin");

			// A room is not a file, and must still return the app.
			let deep = await fetch(`http://127.0.0.1:${port}/r/some-room`);
			expect(await deep.text()).toContain("chopin");

			expect(await upgrades(port)).toBe(true);
		} finally {
			if (existing !== undefined) await writeFile(marker, existing);
		}
	});
});
