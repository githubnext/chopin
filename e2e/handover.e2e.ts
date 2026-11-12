/**
 * A deploy nobody can see: a real hand-over of the writer lease from one process to another under
 * an open tab. Server A holds the lease and serves; server B, started beside it, waits in standby
 * and takes the lease the moment A lets go, with a proxy in front that holds requests while
 * neither is ready (docs/zero-downtime-deploys.md). A document's Planner is a paired machine's
 * backend, attached through the proxy; a person types, drafts and talks to it throughout. Nothing
 * may be shown, lost, doubled or reloaded, and the gap from the release to the first request
 * served again is measured against the design's budget.
 *
 * The proxy is `e2e/holding-proxy.ts`, which does what the reference Caddyfile does, because CI
 * cannot be assumed to have Caddy or a container to run it in. `CHOPIN_E2E_PROXY=caddy` runs the
 * reference proxy in a container on the host's network instead (Linux, needs the Docker image).
 */
import { spawn } from "node:child_process";

import { SQL } from "bun";

import { connectAgent } from "../packages/agent-link/src/client";
import {
	CONNECTOR_PLANNER_COMMAND_HEADER,
	CONNECTOR_PLATFORM_HEADER,
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_VERSION_HEADER,
} from "../packages/protocol/connector";
import { CONNECTOR_PROTOCOL } from "../apps/connector/src/version";
import { finishTurn, resumeAfterRestart } from "../apps/server/src/testing/agent-link";
import {
	BUDGET_MS,
	GRACE_MS,
	measureHandover,
	Probe,
	startProxy,
	watchLease,
} from "../scripts/overlap";
import { backgroundBrowser } from "./background-browser";
import { reconnectGaps, reconnectProblems } from "./reconnect-gaps";
import { chatInput, expectChatValue, fillChat } from "./chat-input";
import { createChannel, readSource, registerTestDatabase, seedChannel } from "./database";
import { startHoldingProxy } from "./holding-proxy";
import { expectPlannerAttached, machineButton, strip } from "./planner-status";
import { RELEASE } from "./release";
import { authenticate, content, expect, ready, roomPath, status, test } from "./room";
import { e2eDatabaseName, e2ePort } from "./ports";
import { HOST, ROOT } from "./servers";

import type { Locator, Page } from "@playwright/test";
import type { AgentHandlers, TurnContext } from "../packages/agent-link/src/client";
import type { Slot } from "./holding-proxy";
import type { SocketEvent } from "./reconnect-gaps";

const PROXY_PORT = e2ePort(8801);
const SLOT_PORTS: Record<Slot, number> = { a: e2ePort(8802), b: e2ePort(8803) };
const ORIGIN = `http://${HOST}:${PROXY_PORT}`;
const DATABASE = e2eDatabaseName("chopin_handover");
const HANDLE = "mona";
const MACHINE = "studio";
/** What the server is told a window for a Planner coming back is; the design proposes 10 s. */
const WINDOW_MS = 10_000;
const CADDY = process.env.CHOPIN_E2E_PROXY === "caddy";

function databaseUrls() {
	let cluster = new URL(
		process.env.E2E_DATABASE_URL_3
			|| "postgresql://chopin:chopin@127.0.0.1:5436/chopin?sslmode=disable",
	);
	let own = new URL(cluster);
	own.pathname = `/${DATABASE}`;
	return { cluster: cluster.href, own: own.href };
}

async function freshDatabase(): Promise<string> {
	let { cluster, own } = databaseUrls();
	let admin = new SQL(cluster);
	try {
		await admin.unsafe(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
		await admin.unsafe(`CREATE DATABASE ${DATABASE}`);
	} finally {
		await admin.close();
	}
	return own;
}

const ENV = {
	SERVER_HOST: HOST,
	APP_ORIGIN: ORIGIN,
	STORAGE_DRIVER: "postgres",
	JEV_API_KEY: "e2e-jev-only",
	GITHUB_APP_SLUG: "chopin-e2e",
	GITHUB_APP_CLIENT_ID: "e2e",
	GITHUB_APP_CLIENT_SECRET: "e2e",
	GITHUB_ALLOWED_USERS: "",
	GITHUB_ALLOWED_ORGANIZATIONS: "githubnext",
	SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY!,
	AGENT: "on",
	HARNESS: "remote",
	DECISIONS_MODEL: "typesafe/jev-latest",
	BACKGROUND_JOBS: "off",
	WEB_RESEARCH: "off",
	CONVERSATION_PLAN: "off",
	DEV_QUESTIONS: "",
	DEV_COMMENTS: "",
	HANDOVER: "wait",
	HANDOVER_UNREADY_MS: "300",
	HANDOVER_PLANNER_WINDOW_MS: String(WINDOW_MS),
	// Time enough for a test to send what it sends during the wait, however slow the machine.
	HANDOVER_TURN_WAIT_MS: "30000",
};

type Running = { child: ReturnType<typeof spawn>; log: { text: string }; slot: Slot };

let processes: Running[] = [];
let proxies: Array<{ stop(): Promise<void> }> = [];
let closers: Array<() => Promise<void>> = [];

// One disposable database and set of ports, so the tests take turns.
test.describe.configure({ mode: "default" });

test.afterEach(async () => {
	for (let close of closers.splice(0).toReversed()) await close().catch(() => {});
	for (let running of processes.splice(0)) await stop(running);
	for (let proxy of proxies.splice(0)) await proxy.stop().catch(() => {});
});

/** SIGTERM, as a deploy sends it; resolves with the exit code once the process has gone. */
function signal(running: Running): Promise<number | null> {
	let { child } = running;
	if (child.exitCode !== null || child.pid === undefined) return Promise.resolve(child.exitCode);
	let exit = new Promise<number | null>(resolve => child.once("close", code => resolve(code)));
	process.kill(-child.pid, "SIGTERM");
	return exit;
}

async function stop(running: Running): Promise<void> {
	await signal(running);
}

async function text(url: string): Promise<[number, string, Headers] | undefined> {
	try {
		let response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
		return [response.status, (await response.text()).trim(), response.headers];
	} catch {
		return undefined;
	}
}

async function until<T>(
	what: string,
	read: () => Promise<T | undefined | false> | T | undefined | false,
	ms = 30_000,
): Promise<T> {
	for (let deadline = Date.now() + ms; Date.now() < deadline; await Bun.sleep(10)) {
		let value = await read();
		if (value) return value;
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function migrate(database: string): Promise<void> {
	let child = Bun.spawn(["bun", "apps/server/src/storage/migrate.ts"], {
		cwd: ROOT,
		env: { ...process.env, ...ENV, PORT: String(SLOT_PORTS.a), DATABASE_URL: database },
		stdout: "ignore",
		stderr: "pipe",
	});
	if (await child.exited !== 0) {
		throw new Error(`migration failed: ${(await new Response(child.stderr).text()).slice(-800)}`);
	}
}

/** Starts one slot's server; the fake GitHub and model answer for the real ones, as in every server here. */
function slotServer(slot: Slot, database: string): Running {
	let child = spawn(process.execPath, [
		"--preload",
		"./e2e/github.ts",
		"--preload",
		"./e2e/jev.ts",
		"apps/server/src/main.ts",
	], {
		cwd: ROOT,
		detached: true,
		env: { ...process.env, ...ENV, PORT: String(SLOT_PORTS[slot]), DATABASE_URL: database },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = { text: "" };
	let read = (chunk: Buffer) => {
		log.text = (log.text + String(chunk)).slice(-40_000);
	};
	child.stdout?.on("data", read);
	child.stderr?.on("data", read);
	let running = { child, log, slot };
	processes.push(running);
	return running;
}

const slotUrl = (slot: Slot, path: string) => `http://${HOST}:${SLOT_PORTS[slot]}${path}`;

/** What a slot says on `live`: `live` while it holds the lease, `standby` while it waits. */
async function live(slot: Slot): Promise<string | undefined> {
	return (await text(slotUrl(slot, "/api/health/live")))?.[1];
}

async function ready_(slot: Slot): Promise<boolean> {
	return (await text(slotUrl(slot, "/api/health/ready")))?.[0] === 200;
}

/** Whether the slot has been told to stop: from SIGTERM on, every answer carries `Connection: close`. */
async function stopping(slot: Slot): Promise<boolean> {
	return (await text(slotUrl(slot, "/api/health/live")))?.[2].get("connection") === "close";
}

type World = {
	database: string;
	room: string;
	page: Page;
	a: Running;
	b: Running;
};

/**
 * What the page says about the connection and the document's machine, sampled in the page every
 * 25 ms while `watching` so nothing can come and go between two assertions, and every frame of the
 * kinds a hand-over could disturb.
 */
type Probe_ = {
	closes: number[];
	/**
	 * What each socket did, by the page's own clock and the kind of socket it is (its path and its
	 * document): every opening, every close with 1012 (the cut's), and every `session:restarting`
	 * and `session:hello` frame. `reconnectGaps` pairs them, per kind, after the fact.
	 */
	sockets: SocketEvent[];
	violations: string[];
	timeline: string[];
	watching: boolean;
	/** The button's name while the Planner is healthy, if this page has a machine button. */
	machine?: string;
	/** What the machine button looked like, each time it changed. */
	machines: string[];
	/** The state of every `session:planner` frame since watching began. */
	planner: string[];
	resets: string[];
	restarting: number[];
	loads: number;
	/** What the page offered when watching began, part by part (`offers`). */
	baseline?: Record<string, string>;
	/** Whether a comment being written is part of what is held to (only where one is open throughout). */
	comments?: boolean;
	/** Whether a change in what is offered is only recorded, not a violation (see `startWatching`). */
	relaxed?: boolean;
	/** Each part of the page that was not as it was, with how it read before and after. */
	changes: string[];
};

async function watch(page: Page): Promise<void> {
	await page.addInitScript(() => {
		let probe: Probe_ = {
			closes: [],
			sockets: [],
			violations: [],
			timeline: [],
			watching: false,
			machines: [],
			planner: [],
			resets: [],
			restarting: [],
			loads: 0,
			changes: [],
		};
		// oxlint-disable-next-line unicorn(consistent-function-scoping) -- The callback executes in the browser realm.
		let at = () => Math.round(performance.now());
		/*
		 * What a person is offered, part by part, as they would read it off the page. A deploy must
		 * leave every part as it was: Build plan, what Chat says before anyone has spoken, what the
		 * composer lets them do, a comment being written and where it goes, and the document's
		 * own lock. The machine and the connection notices are watched separately below.
		 */
		// oxlint-disable-next-line unicorn(consistent-function-scoping) -- The callback executes in the browser realm.
		let offers = (): Record<string, string> => {
			// oxlint-disable-next-line unicorn(consistent-function-scoping) -- The callback executes in the browser realm.
			let words = (element: Element | null | undefined) =>
				element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
			let state = (element: Element) =>
				`${element.getAttribute("aria-label") || words(element)}${
					element.getAttribute("aria-disabled") === "true"
						|| (element as HTMLButtonElement).disabled
						? " (not available)"
						: ""
				}`;
			let composer = document.querySelector(".chat-composer");
			let field = composer?.querySelector("[aria-label='Message']");
			return {
				"Build plan": [
					...document.querySelectorAll(".build-plan, .build-capsule, .build-status-link"),
				].map(state).join(" | ") || "absent",
				"Chat hint": words(document.querySelector("[data-chat-empty]")) || "absent",
				"composer": composer
					? `${field?.getAttribute("aria-disabled") ?? "-"}/${
						field?.hasAttribute("readonly") ? "read-only" : "writable"
					} ${
						[...composer.querySelectorAll("button")]
							// Send follows what is typed, and Stop and Resume follow whether a turn is running.
							.filter(button =>
								!/^(Send message|Stop generating|Resume chopin)$/.test(
									button.getAttribute("aria-label") ?? "",
								)
							)
							.map(state).join(" | ")
					}`
					: "absent",
				"document": document.querySelector(".plan-content")?.getAttribute("contenteditable")
					?? "absent",
				"comment being written":
					[...document.querySelectorAll(".plan-comment-composer")].map(card =>
						`${
							(card.querySelector(".plan-comment-address-box") as HTMLInputElement | null)?.checked
								? "sent to chopin"
								: "not sent to chopin"
						}: ${(card.querySelector("textarea") as HTMLTextAreaElement | null)?.value ?? ""}`
					).join(" | ") || "none",
			};
		};
		(window as unknown as { probe: Probe_ }).probe = probe;
		(window as unknown as { offers: typeof offers }).offers = offers;
		let Native = window.WebSocket;
		window.WebSocket = class extends Native {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols);
				// A page has several sockets of one path, such as a document's and a child's, and they
				// come back in any order: each is told by the document it is for.
				let address = new URL(String(url), location.href);
				let key = `${address.pathname}?${address.searchParams.get("channel") ?? ""}`;
				this.addEventListener("open", () => {
					probe.timeline.push(`${at()} open`);
					probe.sockets.push({ at: at(), key, kind: "open" });
				});
				this.addEventListener("close", event => {
					probe.closes.push(event.code);
					probe.timeline.push(`${at()} close ${event.code}`);
					if (event.code === 1012) probe.sockets.push({ at: at(), key, kind: "cut" });
				});
				this.addEventListener("message", event => {
					if (typeof event.data !== "string") return;
					// Said before watching begins too: whether a socket greets is known from its first hello.
					let says = event.data.includes('"session:hello"')
						|| event.data.includes('"session:restarting"');
					if (!probe.watching && !says) return;
					try {
						let frame = JSON.parse(event.data) as {
							kind?: string;
							planner?: { state: string };
							reason?: string;
							reconnectWithinMs?: number;
						};
						if (probe.watching && frame.kind === "session:planner") {
							probe.planner.push(frame.planner?.state ?? "?");
							probe.timeline.push(`${at()} planner ${frame.planner?.state}`);
						}
						if (probe.watching && frame.kind === "plan:reset") {
							probe.resets.push(frame.reason ?? "?");
						}
						if (frame.kind === "session:restarting") {
							probe.sockets.push({ at: at(), key, kind: "restarting" });
							if (probe.watching) {
								probe.restarting.push(frame.reconnectWithinMs ?? -1);
								probe.timeline.push(`${at()} restarting`);
							}
						}
						if (frame.kind === "session:hello") {
							probe.sockets.push({ at: at(), key, kind: "hello" });
							if (probe.watching) probe.timeline.push(`${at()} hello`);
						}
					} catch { /* Not a frame of ours. */ }
				});
			}
		} as typeof WebSocket;
		setInterval(() => {
			if (!probe.watching) return;
			let say = (what: string) => {
				if (!probe.violations.includes(what)) {
					probe.violations.push(what);
					probe.timeline.push(`${at()} ${what}`);
				}
			};
			if (probe.baseline) {
				let now = offers();
				for (let [part, before] of Object.entries(probe.baseline)) {
					if (now[part] === before) continue;
					if (part === "comment being written" && !probe.comments) continue;
					let change = `${part} changed from "${before}" to "${now[part]}"`;
					if (!probe.changes.includes(change)) probe.changes.push(change);
					if (!probe.relaxed) say(change);
				}
			}
			let level = document.querySelector(".plan-status")?.getAttribute("data-level");
			if (level && level !== "hidden") say(`status ${level}`);
			let failure = document.querySelector(".composer-notice.motion-feedback, [data-error-banner]")
				?.textContent?.trim();
			if (failure) say(`composer error ${failure}`);
			if (document.querySelector(".plan[data-plan-offline]")) say("locked");
			if (document.querySelector(".plan-content")?.getAttribute("contenteditable") === "false") {
				say("not editable");
			}
			// The room's own connection (socket or sync), not the Planner's layer: the machine's
			// words are reported below, as they were beside the old offline notice.
			if (document.querySelector('[data-connection-banner]:not([data-layer="planner"])')) {
				say("offline notice");
			}
			// One polite region speaks the connection's words and the machine's: told apart here, as
			// they were when two regions spoke them, so each is still held to saying nothing.
			let spoken = document.querySelector("[data-connection-status]")?.textContent?.trim();
			if (spoken) {
				say(
					/^(You're offline|Connecting\u2026|Back online|Catching up|Back\.)/.test(spoken)
						? `offline status ${spoken}`
						: `machine said ${spoken}`,
				);
			}
			// A message that says it could not be sent, whatever the reason.
			if (document.querySelector("[data-chat-failed]")) say("a message says it could not be sent");
			let notice = document.querySelector(".chat-composer .composer-notice")?.textContent?.trim();
			if (notice) say(`composer strip ${notice}`);
			// chopin's row to this person alone, for a message it could not take.
			let note = document.querySelector("[data-quiet-note] .quiet-note-text")?.textContent?.trim();
			if (note) say(`chopin note ${note}`);
			if (document.querySelector("[data-agent-offline]")) say("build says the agent is offline");
			let button = document.querySelector(".machine-button");
			if (button && probe.machine) {
				let dot = button.querySelector(".machine-glyph-dot");
				let look = `${button.getAttribute("aria-label")} | ${
					dot?.getAttribute("data-state") ?? "-"
				}/${dot?.getAttribute("data-planner") ?? "-"}`;
				if (probe.machines.at(-1) !== look) probe.machines.push(look);
				if (
					button.getAttribute("aria-label") !== probe.machine
					|| dot?.getAttribute("data-state") !== "connected"
					|| dot.hasAttribute("data-planner")
					|| button.hasAttribute("data-planner")
				) say(`machine button ${look}`);
			}
		}, 25);
	});
}

function probe(page: Page): Promise<Probe_> {
	return page.evaluate(() => (window as unknown as { probe: Probe_ }).probe);
}

/**
 * Starts the sampling, with the machine button's name to expect (none for a page without one).
 * `comments` holds the page to a comment being written, which a test that writes none during the
 * deploy can ask for. `relaxed` is for a tab the browser froze (see the question cases): its
 * sockets end with no word from the server, so for the page it is an ordinary lost connection,
 * which reads as it is (Build plan is gone while the socket opens again). What is offered must
 * then only be back as it was at the end (`expectOffersAsTheyWere`); every other check holds.
 */
async function startWatching(
	page: Page,
	machine?: string,
	options: { comments?: boolean; relaxed?: boolean } = {},
): Promise<void> {
	await page.evaluate(({ machine, options }) => {
		let probe = (window as unknown as { probe: Probe_ }).probe;
		probe.machine = machine;
		probe.comments = options.comments;
		probe.relaxed = options.relaxed;
		probe.baseline = (window as unknown as { offers: () => Record<string, string> }).offers();
		probe.watching = true;
		(window as unknown as { tab: string }).tab = "kept";
	}, { machine, options });
}

/** What the page offers is what it offered when watching began. */
async function expectOffersAsTheyWere(page: Page): Promise<void> {
	let { baseline, comments } = await probe(page);
	let now = await page.evaluate(() =>
		(window as unknown as { offers: () => Record<string, string> }).offers()
	);
	for (let [part, before] of Object.entries(baseline ?? {})) {
		if (part === "comment being written" && !comments) continue;
		expect(now[part], part).toBe(before);
	}
}

/** Things done with the keyboard take turns, so what is typed in one place never lands in another. */
function keyboard() {
	let last: Promise<unknown> = Promise.resolve();
	let focusLost = false;
	return {
		run<T>(action: () => Promise<T>, takesFocus = false): Promise<T> {
			let next = last.then(async () => {
				let result = await action();
				if (takesFocus) focusLost = true;
				return result;
			});
			last = next.catch(() => {});
			return next;
		},
		/** Whether something else has had the keyboard since the document did. */
		get away() {
			return focusLost;
		},
		returned() {
			focusLost = false;
		},
	};
}

/**
 * Words typed into the document one after the other, `w0 w1 ...`, each of which must arrive once
 * and in order. It goes on until `stopTyping` resolves, taking its turns at the keyboard.
 */
function typing(page: Page, keys: ReturnType<typeof keyboard>) {
	let state = { stopped: false };
	let count = 0;
	let loop = (async () => {
		while (!state.stopped) {
			let word = count++;
			await keys.run(async () => {
				if (keys.away) {
					await content(page).click();
					await content(page).press("ControlOrMeta+End");
					keys.returned();
				}
				await page.keyboard.type(`w${word} `);
			});
			await page.waitForTimeout(60);
		}
	})();
	return {
		get words() {
			return count;
		},
		async stop() {
			state.stopped = true;
			await loop;
		},
	};
}

/** A message to the Planner, sent the way a person sends it. */
async function say(page: Page, keys: ReturnType<typeof keyboard>, text: string): Promise<void> {
	await keys.run(async () => {
		let input = chatInput(page);
		await fillChat(input, `@chopin ${text}`);
		await input.press("Enter");
	}, true);
}

function chat(page: Page): Locator {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function replies(page: Page, text: string): Locator {
	return chat(page).getByText(text, { exact: true });
}

/** What a person sent to Chopin, as the Chat shows it: not the Planner's own lines, which may repeat it. */
function message(page: Page, text: string): Locator {
	return chat(page).locator("[data-chat-message-id]")
		.filter({ has: page.locator(".chat-mention") })
		.filter({ hasText: text });
}

/** What a message says once the server refused it, or the browser still holds it. */
const failure = (page: Page, text: string) => message(page, text).locator("[data-chat-failed]");
const sending = (page: Page) => chat(page).locator("[data-chat-delivery]");

/**
 * Two servers over one database and a proxy in front of them, with a person's tab open on a
 * document, as a deploy leaves them: A serving, B waiting beside it, and the proxy sending the
 * tab to whichever is ready.
 */
async function overlap(
	page: Page,
	source = "# Hand-over\n\nSteady text.\n\nA second paragraph.\n\nWords follow:\n",
) {
	let database = await freshDatabase();
	await migrate(database);
	let a = slotServer("a", database);
	await until("server A to be ready", async () => {
		if (a.child.exitCode !== null) throw new Error(`A exited: ${a.log.text.slice(-800)}`);
		return await ready_("a");
	});
	let b = slotServer("b", database);
	await until("server B to wait in standby", async () => {
		if (b.child.exitCode !== null) throw new Error(`B exited: ${b.log.text.slice(-800)}`);
		return (await live("b")) === "standby";
	});
	proxies.push(
		CADDY
			? await startProxy(PROXY_PORT, SLOT_PORTS)
			: await startHoldingProxy(PROXY_PORT, SLOT_PORTS),
	);
	registerTestDatabase(PROXY_PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PROXY_PORT, room);
	await seedChannel(PROXY_PORT, room, source);
	await watch(page);
	return { database, room, page, a, b } satisfies World;
}

/** The document is the signed-in person's own, so its Planner runs on their machine. */
async function createdBy(database: string, room: string, handle: string): Promise<void> {
	let sql = new SQL(database);
	try {
		await sql`UPDATE channels SET created_by = (SELECT id FROM users WHERE login = ${handle}) WHERE id = ${room}`;
	} finally {
		await sql.close();
	}
}

type Machine = {
	/** Calls the connector API as the paired machine, over the proxy. */
	post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
	/** The credential Chopin hands this machine's Planner backend for a document. */
	credential(document: string): Promise<string>;
	/** Opens a connection again, as the connector does when the server has forgotten its own. */
	reconnect(): Promise<void>;
	/** One Planner poll; throws when the server answers with an error the connector reopens on. */
	poll(planners: string[]): Promise<{ kind?: string; planners?: Array<{ id: string }> }>;
	/** Ctrl-C in `chopin connect`. */
	disconnect(): Promise<unknown>;
};

/** Pair a machine with a Planner command for the person signed in on `page`, and connect it. */
async function pair(page: Page, label: string): Promise<Machine> {
	let back = page.url();
	await page.goto(`${ORIGIN}/auth/github/connector?key`);
	await expect(page).toHaveURL(/\/machines\?server$/);
	let minted = await (await page.request.post(`${ORIGIN}/api/connector/pairing-keys`, {
		data: {},
		headers: { origin: ORIGIN },
	})).json() as { key: string };
	let checkout = { repository: "octo-org/score", commit: "a".repeat(40), label };
	let post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
		fetch(new URL(path, ORIGIN), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL),
				[CONNECTOR_VERSION_HEADER]: RELEASE,
				...extra,
			},
			body: JSON.stringify(body),
		});
	let paired = await (await post("/api/connector/pairings", {
		...checkout,
		key: minted.key,
	})).json() as { token: string };
	let token = "";
	let open = async () => {
		let opened = await post("/api/connector/connections", checkout, {
			[CONNECTOR_PLATFORM_HEADER]: "linux x64",
			[CONNECTOR_PLANNER_COMMAND_HEADER]: "1",
			authorization: `Bearer ${paired.token}`,
		});
		expect(opened.status, await opened.clone().text()).toBe(200);
		token = ((await opened.json()) as { token: string }).token;
	};
	await open();
	await page.goto(back);
	return {
		post,
		credential: async document => {
			let issued = await post("/api/connector/planner", { document }, {
				authorization: `Bearer ${paired.token}`,
			});
			expect(issued.status, await issued.clone().text()).toBe(200);
			return ((await issued.json()) as { token: string }).token;
		},
		reconnect: open,
		poll: async planners => {
			let response = await post("/connector/mcp", {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "wait_for_work", arguments: { planners } },
			}, { authorization: `Bearer ${token}` });
			let body = await response.json() as {
				result?: { isError?: boolean; content: Array<{ text: string }> };
				error?: unknown;
			};
			if (!response.ok || body.error || !body.result || body.result.isError) {
				throw new Error(`the poll was refused: ${response.status} ${JSON.stringify(body)}`);
			}
			return JSON.parse(body.result.content[0]!.text);
		},
		disconnect: () =>
			post("/connector/mcp", {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "disconnect_workspace", arguments: {} },
			}, { authorization: `Bearer ${token}` }),
	};
}

/**
 * A scripted Planner backend, started as the connector starts one: with a credential Chopin issued
 * for the document, attached over the proxy. It answers each message once, in the words
 * `Reply <tag>` for the `[tag]` the message carries, and a comment through `reply_comment`; a turn
 * whose message says `hold me` does not end until `release()`. When its link is closed because the
 * server is restarting it does what docs/agent-connection.md asks of a backend: connects again at
 * once, and retries a refused `resume` every 250 ms until the window the server named has passed.
 */
async function backend(
	token: string,
	document: string,
	options: { onTurn?: () => void; resumeAfter?: Promise<unknown>; steers?: boolean } = {},
) {
	let prompts: Array<{ tag: string; prompt: string; at: number; child?: string }> = [];
	/** What its running turns were given by a person, by the tag the message carries. */
	let steered: Array<{ tag: string; prompt: string; turn: string }> = [];
	let held = Promise.withResolvers<void>();
	let resumes: Array<{ attempts: number; at: number }> = [];
	let closes: Array<{ code: number; reconnectWithinMs?: number; at: number }> = [];
	let flags = { ended: false };
	/** Why the backend could not resume, if it could not. */
	let errors: string[] = [];
	/** How each question the backend asked ended, in the words of the client: `answered`, `cancelled`... */
	let outcomes: Array<{ status: string; value?: unknown; at: number }> = [];
	let handlers: AgentHandlers = {
		async turn(context: TurnContext) {
			let prompt = context.message.prompt;
			// Chopin's own upkeep of the document runs through the same Planner; it is not a message.
			if (prompt.startsWith("[Background job")) {
				context.emit({ type: "stream-start", modelId: "scripted" });
				return finishTurn(context);
			}
			let tag = [...prompt.matchAll(/\[([a-z]\d+)\]/g)].at(-1)?.[1] ?? "?";
			let entry: (typeof prompts)[number] = { tag, prompt, at: Math.round(performance.now()) };
			prompts.push(entry);
			options.onTurn?.();
			if (prompt.includes("hold me")) {
				let aborted = new Promise<void>(resolve =>
					context.signal.addEventListener("abort", () => resolve(), { once: true })
				);
				await Promise.race([held.promise, aborted]);
				if (context.signal.aborted) return context.end("aborted");
			}
			context.emit({ type: "stream-start", modelId: "scripted" });
			// What the turn was given while it ran, read at its next step.
			for (let given of steered.filter(given => given.turn === context.message.turn)) {
				let id = `read-${given.tag}`;
				context.emit({ type: "text-start", id });
				context.emit({ type: "text-delta", id, delta: `Read ${given.tag}` });
				context.emit({ type: "text-end", id });
			}
			// A message about an open child names it, and the turn reads the child through its tools.
			let child = /child id (\S+?)\)/.exec(prompt)?.[1];
			if (child) {
				let read = await context.callHostTool("read_child", { child });
				expect(read.isError, String(read.output)).toBe(false);
				entry.child = String(read.output);
			}
			let thread = /using thread (\S+?)\./.exec(prompt)?.[1];
			if (prompt.includes("ask me")) {
				// A question left open: the Decision waits for a member, and the turn ends.
				void state.client.ask(context.message.session, {
					method: "confirm",
					title: "Ship it?",
					message: "Now.",
				}).then(result => outcomes.push({ ...result, at: performance.now() }));
				// A turn that waits on its question, as a Planner's does, until it is let go.
				if (prompt.includes("stay on it")) {
					let aborted = new Promise<void>(resolve =>
						context.signal.addEventListener("abort", () => resolve(), { once: true })
					);
					await Promise.race([held.promise, aborted]);
					if (context.signal.aborted) return context.end("aborted");
				}
			}
			if (thread) {
				let result = await context.callHostTool("reply_comment", { thread, text: `Reply ${tag}` });
				expect(result.isError, String(result.output)).toBe(false);
			} else {
				let id = `reply-${tag}`;
				context.emit({ type: "text-start", id });
				context.emit({ type: "text-delta", id, delta: `Reply ${tag}` });
				context.emit({ type: "text-end", id });
			}
			finishTurn(context);
		},
		// Without it the client offers no way to take a message while a turn runs.
		...(options.steers
			? {
				steer(message) {
					let tag = [...message.prompt.matchAll(/\[([a-z]\d+)\]/g)].at(-1)?.[1] ?? "?";
					steered.push({ tag, prompt: message.prompt, turn: message.turn });
				},
			}
			: {}),
	};
	/** Turns in flight, and when the machine last did anything: Chopin's own upkeep counts. */
	let working = 0;
	let lastActive = performance.now();
	let turn = handlers.turn;
	handlers.turn = async context => {
		working++;
		lastActive = performance.now();
		try {
			await turn(context);
		} finally {
			working--;
			lastActive = performance.now();
		}
	};
	let state = {
		client: await connectAgent({ url: ORIGIN, token, document, handlers }),
	};
	let watching = (async () => {
		while (!flags.ended) {
			let previous = state.client;
			let closed = await previous.closed;
			if (flags.ended) return;
			closes.push({
				code: closed.code,
				reconnectWithinMs: closed.reconnectWithinMs,
				at: performance.now(),
			});
			await options.resumeAfter;
			try {
				let resumed = await resumeAfterRestart(previous, {
					url: ORIGIN,
					document,
					handlers,
					token,
				});
				state.client = resumed.client;
				resumes.push({ attempts: resumed.attempts, at: performance.now() });
				lastActive = performance.now();
			} catch (error) {
				// A link Chopin ended for good (the machine was disconnected) has nothing to resume.
				if (!flags.ended) errors.push(String(error));
				return;
			}
		}
	})();
	return {
		prompts,
		steered,
		/**
		 * How long the machine has had nothing to do: no turn in flight, its own upkeep (a title for
		 * the document, which runs once it is attached) included, since it last had, or resumed.
		 */
		idleFor: () => working > 0 ? 0 : performance.now() - lastActive,
		resumes,
		closes,
		errors,
		outcomes,
		get client() {
			return state.client;
		},
		release: () => held.resolve(),
		/** Whether the backend has stopped, as the connector stops one Chopin no longer asks for. */
		get stopped() {
			return flags.ended;
		},
		async detach() {
			flags.ended = true;
			held.resolve();
			await state.client.detach().catch(() => {});
			await Promise.race([watching, Bun.sleep(200)]);
		},
	};
}

/**
 * The connector's Planner poll beside the backend it started, as `apps/connector/src/planner.ts`
 * does it: poll naming the Planners it runs, reopen the connection when the server has forgotten
 * it (a new process), and stop a backend the server no longer asks for.
 */
function connector(machine: Machine, running: () => string[], withdraw: (id: string) => void) {
	let state = { on: true };
	let reopened = 0;
	let withdrawn: string[] = [];
	let answers: string[] = [];
	let loop = (async () => {
		while (state.on) {
			try {
				let answer = await machine.poll(running());
				answers.push(`${Math.round(performance.now())} ${JSON.stringify(answer)}`);
				if (answer.kind === "planners" && Array.isArray(answer.planners)) {
					let wanted = new Set(answer.planners.map(value => value.id));
					for (let id of running()) {
						if (wanted.has(id)) continue;
						withdrawn.push(id);
						withdraw(id);
					}
				}
			} catch (error) {
				if (!state.on) return;
				answers.push(`${Math.round(performance.now())} ${String(error).slice(0, 160)}`);
				// A transient failure, or a server that does not know the connection: open it again.
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
		answers,
		async stop() {
			state.on = false;
			await machine.disconnect().catch(() => {});
			await Promise.race([loop, Bun.sleep(300)]);
		},
	};
}

/**
 * A deploy: server A is sent SIGTERM while B waits, with traffic through the proxy throughout.
 * `released` is when A let go of the lease, on the clock of `performance.now()`.
 */
function beginDeploy(world: World) {
	let lease = watchLease(world.database);
	closers.push(() => lease.close());
	let traffic = new Probe(ORIGIN, { clients: 4, intervalMs: 15 });
	traffic.start();
	closers.push(async () => void await traffic.stop());
	let exit = signal(world.a);
	return {
		/** Resolves once A's answers carry `Connection: close`: it has heard SIGTERM. */
		told: until("server A to say it is stopping", () => stopping("a"), 10_000),
		released: lease.released,
		exit,
		async finish() {
			await until("server B to be ready", () => ready_("b"), 30_000);
			// A few more requests through the proxy, now answered by B.
			await Bun.sleep(1_500);
			let samples = await traffic.stop();
			let releasedAt = await lease.released;
			await lease.close();
			return {
				exit: await exit,
				releasedAt,
				report: measureHandover(samples, releasedAt),
				samples,
			};
		},
	};
}

/**
 * The gap from the release to the first answer, held to the design's budget, which is inside the
 * tab's own grace: a hand-over that took longer than the budget but not the grace would pass a
 * page that said nothing and still miss what the design promises. Printed as one line of the
 * run's output.
 */
async function expectGap(
	done: Awaited<ReturnType<ReturnType<typeof beginDeploy>["finish"]>>,
	...tabs: [Page, ...Page[]]
) {
	let { report } = done;
	console.log(
		`hand-over: ${report.requests} requests through the proxy, ${report.failures.length} not `
			+ `answered 2xx, ${report.heldAcrossRelease} held across the release (longest wait `
			+ `${report.longestMs} ms), first answer ${report.gapMs} ms after the release `
			+ `(design target ${BUDGET_MS} ms, tab grace ${GRACE_MS} ms)`,
	);
	expect(report.failures, JSON.stringify(report.failures.slice(0, 5))).toEqual([]);
	expect(report.gapMs).toBeDefined();
	expect(report.gapMs!).toBeLessThanOrEqual(BUDGET_MS);
	for (let tab of tabs) await expectReconnectGap(tab);
	return report.gapMs!;
}

/**
 * An open tab's own gap, which the proxy's first answer does not stand for: a quick answer from
 * the proxy can come with a slow socket upgrade or admission, and the tab's quiet reconnect
 * (`RESTART_QUIET_MS`, five seconds) would hide a gap of up to that long. Each kind of socket the
 * cut closed with 1012 (a document's, a child's, the sidebar's, told apart by its path and its
 * document, so one that comes back late is not paired with another's close) must open again
 * within the tab's grace (1.5 s), the design's budget for what a person never sees, and, where
 * the socket says hello, the hello must follow the server's word that it is restarting within it
 * too. Every kind is printed as a line of the run's output.
 */
async function expectReconnectGap(page: Page): Promise<void> {
	let seen = await probe(page);
	let gaps = reconnectGaps(seen.sockets);
	console.log(
		`tab reconnect: ${gaps.length} kind(s) of socket closed 1012: ${
			gaps.map(gap =>
				`${gap.key} ${gap.cuts} closed, opened again after ${gap.closeToOpenMs ?? "never"} ms`
				+ (gap.greets
					? `, hello ${gap.restartToHelloMs ?? "never"} ms after the restart frame`
					: "")
			).join("; ") || "none"
		} (tab grace ${GRACE_MS} ms)`,
	);
	expect(gaps, seen.timeline.join("\n")).not.toHaveLength(0);
	expect(reconnectProblems(gaps, GRACE_MS), seen.timeline.join("\n")).toEqual([]);
	expect(
		gaps.some(gap => gap.restartToHelloMs !== undefined),
		`no hello was measured\n${seen.timeline.join("\n")}`,
	).toBe(true);
}

/** A call to the MCP endpoint as the signed-in person's coding agent, through the proxy. */
async function mcp(body: unknown, session?: string): Promise<Response> {
	let response = await fetch(`${ORIGIN}/mcp`, {
		method: "POST",
		headers: {
			authorization: `Bearer ghu_e2e_${HANDLE}_1`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(session ? { "mcp-session-id": session } : {}),
		},
		body: JSON.stringify(body),
	});
	expect(response.status).toBe(200);
	return response;
}

/** A document of the signed-in person, whose Planner runs on their paired machine and is attached. */
async function arrange(
	page: Page,
	options: {
		source?: string;
		seed?: (room: string) => Promise<void>;
		resumeAfter?: Promise<unknown>;
		/** Whether its machine takes a message while a turn runs (it offers `steer-turn`). */
		steers?: boolean;
	} = {},
) {
	let world = await overlap(page, options.source);
	let { room } = world;
	await options.seed?.(room);
	await authenticate(page, HANDLE, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	await createdBy(world.database, room, HANDLE);
	let machine = await pair(page, MACHINE);
	await page.reload();
	await ready(page);
	let button = machineButton(page);
	// While the machine is connected to, the button says so, in its name; Chat draws nothing.
	await expect(button).toHaveAccessibleName(`Runs on ${MACHINE}. Connecting to ${MACHINE}`);
	await expect(strip(page)).toHaveCount(0);
	expect((await machine.poll([])).planners).toEqual([
		{ id: room, url: expect.stringContaining(ORIGIN) },
	]);
	let planner = await backend(await machine.credential(room), room, {
		resumeAfter: options.resumeAfter,
		steers: options.steers,
	});
	closers.push(() => planner.detach());
	await expect(button).toHaveAccessibleName(`Runs on ${MACHINE}`);
	await expect(button.locator(".machine-glyph-dot")).toHaveAttribute("data-state", "connected");
	await expectPlannerAttached(page);
	let connection = connector(
		machine,
		() => planner.stopped ? [] : [room],
		() => void planner.detach(),
	);
	closers.push(() => connection.stop());
	let loads = { count: 0 };
	page.on("load", () => loads.count++);
	await startWatching(page, `Runs on ${MACHINE}`);
	return { world, room, machine, planner, connection, button, loads };
}

test("a deploy under an open tab with a connected machine shows nothing, reloads nothing and loses nothing", async ({ page }) => {
	test.setTimeout(180_000);
	let { world, room, planner, connection, loads } = await arrange(page);
	let net: string[] = [];
	page.on("response", async response => {
		let url = new URL(response.url());
		if (!/machine/.test(url.pathname)) return;
		let body = await response.text().catch(() => "");
		net.push(
			`${Math.round(performance.now())} ${response.status()} ${url.pathname} ${body.slice(0, 200)}`,
		);
	});

	// An agent's MCP session, opened with the old process, and the old build's chunk, asked for later.
	let session = await mcp({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			clientInfo: { name: "Review bot", version: "1.0.0" },
		},
	});
	let mcpSession = session.headers.get("mcp-session-id")!;
	expect(mcpSession).toBeTruthy();

	let keys = keyboard();
	let draft = "A message for the team, not sent yet";
	await keys.run(() => fillChat(chatInput(page), draft), true);
	let typed = typing(page, keys);
	await Bun.sleep(1_000);

	let deploy = beginDeploy(world);
	await deploy.released;
	await Bun.sleep(1_000);
	let done = await deploy.finish();
	await typed.stop();
	expect(done.exit, world.a.log.text).toBe(0);
	let gap = await expectGap(done, page);
	console.log(`typed ${typed.words} words; gap ${gap} ms`);

	// The agent's session still works in the new process, and a chunk of a build that is gone is a 404.
	let read = await (await mcp({
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: { name: "read_document", arguments: { id: room } },
	}, mcpSession)).json() as { result?: { isError?: boolean }; error?: unknown };
	expect(read.error).toBeUndefined();
	expect(read.result?.isError).toBeUndefined();
	let gone = await fetch(`${ORIGIN}/assets/index-NoSuchBuild1.js`);
	expect(gone.status).toBe(404);
	expect(gone.headers.get("content-type") ?? "").not.toContain("text/html");

	await expect(status(page)).toHaveAttribute("data-level", "hidden");
	await expect(content(page)).toHaveAttribute("contenteditable", "true");
	let seen = await probe(page);
	console.log(seen.machines.join("\n"));
	console.log(
		`resumes ${JSON.stringify(planner.resumes)} closes ${JSON.stringify(planner.closes)}\n`
			+ `connector: reopened ${connection.reopened}, withdrawn ${connection.withdrawn}\n${
				connection.answers.join("\n")
			}\nnetwork:\n${net.join("\n")}`,
	);
	expect(seen.closes).toContain(1012);
	expect(seen.closes).not.toContain(1001);
	expect(seen.violations, seen.timeline.join("\n")).toEqual([]);
	expect(seen.resets).toEqual([]);
	expect(loads.count).toBe(0);
	// The machine was never told to stop its Planner, and was asked about again by the new process.
	expect(connection.withdrawn).toEqual([]);
	expect(connection.reopened).toBeGreaterThan(0);
	expect(planner.closes[0]).toMatchObject({ code: 1012, reconnectWithinMs: WINDOW_MS });
	expect(await page.evaluate(() => (window as unknown as { tab?: string }).tab)).toBe("kept");
	await expectChatValue(chatInput(page), draft);
	await expect.poll(() => readSource(PROXY_PORT, room), { timeout: 20_000 }).toContain(
		`w${typed.words - 1} `.trim(),
	);
	let words = [...(await readSource(PROXY_PORT, room)).matchAll(/\bw(\d+)\b/g)].map(match =>
		Number(match[1])
	);
	expect(words).toEqual(Array.from({ length: typed.words }, (_, index) => index));
});

/** Waits for the page to have lost its connection to the old process: the 1012 close has arrived. */
async function lostConnection(page: Page): Promise<void> {
	await expect.poll(async () => (await probe(page)).closes.includes(1012), { timeout: 15_000 })
		.toBe(true);
}

/** The tags of the messages people sent to Chopin, in the order the Chat shows them. */
async function sentTags(page: Page): Promise<string[]> {
	let texts = await chat(page).locator("[data-chat-message-id]")
		.filter({ has: page.locator(".chat-mention") }).allTextContents();
	return texts.map(text => /\[([a-z]\d+)\]/.exec(text)?.[1] ?? "?");
}

const tagsOf = (prompts: Array<{ tag: string }>) => prompts.map(prompt => prompt.tag);

/**
 * Until the machine has had nothing to do for a while. Chopin's own upkeep of the document (a
 * title for it) runs on the machine once it is attached, and a message sent while that runs is
 * refused, as one sent to a turn that cannot take it, so a test that means to start a turn waits.
 */
async function quiet(planner: { idleFor(): number }): Promise<void> {
	await until("the machine to have nothing to do", () => planner.idleFor() > 2_000, 30_000);
}

/** The states of the Planner requests an earlier release saved for the document, in the order it saved them. */
async function rowStates(database: string, room: string): Promise<string[]> {
	let sql = new SQL(database);
	try {
		let rows = await sql<{ state: string }[]>`
			SELECT state FROM planner_deferred_turns WHERE document_id = ${room} ORDER BY seq
		`;
		return rows.map(row => row.state);
	} finally {
		await sql.close();
	}
}

/** A request an earlier release was holding for a machine when the deploy began, as it saved one. */
async function holdRow(database: string, room: string, text: string): Promise<void> {
	let sql = new SQL(database);
	try {
		await sql`
			INSERT INTO planner_deferred_turns (
				id, document_id, request_id, kind, handle, user_id, text, references_json, state,
				created_at, fencing
			) VALUES (
				${crypto.randomUUID()}, ${room}, ${crypto.randomUUID()}, 'composer', ${HANDLE},
				'earlier-release', ${text}, '[]'::jsonb, 'waiting', now(), 1
			)
		`;
	} finally {
		await sql.close();
	}
}

/**
 * What the page said of a deploy that was meant to be invisible: nothing, but for the one message
 * it could not send, which says why above the composer and keeps the draft. The machine was shown
 * attached throughout.
 */
async function expectOnlyRefusals(page: Page, loads: { count: number }, expectedBanner?: string) {
	let seen = await probe(page);
	expect(seen.violations, seen.timeline.join("\n")).toEqual(
		expectedBanner ? [`chopin note ${expectedBanner}`] : [],
	);
	expect(seen.planner.filter(state => state !== "attached")).toEqual([]);
	expect(seen.resets).toEqual([]);
	expect(loads.count).toBe(0);
}

test("messages sent before, during and after the machine's hand-over window each end as started, given to the running turn or refused, and none is lost or left at Sending", async ({ browser, page }) => {
	test.setTimeout(240_000);
	let back = Promise.withResolvers<void>();
	let { world, room, planner, loads } = await arrange(page, {
		resumeAfter: back.promise,
		steers: true,
	});
	let keys = keyboard();

	// Before the deploy: the first message starts a turn, and the second, sent while it runs, is
	// given to it.
	await say(page, keys, "[m1] hold me");
	await until("the first turn to start", () => planner.prompts.length === 1);
	await say(page, keys, "[m2] sent while the turn runs, before the deploy");
	await until("the second message to reach the turn", () => planner.steered.length === 1);

	// During the old process's wait for that turn it is still serving, and still gives it a message.
	let deploy = beginDeploy(world);
	await deploy.told;
	await say(page, keys, "[m3] sent while the old process waits for the turn");
	await until("the third message to reach the turn", () => planner.steered.length === 2);

	// The turn ends, the old process lets go, and the page has lost its connection to it. The
	// person writes again: only this browser has it, and it says so.
	planner.release();
	await deploy.released;
	await lostConnection(page);
	await say(page, keys, "[m4] sent while the page is between processes");
	await expect(message(page, "[m4]")).toHaveCount(1);
	let done = await deploy.finish();
	expect(done.exit, world.a.log.text).toBe(0);
	await expectGap(done, page);

	// The new process has the lease and the machine is shown attached, but its client has not
	// resumed, inside its window: the browser sent the message again, and it was refused saying
	// still connecting, with the typed text kept in the draft and nothing kept on the server. chopin
	// says so to this person alone, in its quiet row at the end of the transcript.
	let banner = chat(page).locator("[data-quiet-note]");
	let inWindowWords =
		`Still connecting to @${HANDLE}'s machine, so this message wasn't sent. Send it again in a moment.`;
	await expect(banner).toContainText(inWindowWords);
	await expectChatValue(chatInput(page), "@chopin [m4] sent while the page is between processes");
	await expect(message(page, "[m4]")).toHaveCount(0);
	expect(planner.prompts.map(prompt => prompt.tag)).toEqual(["m1"]);
	expect(planner.resumes).toEqual([]);

	// The machine is back, inside the window, and a message sent now starts a turn.
	back.resolve();
	await until("the Planner to resume", () => planner.resumes.length > 0, WINDOW_MS);
	await quiet(planner);
	await say(page, keys, "[m5] sent once the machine is back");
	await expect(replies(page, "Reply m5")).toHaveCount(1);
	await expect(banner).toHaveCount(0);

	// Each one's end, in the Chat and at the machine: started (m1, m5), given to the running turn,
	// which read it (m2, m3), or refused with its draft kept (m4). None twice, none at Sending, none waiting.
	await expect(replies(page, "Reply m1")).toHaveCount(1);
	await expect(replies(page, "Read m2")).toHaveCount(1);
	await expect(replies(page, "Read m3")).toHaveCount(1);
	await expect(replies(page, "Reply m4")).toHaveCount(0);
	await expect(message(page, "[m4]")).toHaveCount(0);
	for (let tag of ["m1", "m2", "m3", "m5"]) {
		await expect(message(page, `[${tag}]`)).toHaveCount(1);
		await expect(failure(page, `[${tag}]`)).toHaveCount(0);
	}
	await expect(sending(page)).toHaveCount(0);
	await expect(chat(page).locator('[data-chat-state="queued"]')).toHaveCount(0);
	await Bun.sleep(1_000);
	expect(tagsOf(planner.prompts)).toEqual(["m1", "m5"]);
	expect(tagsOf(planner.steered)).toEqual(["m2", "m3"]);
	expect(planner.errors).toEqual([]);
	await expectOnlyRefusals(page, loads, inWindowWords);

	// The refused message was never kept: a tab opened afterwards has the other four, once, and
	// the server holds no row for any of them.
	let later = await browser.newContext();
	closers.push(() => later.close());
	let fresh = await later.newPage();
	await authenticate(fresh, "hubot", ORIGIN);
	await fresh.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(fresh);
	await expect.poll(() => sentTags(fresh)).toEqual(["m1", "m2", "m3", "m5"]);
	expect(await rowStates(world.database, room)).toEqual([]);
});

for (let steers of [true, false]) {
	test(`a turn running when the deploy begins is not cut off or run twice, and a message sent to it ${steers ? "reaches it" : "is refused with words, kept nowhere, and starts a turn when sent again"}`, async ({ page }) => {
		test.setTimeout(180_000);
		let { world, room, planner, loads } = await arrange(page, { steers });
		let keys = keyboard();

		await say(page, keys, "[m1] hold me");
		await until("the first turn to start", () => planner.prompts.length === 1);
		// The old process has heard SIGTERM and waits for the turn, still serving.
		let deploy = beginDeploy(world);
		await deploy.told;
		await say(page, keys, "[m2] sent to the turn the old process waits for");
		let busyWords =
			"chopin can't take messages while it works on this machine. Stop it to ask now.";
		let banner = chat(page).locator("[data-quiet-note]");
		if (steers) {
			await until("the message to reach the turn", () => planner.steered.length === 1);
			await expect(message(page, "[m2]")).toHaveCount(1);
			await expect(failure(page, "[m2]")).toHaveCount(0);
		} else {
			await expect(banner).toContainText(busyWords);
			await expectChatValue(
				chatInput(page),
				"@chopin [m2] sent to the turn the old process waits for",
			);
			await expect(message(page, "[m2]")).toHaveCount(0);
			expect(planner.steered).toEqual([]);
		}
		// Still running: the old process has not cut it off, and it has not begun again.
		await Bun.sleep(1_000);
		expect(planner.closes).toEqual([]);
		expect(tagsOf(planner.prompts)).toEqual(["m1"]);

		planner.release();
		let done = await deploy.finish();
		expect(done.exit, world.a.log.text).toBe(0);
		await expectGap(done, page);
		await until("the Planner to resume", () => planner.resumes.length > 0, WINDOW_MS);

		// It ended cleanly: one reply, read what it was given, and no notice of being stopped.
		await expect(replies(page, "Reply m1")).toHaveCount(1);
		await expect(replies(page, "Read m2")).toHaveCount(steers ? 1 : 0);
		await expect(chat(page).getByText(/stopped|cut off|interrupted|did not read/i)).toHaveCount(0);
		await expect(message(page, "[m2]")).toHaveCount(steers ? 1 : 0);
		await Bun.sleep(1_000);
		expect(tagsOf(planner.prompts)).toEqual(["m1"]);
		expect(tagsOf(planner.steered)).toEqual(steers ? ["m2"] : []);
		expect(await rowStates(world.database, room)).toEqual([]);

		if (!steers) {
			// Nothing was kept on the server, and the typed text stayed in the draft through the
			// deploy: pressing Enter sends it, and the new process answers it once.
			await expectChatValue(
				chatInput(page),
				"@chopin [m2] sent to the turn the old process waits for",
			);
			await quiet(planner);
			await keys.run(() => chatInput(page).press("Enter"), true);
			await expect(replies(page, "Reply m2")).toHaveCount(1);
			await expect(banner).toHaveCount(0);
			await expectChatValue(chatInput(page), "");
			expect(tagsOf(planner.prompts)).toEqual(["m1", "m2"]);
		}
		await expect(sending(page)).toHaveCount(0);
		expect(planner.errors).toEqual([]);
		await expectOnlyRefusals(page, loads, steers ? undefined : busyWords);
	});
}

test("once the new release has the lease the transcript holds no waiting or ghost message, a request an earlier release left open is closed unread, and a new @Chopin message starts a turn", async ({ browser, page }) => {
	test.setTimeout(180_000);
	let { world, room, planner, loads } = await arrange(page, { steers: true });
	let keys = keyboard();

	await say(page, keys, "[m1] hold me");
	await until("the first turn to start", () => planner.prompts.length === 1);
	await say(page, keys, "[m2] given to the turn before the deploy");
	await until("the second message to reach the turn", () => planner.steered.length === 1);
	// What the release before this one was holding for a machine when the deploy began.
	await holdRow(world.database, room, "@chopin [h1] held by the release before");
	expect(await rowStates(world.database, room)).toEqual(["waiting"]);

	let deploy = beginDeploy(world);
	await deploy.told;
	planner.release();
	await deploy.released;
	let done = await deploy.finish();
	expect(done.exit, world.a.log.text).toBe(0);
	await expectGap(done, page);
	await until("the Planner to resume", () => planner.resumes.length > 0, WINDOW_MS);
	await expectPlannerAttached(page);

	// The release that took the lease closed the row, without a turn: it is not waiting, and it
	// never reached the machine.
	await expect.poll(() => rowStates(world.database, room), { timeout: 20_000 }).toEqual([
		"cancelled",
	]);
	expect(world.b.log.text).toContain("1 message(s) an earlier release held for a Planner");

	// The transcript has what was said, once, and nothing waiting, sending or unsent, in the tab
	// that lived through the deploy and in one opened after it, which are the same.
	let later = await browser.newContext();
	closers.push(() => later.close());
	let fresh = await later.newPage();
	await authenticate(fresh, "hubot", ORIGIN);
	await fresh.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(fresh);
	for (let view of [page, fresh]) {
		await expect.poll(() => sentTags(view)).toEqual(["m1", "m2"]);
		await expect(replies(view, "Reply m1")).toHaveCount(1);
		await expect(replies(view, "Read m2")).toHaveCount(1);
		await expect(chat(view).getByText("[h1]", { exact: false })).toHaveCount(0);
		await expect(chat(view).locator("[data-chat-failed]")).toHaveCount(0);
		await expect(chat(view).locator('[data-chat-state="queued"]')).toHaveCount(0);
		await expect(sending(view)).toHaveCount(0);
	}

	// A new message to Chopin starts a turn of its own, once.
	await quiet(planner);
	await say(page, keys, "[m3] a new message after the hand-over");
	await expect(replies(page, "Reply m3")).toHaveCount(1);
	await expect(replies(fresh, "Reply m3")).toHaveCount(1);
	await Bun.sleep(1_000);
	expect(tagsOf(planner.prompts)).toEqual(["m1", "m3"]);
	expect(tagsOf(planner.steered)).toEqual(["m2"]);
	expect(planner.prompts.some(prompt => prompt.prompt.includes("[h1]"))).toBe(false);
	expect(planner.errors).toEqual([]);
	await expectOnlyRefusals(page, loads);
});

test("a Decision answered while the old process waits for the turn that asked it reaches that turn once, and starts no second one after the deploy", async ({ page }) => {
	test.setTimeout(180_000);
	let world = await overlap(page);
	let { room } = world;
	await authenticate(page, HANDLE, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	let planner = await backend(`ghu_e2e_${HANDLE}_1`, room);
	closers.push(() => planner.detach());
	await expectPlannerAttached(page);
	let loads = { count: 0 };
	page.on("load", () => loads.count++);
	await startWatching(page);
	let keys = keyboard();
	await say(page, keys, "[q1] ask me which way to go, and stay on it");
	let decision = content(page).locator("article[data-plan-sidecar-questionnaire]");
	await expect(decision).toBeVisible();

	// The old process has heard SIGTERM and waits for the turn, which waits for the answer.
	let deploy = beginDeploy(world);
	await deploy.told;
	await decision.getByText("Yes", { exact: true }).click();
	await decision.getByRole("button", { name: "Save", exact: true }).click();
	await expect(decision.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
	await until("the turn to be given its answer", () => planner.outcomes.length > 0, 10_000);
	expect(planner.outcomes).toMatchObject([{ status: "answered", value: true }]);
	planner.release();
	await deploy.released;
	let done = await deploy.finish();
	expect(done.exit, world.a.log.text).toBe(0);
	await expectGap(done, page);
	await until("the Planner to resume", () => planner.resumes.length > 0, WINDOW_MS);

	// The answer went to the turn that asked, and to nobody else: no turn of its own follows it,
	// past the moment a saved answer would have been handed over.
	await Bun.sleep(6_500);
	expect(planner.prompts.map(prompt => prompt.tag)).toEqual(["q1"]);
	expect(planner.outcomes).toHaveLength(1);
	await expect(replies(page, "Reply q1")).toHaveCount(1);
	await expect(decision.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
	let seen = await probe(page);
	expect(seen.violations, seen.timeline.join("\n")).toEqual([]);
	expect(seen.planner.filter(state => state !== "attached")).toEqual([]);
	expect(loads.count).toBe(0);
	expect(planner.errors).toEqual([]);
});

/**
 * A comment being written, and where it goes, as a person left it: the words, and that it is sent
 * to Chopin (offered while a Planner runs here). The card stays open through a deploy with the
 * words in it, and a comment started after it is offered the same.
 */
test("a comment being written across a deploy keeps its words and its offer to send it to Chopin, and a new one is offered the same", async ({ page }) => {
	test.setTimeout(120_000);
	let world = await overlap(page);
	let { room } = world;
	await authenticate(page, HANDLE, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	let planner = await backend(`ghu_e2e_${HANDLE}_1`, room);
	closers.push(() => planner.detach());
	await expectPlannerAttached(page);
	let draft = async (paragraph: number) => {
		await page.waitForFunction(() =>
			document.getAnimations().every(a => a.playState !== "running")
		);
		await content(page).locator("p").nth(paragraph).selectText();
		await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
		return page.getByRole("dialog", { name: "New comment" });
	};
	let card = await draft(1);
	await expect(card.getByRole("checkbox", { name: "Send to chopin" })).toBeChecked();
	await card.getByRole("textbox", { name: "Comment" }).fill("half a thought");
	let loads = { count: 0 };
	page.on("load", () => loads.count++);
	await startWatching(page, undefined, { comments: true });

	let deploy = beginDeploy(world);
	await deploy.released;
	let done = await deploy.finish();
	expect(done.exit, world.a.log.text).toBe(0);
	await expectGap(done, page);

	await expect(card.getByRole("textbox", { name: "Comment" })).toHaveValue("half a thought");
	await expect(card.getByRole("checkbox", { name: "Send to chopin" })).toBeChecked();
	let seen = await probe(page);
	expect(seen.violations, seen.timeline.join("\n")).toEqual([]);
	expect(seen.planner.filter(state => state !== "attached")).toEqual([]);
	await expectOffersAsTheyWere(page);
	// The offer itself: a comment started after the deploy is addressed to Chopin by default.
	await card.getByRole("textbox", { name: "Comment" }).press("Escape");
	await expect(card).toHaveCount(0);
	await expect((await draft(2)).getByRole("checkbox", { name: "Send to chopin" })).toBeChecked();
	expect(loads.count).toBe(0);
	expect(planner.errors).toEqual([]);
});

/** How long the owner's frozen tab stays frozen after the release: well inside the window. */
const FROZEN_MS = 3_000;

/**
 * Whether the page is really in the background: it reads `hidden`, and a timer of 25 ms fires
 * about once a second, as the browser holds a background tab's timers, not forty times a second.
 */
async function expectBackground(page: Page): Promise<void> {
	await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 5_000 })
		.toBe("hidden");
	let ticks = await page.evaluate(async () => {
		let count = 0;
		let timer = setInterval(() => count++, 25);
		await new Promise(resolve => setTimeout(resolve, 3_000));
		clearInterval(timer);
		return count;
	});
	// A page in front would count about 120.
	expect(ticks).toBeLessThan(10);
}

/**
 * The question a Planner left open across a deploy: its client resumes within the window and its
 * own question is still waiting, so the answer a member gives reaches that question, once, and no
 * turn of its own follows it. In one variant the member answers before the client is back, and
 * the answer waits for it.
 *
 * The owner's login is restored by their browser's own request, so a tab that is slow to send one
 * is the risk to the window. The owner's tab is also in the background, really (its own browser,
 * `e2e/background-browser.ts`: it reads `hidden` and its timers fire once a second), and frozen,
 * as the browser freezes a tab it has left alone, for `FROZEN_MS` after the release.
 */
for (
	let { tab, answerFirst } of [
		{ tab: "front", answerFirst: false },
		{ tab: "background", answerFirst: false },
		{ tab: "frozen", answerFirst: false },
		{ tab: "front", answerFirst: true },
	] as const
) {
	test(`a Planner attached under its owner's own sign-in, holding an open question, resumes within its window across a deploy, no member sees it away and its own question is answered once${tab === "front" ? "" : tab === "background" ? ", with the owner's tab in the background" : ", with the owner's tab frozen for a moment"}${answerFirst ? ", when the answer is given before it is back" : ""}`, async ({ browser, page: fixture }) => {
		test.setTimeout(180_000);
		let own = tab === "front" ? undefined : await backgroundBrowser();
		if (own) closers.push(() => own.close());
		let page = own ? await own.context.newPage() : fixture;
		let world = await overlap(page);
		let { room } = world;
		await authenticate(page, HANDLE, ORIGIN);
		await page.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(page);
		let back = Promise.withResolvers<void>();
		let planner = await backend(
			`ghu_e2e_${HANDLE}_1`,
			room,
			answerFirst ? { resumeAfter: back.promise } : {},
		);
		closers.push(() => planner.detach());
		await expectPlannerAttached(page);
		let teammate = await browser.newContext();
		closers.push(() => teammate.close());
		let other = await teammate.newPage();
		await watch(other);
		await authenticate(other, "hubot", ORIGIN);
		await other.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(other);
		await expectPlannerAttached(other);
		let loads = { count: 0 };
		page.on("load", () => loads.count++);
		await startWatching(page, undefined, { relaxed: tab === "frozen" });
		await startWatching(other);

		let keys = keyboard();
		await say(page, keys, "[q1] ask me which way to go");
		let decision = content(page).locator("article[data-plan-sidecar-questionnaire]");
		await expect(decision).toBeVisible();
		await expect(replies(page, "Reply q1")).toHaveCount(1);
		await expect(other.locator("article[data-plan-sidecar-questionnaire]").first()).toBeVisible();
		if (own && tab !== "front") {
			await own.toFront();
			await expectBackground(page);
			if (tab === "frozen") await own.freeze(page, true);
		}

		let deploy = beginDeploy(world);
		await deploy.released;
		let thawedAt: number | undefined;
		if (own && tab === "frozen") {
			// Frozen, the tab can send nothing, so the owner's login cannot come back until it thaws.
			await Bun.sleep(FROZEN_MS);
			thawedAt = performance.now();
			await own.freeze(page, false);
		}
		let done = await deploy.finish();
		expect(done.exit, world.a.log.text).toBe(0);
		// A tab left in the background or frozen by the browser is not held to a gap of its own: the
		// browser holds its timers and ends its sockets, which is not the deploy. The teammate's is.
		await expectGap(done, other, ...(tab === "front" ? [page] : []));

		let teammateCard = other.locator("article[data-plan-sidecar-questionnaire]").first();
		// A member answers the Decision in the new process: it never went, and is still answerable,
		// by a teammate while the owner's tab is in the background. The client that asked it
		// resumed with its question still waiting, so the answer is the question's: it reaches the
		// client that asked, as it would have before the deploy, and starts no turn.
		let answer = async () => {
			await expect(decision).toBeVisible();
			await teammateCard.getByText("Yes", { exact: true }).click();
			await teammateCard.getByRole("button", { name: "Save", exact: true }).click();
			await expect(teammateCard.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
			await expect(decision.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
		};
		if (answerFirst) {
			await answer();
			expect(planner.resumes).toHaveLength(0);
			back.resolve();
		}

		// The client is back, and no member saw it away.
		await until("the Planner to resume", () => planner.resumes.length > 0, WINDOW_MS);
		let resumed = planner.resumes[0]!;
		console.log(
			`${tab === "front" ? "" : `${tab} tab: `}the Planner resumed ${
				Math.round(resumed.at - done.releasedAt)
			} ms after the release${
				thawedAt === undefined
					? ""
					: `, ${Math.round(resumed.at - thawedAt)} ms after the tab thawed`
			}, on attempt ${resumed.attempts} (window ${WINDOW_MS} ms)`,
		);
		expect(resumed.at - done.releasedAt).toBeLessThan(WINDOW_MS);
		/*
		 * A tab the browser froze has no connection for as long as it is frozen: the browser ends
		 * its sockets (they close 1006, with no word from the server) and the tab learns of it when
		 * it runs again, so what it offers reads as it is until its socket is open again (Build plan
		 * is gone meanwhile: `relaxed`). It counts its grace only while it can be looked at, so it
		 * says nothing of being offline, not the notice, not a lock, and every other check holds.
		 */
		for (let watcher of [page, other]) {
			let seen = await probe(watcher);
			expect(seen.violations, seen.timeline.join("\n")).toEqual([]);
			expect(seen.planner.filter(state => state !== "attached")).toEqual([]);
		}
		expect(loads.count).toBe(0);
		expect(planner.errors).toEqual([]);
		console.log(`question outcomes: ${JSON.stringify(planner.outcomes)}`);
		expect(planner.closes[0]).toMatchObject({ code: 1012, reconnectWithinMs: WINDOW_MS });

		if (!answerFirst) await answer();
		await until(
			"the Planner's own question to be answered",
			() => planner.outcomes.length > 0,
			20_000,
		);
		// Once, and to the question: its outcome is the answer, and past the moment a saved answer
		// would have been handed over, no turn of its own has followed it.
		await Bun.sleep(6_500);
		expect(planner.outcomes).toHaveLength(1);
		expect(planner.outcomes[0]).toMatchObject({ status: "answered", value: true });
		expect(planner.prompts.map(prompt => prompt.tag)).toEqual(["q1"]);
		for (let watcher of [page, other]) {
			await expect(replies(watcher, "Reply q1")).toHaveCount(1);
			await expect(replies(watcher, "Reply ?")).toHaveCount(0);
			await expect(chat(watcher).getByText("couldn't", { exact: false })).toHaveCount(0);
			let seen = await probe(watcher);
			expect(seen.violations, seen.timeline.join("\n")).toEqual([]);
			await expectOffersAsTheyWere(watcher);
		}
		expect(planner.errors).toEqual([]);
	});
}

/** What a page says of its connection being away: the notice, the lock and its words. */
const saysOffline = (violations: string[]) =>
	violations.filter(what => /^(locked|not editable|offline )/.test(what));

/**
 * A tab nobody can see is not told its connection is away. The browser holds a hidden tab's timers
 * to one a second and a frozen tab's not at all, so a grace counted there runs out in the same
 * tick as the reconnect that would end the loss, and the page says it is offline, locked, for the
 * moment before the socket opens. The grace is counted from when the tab can be looked at. Here a
 * hidden tab is frozen and thawed with its connection away for longer than the grace, and says
 * nothing, however long that takes and when it is back; shown while it is still away it says so
 * once the grace has run from then.
 */
test("a hidden tab that was frozen and gets its connection back later than the grace says nothing, and says it is offline only once it is shown and still away", async () => {
	test.setTimeout(120_000);
	let own = await backgroundBrowser();
	closers.push(() => own.close());
	let page = await own.context.newPage();
	let world = await overlap(page);
	await authenticate(page, HANDLE, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(world.room)}`);
	await ready(page);
	await startWatching(page);
	let front = await own.toFront();
	await expectBackground(page);
	let hellos = async () =>
		(await probe(page)).sockets.filter(socket => socket.kind === "hello").length;
	let before = await hellos();
	await own.freeze(page, true);
	await Bun.sleep(1_000);
	await own.freeze(page, false);
	await own.context.setOffline(true);
	// Longer than the grace by the clock, and by three of a hidden tab's ticks.
	await Bun.sleep(4_000);
	let away = await probe(page);
	expect(saysOffline(away.violations), away.timeline.join("\n")).toEqual([]);
	await own.context.setOffline(false);
	await until("the tab to have its document again", async () => await hellos() > before, 30_000);
	let back = await probe(page);
	expect(saysOffline(back.violations), back.timeline.join("\n")).toEqual([]);

	// Shown while the connection is away, it says so once the grace has run from then.
	await own.context.setOffline(true);
	let closed = (await probe(page)).closes.length;
	await own.freeze(page, true);
	await Bun.sleep(500);
	await own.freeze(page, false);
	await expect.poll(async () => (await probe(page)).closes.length, { timeout: 10_000 })
		.toBeGreaterThan(closed);
	await front.close();
	await page.bringToFront();
	await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
	await expect(page.locator('[data-connection-banner][data-layer="socket"]')).toBeVisible({
		timeout: 20_000,
	});
	await own.context.setOffline(false);
});

test("a Decision answered after a deploy, for a Planner whose client does not come back to resume, reaches the Planner once, as a turn, when it attaches again", async ({ page }) => {
	test.setTimeout(180_000);
	let world = await overlap(page);
	let { room } = world;
	await authenticate(page, HANDLE, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	// The client that asked is not coming back to resume: its restart does not retry, as one
	// that lost what it held would not.
	let never = Promise.withResolvers<void>();
	let first = await backend(`ghu_e2e_${HANDLE}_1`, room, { resumeAfter: never.promise });
	closers.push(() => first.detach());
	await expectPlannerAttached(page);
	let loads = { count: 0 };
	page.on("load", () => loads.count++);
	await startWatching(page);

	let keys = keyboard();
	await say(page, keys, "[q1] ask me which way to go");
	let decision = content(page).locator("article[data-plan-sidecar-questionnaire]");
	await expect(decision).toBeVisible();
	await expect(replies(page, "Reply q1")).toHaveCount(1);

	let deploy = beginDeploy(world);
	await deploy.released;
	let done = await deploy.finish();
	expect(done.exit, world.a.log.text).toBe(0);
	await expectGap(done, page);
	await expect(decision).toBeVisible();
	await decision.getByText("Yes", { exact: true }).click();
	await decision.getByRole("button", { name: "Save", exact: true }).click();
	await expect(decision.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
	// Nobody has taken the answer: the question it belongs to is still waiting for a client that
	// has not come back.
	expect(first.outcomes).toEqual([]);
	expect(first.prompts.map(prompt => prompt.tag)).toEqual(["q1"]);

	// The same account attaches again with nothing to resume: the answer is handed to it, once.
	await first.detach();
	let later = await backend(`ghu_e2e_${HANDLE}_1`, room);
	closers.push(() => later.detach());
	await until("the Planner to be given the answer", () => later.prompts.length > 0, 30_000);
	await Bun.sleep(6_500);
	expect(later.prompts).toHaveLength(1);
	expect(later.prompts[0]!.prompt).toContain("saved answer");
	expect(later.prompts[0]!.prompt).toContain('Chosen option (data): "Yes"');
	await expect(replies(page, "Reply ?")).toHaveCount(1);
	await expect(chat(page).getByText('mona answered "Ship it?"', { exact: true })).toHaveCount(1);
	await expect(chat(page).getByText("couldn't", { exact: false })).toHaveCount(0);
	let seen = await probe(page);
	expect(seen.violations, seen.timeline.join("\n")).toEqual([]);
	expect(loads.count).toBe(0);
});
