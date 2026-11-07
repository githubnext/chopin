/**
 * What the run asks of the server while it is deployed: people typing into documents, the owner's
 * Planner requests of every kind, an agent's MCP calls, and a machine's Planner backends, each as
 * the real client does it over the proxy. Every one keeps the figures the report is made of.
 */
import { SQL } from "bun";

import { createChannel, registerTestDatabase, seedChannel } from "../../e2e/database";
import { bearerOf, Calls, signIn } from "./session";
import { EditorClient } from "./client";
import { pairMachine, pollPlanners, startBackend } from "./planner";

import type { Prompt, Request, Row } from "./analysis";
import type { Backend, Machine } from "./planner";
import type { Environment } from "./environment";

export const OWNER = "mona";
const MACHINE = "studio";
const ANCHOR = "Anchor sentence for the comments.";

export type Document = { id: string; index: number; editors: EditorClient[]; owner: EditorClient };

/** Documents of the run's repository, each with a paragraph per editor and one to comment on. */
export async function seedDocuments(
	env: Environment,
	options: { documents: number; editors: number; typeMs: number; jitterMs?: number },
): Promise<Document[]> {
	registerTestDatabase(env.port, env.database);
	let cookies = new Map<string, string>();
	let session = async (handle: string) => {
		if (!cookies.has(handle)) cookies.set(handle, await signIn(env.origin, handle));
		return cookies.get(handle)!;
	};
	await session(OWNER);
	let documents: Document[] = [];
	for (let index = 0; index < options.documents; index++) {
		let id = crypto.randomUUID();
		let members = Array.from({ length: options.editors }, (_, k) => k).filter(k =>
			k % options.documents === index
		);
		let source = `# Load ${index}\n\n${ANCHOR}\n\n${members.map(k => `ed${k}`).join("\n\n")}\n`;
		await createChannel(env.port, id);
		await seedChannel(env.port, id, source);
		documents.push({ id, index, editors: [], owner: undefined as unknown as EditorClient });
		let sql = new SQL(env.database);
		try {
			await sql`UPDATE channels SET created_by = (SELECT id FROM users WHERE login = ${OWNER}) WHERE id = ${id}`;
		} finally {
			await sql.close();
		}
		for (let [position, k] of members.entries()) {
			let handle = position === 0 ? OWNER : `person${k}`;
			let client = new EditorClient({
				origin: env.origin,
				cookie: await session(handle),
				document: id,
				marker: `ed${k}`,
				typeMs: options.typeMs,
				jitterMs: options.jitterMs,
			});
			documents.at(-1)!.editors.push(client);
			if (position === 0) documents.at(-1)!.owner = client;
		}
	}
	return documents;
}

/** Opens every document and starts typing, spreading the opens so the first connects are not a surge. */
export async function startEditors(documents: Document[]): Promise<void> {
	let clients = documents.flatMap(document => document.editors);
	await Promise.all(clients.map(async (client, index) => {
		await Bun.sleep(index * 15);
		await client.start();
		client.typeContinuously();
	}));
}

export type Planners = {
	machine: Machine;
	backends: Backend[];
	connector: ReturnType<typeof pollPlanners>;
	calls: Calls;
	stop(): Promise<void>;
};

/** The owner's machine, paired and connected, and a backend attached for each document. */
export async function startPlanners(
	env: Environment,
	documents: Document[],
	turnMs: number,
): Promise<Planners> {
	let calls = new Calls();
	let cookie = await signIn(env.origin, OWNER);
	let machine = await pairMachine(env.origin, cookie, OWNER, MACHINE, calls);
	let asked = 0;
	for (let attempt = 0; attempt < 20 && asked < documents.length; attempt++) {
		asked = (await machine.poll([])).planners?.length ?? 0;
		if (asked < documents.length) await Bun.sleep(250);
	}
	if (asked !== documents.length) {
		throw new Error(`the machine is asked for ${asked} Planners, not ${documents.length}`);
	}
	let backends: Backend[] = [];
	for (let document of documents) {
		let token = await machine.credential(document.id);
		if (!token) throw new Error(`no credential for ${document.id}`);
		backends.push(await startBackend(env.origin, token, document.id, { turnMs }));
	}
	let connector = pollPlanners(machine, () => documents.map(document => document.id));
	return {
		machine,
		backends,
		connector,
		calls,
		stop: async () => {
			await connector.stop();
			for (let backend of backends) await backend.detach();
		},
	};
}

/** One agent's MCP session, which every call of must still work after any number of deploys. */
export class McpClient {
	calls = 0;
	failures: Array<{ what: string; at: number; detail: string }> = [];
	#session: string | undefined;

	constructor(private readonly origin: string, private readonly handle: string) {}

	async #post(
		body: unknown,
	): Promise<
		{
			status?: number;
			json?: { result?: { isError?: boolean; content?: Array<{ text: string }> }; error?: unknown };
		}
	> {
		try {
			let response = await fetch(`${this.origin}/mcp`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${bearerOf(this.handle)}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					...(this.#session ? { "mcp-session-id": this.#session } : {}),
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(30_000),
			});
			if (!this.#session) this.#session = response.headers.get("mcp-session-id") ?? undefined;
			return {
				status: response.status,
				json: await response.json().catch(() => undefined) as never,
			};
		} catch {
			return {};
		}
	}

	/** A call; true if it was answered and did not say it failed. */
	async call(what: string, method: string, params: unknown): Promise<boolean> {
		this.calls++;
		let answer = await this.#post({ jsonrpc: "2.0", id: this.calls, method, params });
		let ok = answer.status === 200 && !answer.json?.error && !answer.json?.result?.isError;
		if (!ok) {
			this.failures.push({
				what,
				at: performance.now(),
				detail: `${answer.status ?? "no answer"} ${
					JSON.stringify(answer.json ?? {}).slice(0, 200)
				}`,
			});
		}
		return ok;
	}

	async initialize(): Promise<void> {
		await this.call("initialize", "initialize", {
			clientInfo: { name: "Load run", version: "1.0.0" },
		});
		if (!this.#session) throw new Error("the server gave no MCP session");
	}

	/** A Planner request through the session, as an agent makes it. */
	async invoke(document: string, tag: string, system: boolean): Promise<Request> {
		let record: Request = {
			kind: system ? "system" : "invoke",
			document,
			tag,
			acknowledged: false,
			retries: 0,
			sentAt: performance.now(),
		};
		let ok = await this.call(system ? "invoke_planner (system)" : "invoke_planner", "tools/call", {
			name: "invoke_planner",
			arguments: {
				id: document,
				instruction: `[${tag}] ${system ? "follow up on" : "please look at"} this`,
				...(system ? { as: "system" } : {}),
			},
		});
		record.acknowledged = ok;
		record.ackedAt = performance.now();
		if (!ok) record.refusal = this.failures.at(-1)?.detail;
		return record;
	}

	/** Reads documents in turn every `everyMs` until stopped. */
	read(documents: string[], everyMs: number): { stop(): Promise<void> } {
		let state = { on: true };
		let loop = (async () => {
			for (let count = 0; state.on; count++) {
				await this.call("read_document", "tools/call", {
					name: "read_document",
					arguments: { id: documents[count % documents.length] },
				});
				await Bun.sleep(everyMs);
			}
		})();
		return {
			stop: async () => {
				state.on = false;
				await loop;
			},
		};
	}
}

/** The Planner requests of every kind, made by the owner, as they are made in a deploy's way. */
export class Requests {
	readonly all: Request[] = [];
	readonly #pending: Promise<unknown>[] = [];
	#counter = 0;

	constructor(private readonly mcp: McpClient) {}

	tag(): string {
		return `x${this.#counter++}`;
	}

	#track(request: Promise<Request>): Promise<Request> {
		let tracked = request.then(record => {
			this.all.push(record);
			return record;
		});
		this.#pending.push(tracked);
		return tracked;
	}

	composer(document: Document, text = "a question"): Promise<Request> {
		let tag = this.tag();
		let requestId = crypto.randomUUID();
		return this.#track(document.owner.request("composer", tag, document.id, async () => ({
			frame: "chat:send",
			payload: { requestId, text: `[${tag}] ${text}`, to: "planner" },
		})));
	}

	comment(document: Document): Promise<Request> {
		let tag = this.tag();
		return this.#track(document.owner.request("comment", tag, document.id, async () => ({
			frame: "comment:start",
			payload: {
				blocks: [1],
				quote: ANCHOR.slice(0, 15),
				offset: 0,
				length: 15,
				text: `[${tag}] can you tighten this`,
				to: "planner",
			},
			saved: () =>
				document.owner.threads.some(thread =>
					thread.notes.some(note => note.text.includes(`[${tag}]`))
				),
		})));
	}

	draft(document: Document): Promise<Request> {
		let requestId = crypto.randomUUID();
		return this.#track(document.owner.request("draft", undefined, document.id, async () => ({
			frame: "implementation:draft",
			payload: { requestId, planRevision: await document.owner.planRevision() },
		})));
	}

	invoke(document: Document, system: boolean): Promise<Request> {
		return this.#track(this.mcp.invoke(document.id, this.tag(), system));
	}

	/** One request of each kind, as a person or an agent would make them during a deploy. */
	everyKind(document: Document): Promise<Request[]> {
		return Promise.all([
			this.composer(document),
			this.comment(document),
			this.draft(document),
			this.invoke(document, false),
			this.invoke(document, true),
		]);
	}

	/** Requests at a steady pace, so a deploy always finds some arriving. */
	steady(documents: Document[], everyMs: number): { stop(): Promise<void> } {
		let state = { on: true };
		let loop = (async () => {
			for (let count = 0; state.on; count++) {
				let document = documents[count % documents.length]!;
				let kind = count % 3;
				if (kind === 0) void this.composer(document);
				else if (kind === 1) void this.comment(document);
				else void this.invoke(document, false);
				await Bun.sleep(everyMs);
			}
		})();
		return {
			stop: async () => {
				state.on = false;
				await loop;
			},
		};
	}

	async settled(): Promise<void> {
		while (this.#pending.length > 0) await Promise.all(this.#pending.splice(0));
	}
}

/** The saved Planner requests of every document, as they ended. */
export async function readRows(database: string): Promise<Row[]> {
	let sql = new SQL(database);
	try {
		return (await sql<{ document: string; kind: string; state: string }[]>`
			SELECT document_id AS document, kind, state FROM planner_deferred_turns ORDER BY created_at, seq
		`);
	} finally {
		await sql.close();
	}
}

/** The stored source of each document: what was written, not what a client holds. */
export async function readSources(
	database: string,
	documents: string[],
): Promise<Map<string, string>> {
	let sql = new SQL(database);
	try {
		let rows = await sql<{ channel_id: string; source: string }[]>`
			SELECT channel_id, source FROM channel_snapshots WHERE channel_id IN ${sql(documents)}
		`;
		return new Map(rows.map(row => [row.channel_id, row.source]));
	} finally {
		await sql.close();
	}
}

export const promptsOf = (backends: Backend[]): Prompt[] =>
	backends.flatMap(backend => backend.prompts);
