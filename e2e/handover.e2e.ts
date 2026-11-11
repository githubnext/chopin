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
import {
	createChannel,
	readSource,
	registerTestDatabase,
	seedChannel,
	seedLinkedChildChannel,
} from "./database";
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
			// Who the message is for is the person's own state: the @Chopin chip comes on when they ask
			// Chopin and stays, and the sparkle that puts it on is spent while it is. A deploy changes neither.
			let asking = !!composer?.querySelector("[aria-label='Asking Chopin']");
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
								!/^(Send message|Stop generating|Resume Chopin|Remove Chopin)$/.test(
									button.getAttribute("aria-label") ?? "",
								)
							)
							.map(button => {
								let said = state(button);
								return asking && said === "Ask Chopin (not available)" ? "Ask Chopin" : said;
							}).join(" | ")
					}`
					: "absent",
				"document": document.querySelector(".plan-content")?.getAttribute("contenteditable")
					?? "absent",
				"comment being written":
					[...document.querySelectorAll(".plan-comment-composer")].map(card =>
						`${
							(card.querySelector(".plan-comment-address-box") as HTMLInputElement | null)?.checked
								? "sent to Chopin"
								: "not sent to Chopin"
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
					/^(You're offline|Reconnecting|Back online|Catching up|Back\.)/.test(spoken)
						? `offline status ${spoken}`
						: `machine said ${spoken}`,
				);
			}
			// A message that says it could not be sent, whatever the reason.
			if (document.querySelector("[data-chat-failed]")) say("a message says it could not be sent");
			let notice = document.querySelector(".chat-composer .composer-notice")?.textContent?.trim();
			if (notice) say(`composer strip ${notice}`);
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

function message(page: Page, text: string): Locator {
	return chat(page).locator("[data-chat-message-id]").filter({ hasText: text });
}

function replies(page: Page, text: string): Locator {
	return chat(page).getByText(text, { exact: true });
}

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
	options: { onTurn?: () => void; resumeAfter?: Promise<unknown> } = {},
) {
	let prompts: Array<{ tag: string; prompt: string; at: number; child?: string }> = [];
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
			} catch (error) {
				// A link Chopin ended for good (the machine was disconnected) has nothing to resume.
				if (!flags.ended) errors.push(String(error));
				return;
			}
		}
	})();
	return {
		prompts,
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
	// While the machine is connected to, the one banner at the composer says so, in the Planner's
	// layer; the button is named for the machine alone.
	await expect(button).toHaveAccessibleName(`Runs on ${MACHINE}`);
	await expect(strip(page)).toHaveAttribute("data-layer", "planner");
	await expect(strip(page)).toContainText(`Connecting to ${MACHINE}`);
	expect((await machine.poll([])).planners).toEqual([
		{ id: room, url: expect.stringContaining(ORIGIN) },
	]);
	let planner = await backend(await machine.credential(room), room, {
		resumeAfter: options.resumeAfter,
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

/** How the saved Planner requests of the document ended, by the text they carried or the thread. */
async function turns(database: string, room: string) {
	let sql = new SQL(database);
	try {
		return await sql<{ kind: string; state: string; text: string }[]>`
			SELECT kind, state, text FROM planner_deferred_turns WHERE document_id = ${room}
			ORDER BY created_at, seq
		`;
	} finally {
		await sql.close();
	}
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

test("what a person sends the Planner before, during and after a deploy, in the chat and in a comment, is answered once, in order, after it", async ({ browser, page }) => {
	test.setTimeout(180_000);
	let { world, room, planner, connection, loads } = await arrange(page);
	// A teammate has the document open too, with no machine button of their own: whatever is said
	// about the machine is said to them on the composer's edge.
	let teammate = await browser.newContext();
	closers.push(() => teammate.close());
	let other = await teammate.newPage();
	await watch(other);
	await authenticate(other, "hubot", ORIGIN);
	await other.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(other);
	await expectPlannerAttached(other);
	await startWatching(other);
	let keys = keyboard();
	let input = chatInput(page);
	let marks = (text: string, mark: string) => message(page, text).getByRole("img", { name: mark });

	// A turn is running, and a second message waits behind it, when the deploy starts.
	await say(page, keys, "[m1] hold me, and answer when I say");
	await until("the first turn to start", () => planner.prompts.length === 1);
	await say(page, keys, "[m2] this one waits behind it");
	await expect(marks("[m2]", "Sent")).toBeVisible();

	let typed = typing(page, keys);
	let deploy = beginDeploy(world);
	await deploy.told;
	// During the turn wait, the old process is still serving and still taking requests: it keeps
	// each as a saved row and starts none.
	await say(page, keys, "[m3] sent while the old process waits for the turn");
	await expect(marks("[m3]", "Sent")).toBeVisible();
	await keys.run(async () => {
		// Not `startCommentToChopin`: it waits for every animation to stop, and the one that shows
		// Chopin working on a reply does not while a turn runs.
		await content(page).locator("p", { hasText: "A second paragraph" }).first().selectText();
		await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
		let card = page.getByRole("dialog", { name: "New comment" });
		await card.getByRole("checkbox", { name: "Send to Chopin" }).check();
		await card.getByRole("textbox", { name: "Comment" }).fill("[c1] Can you shorten this?");
		await card.getByRole("button", { name: "Post comment", exact: true }).click();
		await expect(card).toHaveCount(0);
	}, true);
	expect(planner.prompts.map(prompt => prompt.tag)).toEqual(["m1"]);
	// Its thread shows Chopin on it, though the turn waits for the machine to come back.
	await keys.run(async () => {
		await page.getByRole("button", { name: /^Comment on “.*”\. / }).click();
		let thread = page.getByRole("dialog", { name: "Comment thread" });
		await expect(thread.getByRole("status")).toHaveText("Chopin is working on it");
		await page.keyboard.press("Escape");
		await expect(thread).toHaveCount(0);
	}, true);
	let draft = "@chopin [m4] typed before the cut and sent after it";
	await keys.run(() => fillChat(input, draft), true);

	// The turn ends: the old process lets go, and the page has lost its connection to it.
	planner.release();
	await deploy.released;
	await lostConnection(page);
	await keys.run(() => input.press("Enter"), true);
	let kept = "A draft, not sent, kept to the end";
	await keys.run(() => fillChat(input, kept), true);
	let done = await deploy.finish();
	await typed.stop();
	expect(done.exit, world.a.log.text).toBe(0);
	await expectGap(done, page, other);

	// Every message answered, once, and in the order it was accepted.
	for (let tag of ["m1", "m2", "m3", "m4"]) {
		await expect(replies(page, `Reply ${tag}`)).toHaveCount(1);
		await expect(marks(`[${tag}]`, "Delivered")).toBeVisible();
		await expect(marks(`[${tag}]`, "Sent")).toHaveCount(0);
	}
	// The thread was Chopin's to answer all along, and now holds its reply, once.
	await keys.run(async () => {
		await page.getByRole("button", { name: /^Comment on “.*”\. / }).click();
		let thread = page.getByRole("dialog", { name: "Comment thread" });
		await expect(thread.getByText("Reply c1", { exact: true })).toHaveCount(1);
		await expect(thread.getByText("Chopin is working on it")).toHaveCount(0);
		await page.keyboard.press("Escape");
		await expect(thread).toHaveCount(0);
	}, true);
	await expect.poll(() => planner.prompts.map(prompt => prompt.tag)).toEqual([
		"m1",
		"m2",
		"m3",
		"c1",
		"m4",
	]);
	await Bun.sleep(500);
	expect(planner.prompts).toHaveLength(5);
	// Every request has a row, saved before it was acknowledged, the first included, and each ended:
	// none is left waiting, started, interrupted or cancelled.
	await expect.poll(async () =>
		(await turns(world.database, room)).every(row => row.state === "ended")
	)
		.toBe(true);
	let rows = await turns(world.database, room);
	expect(rows.map(row => row.kind)).toEqual([
		"composer",
		"composer",
		"composer",
		"comment",
		"composer",
	]);
	expect(
		rows.filter(row => row.kind === "composer").map(row => /\[(m\d)\]/.exec(row.text)?.[1]),
	).toEqual(["m1", "m2", "m3", "m4"]);

	// A tab opened afterwards reads the same history from the server: each reply once.
	let later = await browser.newContext();
	closers.push(() => later.close());
	let fresh = await later.newPage();
	await authenticate(fresh, "hubot", ORIGIN);
	await fresh.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(fresh);
	for (let tag of ["m1", "m2", "m3", "m4"]) {
		await expect(replies(fresh, `Reply ${tag}`)).toHaveCount(1);
		await expect(message(fresh, `[${tag}]`)).toHaveCount(1);
	}

	// Nothing was shown, and nothing was lost, doubled or reloaded.
	let seen = await probe(page);
	expect(seen.restarting.length).toBeGreaterThan(0);
	expect(seen.violations, seen.timeline.join("\n")).toEqual([]);
	let teammates = await probe(other);
	expect(teammates.violations, teammates.timeline.join("\n")).toEqual([]);
	expect(teammates.planner.filter(state => state !== "attached")).toEqual([]);
	expect(planner.errors).toEqual([]);
	for (let tag of ["m1", "m2", "m3", "m4"]) {
		await expect(replies(other, `Reply ${tag}`)).toHaveCount(1);
	}
	expect(seen.resets).toEqual([]);
	expect(loads.count).toBe(0);
	expect(connection.withdrawn).toEqual([]);
	expect(await page.evaluate(() => (window as unknown as { tab?: string }).tab)).toBe("kept");
	await expectChatValue(input, kept);
	await expect.poll(() => readSource(PROXY_PORT, room), { timeout: 20_000 }).toContain(
		`w${typed.words - 1}`,
	);
	let words = [...(await readSource(PROXY_PORT, room)).matchAll(/\bw(\d+)\b/g)].map(match =>
		Number(match[1])
	);
	expect(words).toEqual(Array.from({ length: typed.words }, (_, index) => index));
});

test("a message sent from an open child while a deploy waits for a turn keeps the child it was about, and is answered once after it", async ({ page }) => {
	test.setTimeout(180_000);
	let childId = crypto.randomUUID();
	let title = "Hand-over child";
	let { world, planner, loads } = await arrange(page, {
		seed: async room => {
			await seedLinkedChildChannel(
				PROXY_PORT,
				room,
				childId,
				title,
				`# ${title}\n\nA finding to keep.\n`,
			);
		},
	});
	let keys = keyboard();
	let marks = (text: string, mark: string) => message(page, text).getByRole("img", { name: mark });
	await page.reload();
	await ready(page);
	loads.count = 0;
	await page.getByRole("link", { name: `#${title}`, exact: true }).click();
	let surface = page.getByRole("region", { name: `Child document: ${title}` });
	await expect(surface.locator(`[data-workspace-room="${childId}"]`)).toBeVisible();
	await startWatching(page, `Runs on ${MACHINE}`);

	await say(page, keys, "[m1] hold me");
	await until("the first turn to start", () => planner.prompts.length === 1);
	let deploy = beginDeploy(world);
	await deploy.told;
	await say(page, keys, "[m2] about the open child");
	await expect(marks("[m2]", "Sent")).toBeVisible();
	planner.release();
	let done = await deploy.finish();
	expect(done.exit, world.a.log.text).toBe(0);
	await expectGap(done, page);

	await expect(replies(page, "Reply m1")).toHaveCount(1);
	await expect(replies(page, "Reply m2")).toHaveCount(1);
	await expect(marks("[m2]", "Delivered")).toBeVisible();
	await expect.poll(() => planner.prompts.map(prompt => prompt.tag)).toEqual(["m1", "m2"]);
	// The turn that waited a deploy out was told which child the person had open, as one that
	// had not waited would be, and could read it in the new process.
	let second = planner.prompts[1]!;
	expect(second.prompt).toContain(`The member is viewing the child document "${title}"`);
	expect(second.prompt).toContain(`child id ${childId}`);
	expect(second.child ?? "").toContain("A finding to keep.");
	expect(planner.errors).toEqual([]);

	let seen = await probe(page);
	expect(seen.violations, seen.timeline.join("\n")).toEqual([]);
	expect(loads.count).toBe(0);
	await expect(surface.locator(`[data-workspace-room="${childId}"]`)).toBeVisible();
});

/**
 * The lock every fenced write of the writer lease takes (`#assertLease` in the PostgreSQL
 * adapter): `hold` takes it, so that a process that has to write next stands where it is. Taken
 * when the old process's cut begins, it stops that process at the commit of its cut, after it has
 * stopped taking requests and while every socket is still open, as the cut stands for a few
 * milliseconds when nothing is held. It is connected first, so that `hold` is one round trip.
 */
async function holdWrites(database: string) {
	let sql = new SQL(database, { max: 1 });
	await sql`SELECT 1`;
	return {
		async hold() {
			await sql`SELECT pg_advisory_lock(2043237433, hashtext('chopin:writer'))`;
		},
		async release() {
			try {
				await sql`SELECT pg_advisory_unlock(2043237433, hashtext('chopin:writer'))`;
			} finally {
				await sql.close();
			}
			return performance.now();
		},
	};
}

test("messages sent without a pause while the old process is cutting, with its sockets still open, are never marked Couldn't send, and are each delivered once, in order, with one reply", async ({ page }) => {
	test.setTimeout(180_000);
	let { world, room, planner, loads } = await arrange(page);
	let keys = keyboard();
	let marks = (text: string, mark: string) => message(page, text).getByRole("img", { name: mark });

	// A person who keeps sending, one message after another, while `phase.sending` is on.
	let sent: Array<{ tag: string; at: number }> = [];
	let phase = { sending: true, finished: false };
	let streaming = (async () => {
		for (let number = 1; !phase.finished && number <= 80;) {
			if (!phase.sending) {
				await page.waitForTimeout(10);
				continue;
			}
			let tag = `s${number++}`;
			await say(page, keys, `[${tag}] one after another`);
			sent.push({ tag, at: performance.now() });
			await page.waitForTimeout(20);
		}
	})();
	await until("the first messages to be answered", () => planner.prompts.length >= 2, 30_000);
	// Idle before the deploy: every message answered, so that no turn is left to wait for.
	phase.sending = false;
	await until(
		"every message so far to be answered",
		async () =>
			planner.prompts.length === sent.length
			&& (await turns(world.database, room)).every(row => row.state === "ended"),
	);

	let writes = await holdWrites(world.database);
	// Let go of the lock however the test ends, so that a process stood at its cut can exit.
	closers.push(async () => void await writes.release());
	let deploy = beginDeploy(world);
	let leaseReleased = false;
	void deploy.released.then(() => {
		leaseReleased = true;
	}, () => {});
	// Not before the cut begins. The old process first settles, still serving: it commits and
	// checkpoints every document, and a commit's checkpoint is made 500 ms after it
	// (`scheduleCheckpoint`), so a message answered less than that before SIGTERM leaves a write
	// that stops on the lock, before the listener, and the process never stops listening. Readiness
	// going off is the cut's first step, after every write before it and with the whole unready
	// window still to run, so the next write the process makes is the cut's own.
	await until(
		"the old process to begin its cut",
		async () => (await text(slotUrl("a", "/api/health/ready")))?.[1] === "draining",
	);
	await writes.hold();
	// The old process stops taking requests, then stands at the commit of its cut. Its sockets are
	// open, and the page keeps on pressing Enter.
	await until("the old process to stop listening", async () => (await live("a")) === undefined);
	let fromAt = performance.now();
	phase.sending = true;
	await Bun.sleep(1_500);
	// The cut stood still all that time: a lock taken after the window would have let it by.
	expect(leaseReleased, "the old process released the lease while its writes were held").toBe(
		false,
	);
	let toAt = await writes.release();
	let done = await deploy.finish();
	await until(
		"messages to have followed the release",
		async () => sent.some(message => message.at > done.releasedAt + 500),
		30_000,
	);
	phase.finished = true;
	await streaming;
	expect(done.exit, world.a.log.text).toBe(0);
	await expectGap(done, page);
	let atTheCut = sent.filter(message => message.at >= fromAt && message.at <= toAt);
	console.log(
		`${sent.length} messages; ${atTheCut.length} pressed while the cut stood still, `
			+ `${sent.filter(message => message.at > done.releasedAt).length} after the release; `
			+ world.a.log.text.split("\n").filter(line => /cut finished/.test(line)).join(""),
	);
	expect(atTheCut.length).toBeGreaterThanOrEqual(1);

	// Each answered once and marked delivered, none marked as one that could not be sent.
	for (let { tag } of sent) {
		await expect(replies(page, `Reply ${tag}`)).toHaveCount(1);
		await expect(marks(`[${tag}]`, "Delivered")).toBeVisible();
		await expect(marks(`[${tag}]`, "Sent")).toHaveCount(0);
		await expect(message(page, `[${tag}]`).locator("[data-chat-failed]")).toHaveCount(0);
	}
	// Given to the machine once each, in the order they were pressed.
	await expect.poll(() =>
		planner.prompts.map(prompt => prompt.tag).filter(tag => /^s\d+$/.test(tag))
	).toEqual(sent.map(message => message.tag));
	await Bun.sleep(500);
	expect(planner.prompts.filter(prompt => /^s\d+$/.test(prompt.tag))).toHaveLength(sent.length);
	await expect.poll(async () =>
		(await turns(world.database, room)).every(row => row.state === "ended")
	).toBe(true);
	expect((await turns(world.database, room)).filter(row => row.kind === "composer")).toHaveLength(
		sent.length,
	);

	let seen = await probe(page);
	expect(seen.restarting.length).toBeGreaterThan(0);
	expect(seen.violations, seen.timeline.join("\n")).toEqual([]);
	expect(seen.resets).toEqual([]);
	expect(loads.count).toBe(0);
	expect(planner.errors).toEqual([]);
});

test("a message sent while the machine is away through a deploy shows Sent, never an error, and is Delivered once, with one reply, when its Planner is back", async ({ page }) => {
	test.setTimeout(180_000);
	let back = Promise.withResolvers<void>();
	let { world, room, planner, loads } = await arrange(page, { resumeAfter: back.promise });
	let keys = keyboard();
	let input = chatInput(page);
	let marks = (text: string, mark: string) => message(page, text).getByRole("img", { name: mark });

	let deploy = beginDeploy(world);
	await deploy.released;
	await lostConnection(page);
	// The page has lost its connection, the machine is not back, and the person writes to it.
	await say(page, keys, "[m1] sent while the machine is away through the deploy");
	await expectChatValue(input, "");
	await expect(message(page, "[m1]")).toHaveCount(1);
	let done = await deploy.finish();
	expect(done.exit, world.a.log.text).toBe(0);
	await expectGap(done, page);

	// The new process has it, saved: Sent, not Delivered, and nothing about the machine is said,
	// while its Planner is expected back within its window.
	await expect(marks("[m1]", "Sent")).toBeVisible();
	await Bun.sleep(1_000);
	await expect(marks("[m1]", "Sent")).toBeVisible();
	await expect(marks("[m1]", "Delivered")).toHaveCount(0);
	expect(planner.prompts).toEqual([]);
	await expect(page.locator(".chat-composer .composer-notice")).toHaveCount(0);
	expect((await turns(world.database, room)).map(row => row.state)).toEqual(["waiting"]);

	back.resolve();
	await expect(marks("[m1]", "Delivered")).toBeVisible();
	await expect(replies(page, "Reply m1")).toHaveCount(1);
	await expect(marks("[m1]", "Sent")).toHaveCount(0);
	await Bun.sleep(500);
	expect(planner.prompts.map(prompt => prompt.tag)).toEqual(["m1"]);
	await expect.poll(async () => (await turns(world.database, room)).map(row => row.state)).toEqual([
		"ended",
	]);
	let resumed = planner.resumes.at(-1)!;
	console.log(
		`the Planner was back ${Math.round(resumed.at - planner.closes[0]!.at)} ms after the close`,
	);

	let seen = await probe(page);
	expect(seen.violations, seen.timeline.join("\n")).toEqual([]);
	expect(seen.planner.filter(state => state !== "attached")).toEqual([]);
	expect(loads.count).toBe(0);
	expect(planner.errors).toEqual([]);
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
	await expect(card.getByRole("checkbox", { name: "Send to Chopin" })).toBeChecked();
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
	await expect(card.getByRole("checkbox", { name: "Send to Chopin" })).toBeChecked();
	let seen = await probe(page);
	expect(seen.violations, seen.timeline.join("\n")).toEqual([]);
	expect(seen.planner.filter(state => state !== "attached")).toEqual([]);
	await expectOffersAsTheyWere(page);
	// The offer itself: a comment started after the deploy is addressed to Chopin by default.
	await card.getByRole("textbox", { name: "Comment" }).press("Escape");
	await expect(card).toHaveCount(0);
	await expect((await draft(2)).getByRole("checkbox", { name: "Send to Chopin" })).toBeChecked();
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
		timeout: 10_000,
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
	await expect(chat(page).getByText('Mona answered "Ship it?"', { exact: true })).toHaveCount(1);
	await expect(chat(page).getByText("couldn't", { exact: false })).toHaveCount(0);
	let seen = await probe(page);
	expect(seen.violations, seen.timeline.join("\n")).toEqual([]);
	expect(loads.count).toBe(0);
});
