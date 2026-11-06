import { afterEach, expect, it } from "bun:test";
import { connectAgent } from "@chopin/agent-link/client";
import { AGENT_SUBPROTOCOL } from "@chopin/agent-link";

import { resumeAfterRestart } from "./agent-link";

import type { ServerWebSocket } from "bun";

let stops: Array<() => unknown> = [];
afterEach(async () => {
	for (let stop of stops.splice(0)) await stop();
});

/**
 * A server that attaches every link with both features and refuses each `resume` the way a
 * restarted one does before the owner's login is back, until it has refused `refusals` of them.
 */
function restartedServer(refusals: { retry: number; final?: boolean }) {
	let sockets = new Set<ServerWebSocket<unknown>>();
	let resumes: number[] = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, self) {
			return self.upgrade(request, {
					data: undefined,
					headers: { "sec-websocket-protocol": AGENT_SUBPROTOCOL },
				})
				? undefined
				: new Response("no", { status: 400 });
		},
		websocket: {
			open(ws) {
				sockets.add(ws);
			},
			message(ws, raw) {
				let message = JSON.parse(String(raw));
				if (message.type === "attach") {
					ws.send(JSON.stringify({
						type: "attached",
						version: 1,
						document: { id: "d", title: "T", repository: "o/r" },
						features: ["resumable-sessions", "restart-notice"],
					}));
				} else if (message.type === "resume") {
					resumes.push(Date.now());
					if (refusals.final) {
						ws.send(JSON.stringify({ type: "refused", code: "planner-attached", message: "no" }));
						ws.close(4409, "refused");
					} else if (resumes.length <= refusals.retry) {
						ws.send(JSON.stringify({
							type: "refused",
							code: "unavailable",
							message: "The sign-in has not come back.",
							retry: true,
						}));
						ws.close(1011, "refused");
					} else {
						ws.send(JSON.stringify({ type: "resumed", sessions: message.sessions }));
					}
				}
			},
		},
	});
	stops.push(() => server.stop(true));
	return {
		url: `http://127.0.0.1:${server.port}`,
		resumes,
		/** Closes the first link as a restarting server does, after saying when it expects to be back. */
		restart(reconnectWithinMs: number) {
			for (let ws of sockets) {
				ws.send(JSON.stringify({ type: "restarting", reconnectWithinMs }));
				ws.close(1012, "server restarting");
			}
			sockets.clear();
		},
	};
}

async function firstLink(url: string) {
	let handlers = { turn() {} };
	let attaching = connectAgent({ url, token: "t", document: "d", handlers });
	// The first link resumes with nothing held, which the server answers like any other.
	let client = await attaching;
	return { client, handlers };
}

it("connects again at once, retries a refused resume every 250 ms within the announced window, and then resumes", async () => {
	let server = restartedServer({ retry: 0 });
	let { client, handlers } = await firstLink(server.url);
	server.restart(1_000);
	let refusing = restartedServer({ retry: 3 });
	let { client: next, attempts } = await resumeAfterRestart(client, {
		url: refusing.url,
		document: "d",
		handlers,
	});
	stops.push(() => next.detach());
	let gaps = refusing.resumes.slice(1).map((at, index) => at - refusing.resumes[index]!);
	expect(attempts).toBe(4);
	expect(gaps).toHaveLength(3);
	for (let gap of gaps) {
		expect(gap).toBeGreaterThanOrEqual(240);
		expect(gap).toBeLessThan(450);
	}
	expect(next.document.id).toBe("d");
});

it("goes on its own backoff once the announced window has passed, instead of every 250 ms", async () => {
	let server = restartedServer({ retry: 0 });
	let { client, handlers } = await firstLink(server.url);
	server.restart(300);
	let refusing = restartedServer({ retry: 3 });
	let outcome = await resumeAfterRestart(client, {
		url: refusing.url,
		document: "d",
		handlers,
		fallbackMs: 700,
	});
	stops.push(() => outcome.client.detach());
	let gaps = refusing.resumes.slice(1).map((at, index) => at - refusing.resumes[index]!);
	expect(gaps[0]).toBeLessThan(450);
	expect(gaps.at(-1)).toBeGreaterThanOrEqual(650);
});

it("stops at a refusal that is a decision", async () => {
	let server = restartedServer({ retry: 0 });
	let { client, handlers } = await firstLink(server.url);
	server.restart(5_000);
	let refusing = restartedServer({ retry: 0, final: true });
	await expect(
		resumeAfterRestart(client, { url: refusing.url, document: "d", handlers }),
	).rejects.toMatchObject({ code: "planner-attached" });
	expect(refusing.resumes).toHaveLength(1);
});
