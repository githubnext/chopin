/**
 * The dev stack, started from a script rather than from a terminal.
 *
 * Two things need this: reading the console a development build writes, and
 * photographing the shell. Neither can use `bun run e2e`, which serves
 * `apps/web/dist` — a production bundle has no React invariants left in it to
 * read, and rebuilding it is a long way round for a screenshot. Both therefore
 * want what `scripts/dev.ts` gives a person, in-process and on a port nobody
 * chose, and they wanted it identically enough that it lived twice.
 *
 * Ports are taken from the OS so this can run beside a dev server already
 * holding 5173. That means overriding `server.hmr.clientPort` too: the client
 * is told at build time where to reach HMR, and left at the config's default it
 * would spend the run reporting a socket it cannot open — in the console one of
 * these two callers exists to read.
 */

import { dirname, join } from "node:path";

import type { Subprocess } from "bun";
import type { ViteDevServer } from "vite";

const ROOT = dirname(import.meta.dir);
const WEB = join(ROOT, "apps/web");
const HOST = "127.0.0.1";

const READY_MS = 60_000;

export type Stack = {
	/** Where both halves answer. */
	base: string;
	/** Take both down. Safe to call whether or not either came up. */
	stop(): Promise<void>;
};

export type StackOptions = {
	/** `DATA_DIR`: where rooms are read from and written to. */
	data: string;
	/** Anything else the server should see, `DEV_QUESTIONS` being the usual one. */
	env?: Record<string, string>;
};

/** A port the OS has just confirmed is free. */
function free(): number {
	let socket = Bun.listen({ hostname: HOST, port: 0, socket: { data() {} } });
	let port = socket.port;
	socket.stop(true);
	return port;
}

async function reachable(url: string): Promise<void> {
	let deadline = Date.now() + READY_MS;
	while (Date.now() < deadline) {
		try {
			let response = await fetch(url, { redirect: "manual" });
			await response.body?.cancel();
			if (response.ok) return;
		} catch {}
		await Bun.sleep(250);
	}
	throw new Error(`chopin: ${url} never answered`);
}

export async function start({ data, env = {} }: StackOptions): Promise<Stack> {
	let vite: ViteDevServer | undefined;
	let server: Subprocess | undefined;

	let stop = async (): Promise<void> => {
		// Its own process group, killed as a group, for the reason `scripts/dev.ts`
		// gives at length: the leader alone leaves esbuild behind holding a port.
		if (server) {
			try {
				process.kill(-server.pid, "SIGTERM");
			} catch {}
		}
		await vite?.close();
	};

	try {
		let webPort = free();
		let appPort = free();

		// Resolved from `apps/web`, which is the only place it is installed —
		// nothing hoists it to the root, and this file lives above both.
		let { createServer } = await import(Bun.resolveSync("vite", WEB)) as typeof import("vite");

		vite = await createServer({
			root: WEB,
			configFile: join(WEB, "vite.config.ts"),
			server: { host: HOST, port: webPort, strictPort: true, hmr: { clientPort: webPort } },
		});
		await vite.listen();

		server = Bun.spawn(["bun", "src/main.ts"], {
			cwd: join(ROOT, "apps/server"),
			env: {
				...process.env,
				PORT: String(appPort),
				SERVER_HOST: HOST,
				AGENT: "off",
				DATA_DIR: data,
				DEV_QUESTIONS: "",
				DEV_COMMENTS: "",
				DEV_CLIENT: `http://${HOST}:${webPort}`,
				...env,
			},
			stdio: ["inherit", "ignore", "inherit"],
			detached: true,
		});

		let base = `http://${HOST}:${appPort}`;
		// The server 502s until Vite is up, so a reply means both halves are ready.
		await reachable(base);

		return { base, stop };
	} catch (error) {
		// Half a stack is worse than none: whichever half came up is holding a
		// port, and the caller has no handle to take it down with.
		await stop();
		throw error;
	}
}
