/**
 * A paired machine and the Planner backends it runs, as `chopin connect` does it but scripted: the
 * machine is paired with a key, polls for the Planners Chopin asks it to run and opens its
 * connection again when a new process does not know it; each backend attaches one document over
 * the agent link with a credential Chopin issued, answers each message once in the words
 * `Reply <tag>`, and after a restart does what `docs/agent-connection.md` asks of a backend:
 * connects again at once and retries a `resume` the server refuses with `retry`.
 */
import { connectAgent } from "../../packages/agent-link/src/client";
import {
	CONNECTOR_PLANNER_COMMAND_HEADER,
	CONNECTOR_PLATFORM_HEADER,
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_VERSION_HEADER,
} from "../../packages/protocol/connector";
import { CONNECTOR_PROTOCOL } from "../../apps/connector/src/version";
import { finishTurn, resumeAfterRestart } from "../../apps/server/src/testing/agent-link";
import { RELEASE } from "../../e2e/release";
import { Calls } from "./session";

import type { AgentClient, AgentHandlers, TurnContext } from "../../packages/agent-link/src/client";
import type { Prompt } from "./analysis";

const CHECKOUT = { repository: "octo-org/score", commit: "a".repeat(40) };

export type Machine = {
	credential(document: string): Promise<string | undefined>;
	reconnect(): Promise<void>;
	poll(planners: string[]): Promise<{ kind?: string; planners?: Array<{ id: string }> }>;
	disconnect(): Promise<unknown>;
};

/**
 * A pairing key for the person who owns `cookie`'s session, as the machines page mints one after
 * the machine is authorized with GitHub, which the fake GitHub returns from at once.
 */
export async function mintPairingKey(
	origin: string,
	cookie: string,
	handle: string,
): Promise<string> {
	let started = await fetch(`${origin}/auth/github/connector?key`, {
		headers: { cookie },
		redirect: "manual",
	});
	let authorize = new URL(started.headers.get("location")!);
	let back = new URL(authorize.searchParams.get("redirect_uri")!);
	back.searchParams.set("code", `e2e-${handle}`);
	back.searchParams.set("state", authorize.searchParams.get("state")!);
	let jar = [
		cookie,
		...(started.headers as Headers & { getSetCookie(): string[] }).getSetCookie().map(value =>
			value.split(";", 1)[0]!
		),
	].join("; ");
	let callback = await fetch(back, { headers: { cookie: jar }, redirect: "manual" });
	if (callback.status !== 302 && callback.status !== 303) {
		throw new Error(`authorizing the machine failed: ${callback.status}`);
	}
	let known = new Map(jar.split("; ").map(pair => pair.split(/=(.*)/s, 2) as [string, string]));
	for (let value of (callback.headers as Headers & { getSetCookie(): string[] }).getSetCookie()) {
		let [name, content] = value.split(";", 1)[0]!.split(/=(.*)/s, 2);
		known.set(name!, content!);
	}
	let session = [...known].map(([name, content]) => `${name}=${content}`).join("; ");
	let minted = await fetch(`${origin}/api/connector/pairing-keys`, {
		method: "POST",
		headers: { cookie: session, origin, "content-type": "application/json" },
		body: "{}",
	});
	if (!minted.ok) throw new Error(`no pairing key: ${minted.status} ${await minted.text()}`);
	return ((await minted.json()) as { key: string }).key;
}

/**
 * Pairs a machine for the person who owns `cookie`'s session, through the pairing key the machines
 * page mints, and connects it. `calls` tallies every request to the connector API.
 */
export async function pairMachine(
	origin: string,
	cookie: string,
	handle: string,
	label: string,
	calls: Calls,
): Promise<Machine> {
	let key = await mintPairingKey(origin, cookie, handle);
	let post = (
		what: string,
		path: string,
		body: unknown,
		extra: Record<string, string> = {},
		expected: number[] = [],
	) =>
		calls.fetch(what, new URL(path, origin).href, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL),
				[CONNECTOR_VERSION_HEADER]: RELEASE,
				...extra,
			},
			body: JSON.stringify(body),
		}, expected);
	let paired = await (await post("pair", "/api/connector/pairings", { ...CHECKOUT, label, key }))
		?.json() as { token: string };
	let token = "";
	let open = async () => {
		let opened = await post("connect", "/api/connector/connections", { ...CHECKOUT, label }, {
			[CONNECTOR_PLATFORM_HEADER]: "linux x64",
			[CONNECTOR_PLANNER_COMMAND_HEADER]: "1",
			authorization: `Bearer ${paired.token}`,
		});
		if (!opened?.ok) throw new Error(`could not connect the machine: ${opened?.status}`);
		token = ((await opened.json()) as { token: string }).token;
	};
	await open();
	return {
		reconnect: open,
		credential: async document => {
			let issued = await post("planner credential", "/api/connector/planner", { document }, {
				authorization: `Bearer ${paired.token}`,
			});
			if (!issued?.ok) return undefined;
			return ((await issued.json()) as { token: string }).token;
		},
		// A new process does not know the connection, and says so with a 409 the connector opens it again for.
		poll: async planners => {
			let response = await post(
				"planner poll",
				"/connector/mcp",
				{
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "wait_for_work", arguments: { planners } },
				},
				{ authorization: `Bearer ${token}` },
				[409],
			);
			let body = await response?.json() as {
				result?: { isError?: boolean; content: Array<{ text: string }> };
				error?: unknown;
			} | undefined;
			if (!response?.ok || !body || body.error || !body.result || body.result.isError) {
				throw new Error(`the poll was refused: ${response?.status} ${JSON.stringify(body)}`);
			}
			return JSON.parse(body.result.content[0]!.text);
		},
		disconnect: async () =>
			await post("disconnect", "/connector/mcp", {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "disconnect_workspace", arguments: {} },
			}, { authorization: `Bearer ${token}` }),
	};
}

export type Resume = { document: string; attempts: number; at: number };
export type Close = { document: string; code: number; reconnectWithinMs?: number; at: number };

export type Backend = {
	document: string;
	prompts: Prompt[];
	resumes: Resume[];
	closes: Close[];
	errors: string[];
	/** Lets the turns a message asked to hold go on. */
	release(): void;
	detach(): Promise<void>;
};

const TAG = /\[([a-z]\d+)\]/g;

/**
 * A Planner backend for one document. A message that says `hold me` keeps its turn running until
 * `release()`. `turnMs` is how long every other turn takes, as a model takes time to answer.
 */
export async function startBackend(
	origin: string,
	token: string,
	document: string,
	options: { turnMs: number },
): Promise<Backend> {
	let prompts: Prompt[] = [];
	let resumes: Resume[] = [];
	let closes: Close[] = [];
	let errors: string[] = [];
	let held = Promise.withResolvers<void>();
	let state = { ended: false };
	let release = () => {
		held.resolve();
		held = Promise.withResolvers<void>();
	};
	let handlers: AgentHandlers = {
		async turn(context: TurnContext) {
			let prompt = context.message.prompt;
			if (prompt.startsWith("[Background job")) {
				context.emit({ type: "stream-start", modelId: "scripted" });
				return finishTurn(context);
			}
			let tag = [...prompt.matchAll(TAG)].at(-1)?.[1];
			prompts.push({ document, tag });
			if (prompt.includes("hold me")) {
				let gate = held.promise;
				let aborted = new Promise<void>(resolve =>
					context.signal.addEventListener("abort", () => resolve(), { once: true })
				);
				await Promise.race([gate, aborted]);
				if (context.signal.aborted) return context.end("aborted");
			} else {
				await Bun.sleep(options.turnMs);
			}
			context.emit({ type: "stream-start", modelId: "scripted" });
			let thread = /using thread (\S+?)\./.exec(prompt)?.[1];
			if (thread) {
				await context.callHostTool("reply_comment", { thread, text: `Reply ${tag}` });
			} else {
				let id = `reply-${tag ?? "?"}`;
				context.emit({ type: "text-start", id });
				context.emit({ type: "text-delta", id, delta: `Reply ${tag ?? "?"}` });
				context.emit({ type: "text-end", id });
			}
			finishTurn(context);
		},
	};
	let client: AgentClient = await connectAgent({ url: origin, token, document, handlers });
	let watching = (async () => {
		while (!state.ended) {
			let previous = client;
			let closed = await previous.closed;
			if (state.ended) return;
			closes.push({
				document,
				code: closed.code,
				reconnectWithinMs: closed.reconnectWithinMs,
				at: performance.now(),
			});
			try {
				let resumed = await resumeAfterRestart(previous, {
					url: origin,
					document,
					handlers,
					token,
				});
				client = resumed.client;
				resumes.push({ document, attempts: resumed.attempts, at: performance.now() });
			} catch (error) {
				if (!state.ended) errors.push(`${document}: ${String(error)}`);
				return;
			}
		}
	})();
	return {
		document,
		prompts,
		resumes,
		closes,
		errors,
		release,
		async detach() {
			state.ended = true;
			held.resolve();
			await client.detach().catch(() => {});
			await Promise.race([watching, Bun.sleep(200)]);
		},
	};
}

/**
 * The connector's poll beside its backends, as `apps/connector/src/planner.ts` does it: poll
 * naming the Planners it runs, and open the connection again when the server does not know it. A
 * Planner the server stops asking for is counted, not stopped: a restart must never cause one.
 */
export function pollPlanners(machine: Machine, running: () => string[]) {
	let state = { on: true };
	let reopened = 0;
	let withdrawn: string[] = [];
	let loop = (async () => {
		while (state.on) {
			try {
				let answer = await machine.poll(running());
				if (answer.kind === "planners" && Array.isArray(answer.planners)) {
					let wanted = new Set(answer.planners.map(value => value.id));
					for (let id of running()) {
						if (!wanted.has(id) && !withdrawn.includes(id)) withdrawn.push(id);
					}
				}
			} catch {
				if (!state.on) return;
				for (let attempt = 0; state.on; attempt++) {
					try {
						await machine.reconnect();
						reopened++;
						break;
					} catch {
						await Bun.sleep(250);
					}
				}
			}
		}
	})();
	return {
		get reopened() {
			return reopened;
		},
		withdrawn,
		async stop() {
			state.on = false;
			await machine.disconnect().catch(() => {});
			await Promise.race([loop, Bun.sleep(300)]);
		},
	};
}
