import AxeBuilder from "@axe-core/playwright";

import { instruction } from "../packages/protocol/address";
import {
	allBanners,
	connectionBanner,
	failureBanner,
	phaseVoice,
	RESUMED_WAIT,
	watchBanners,
} from "./banner";
import { chatInput } from "./chat-input";
import { expectFocusIndicator } from "./focus";
/**
 * Slice 5: a scripted Planner turn through the real host tools, chat
 * projection, and sockets, against the isolated `AGENT=on` harness project.
 */
import { FAKE_MCP_PORT, PULL_REQUESTS } from "./harness/fixtures";
import { expect, ready, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page, WebSocketRoute } from "@playwright/test";
import type { Implementation } from "../packages/protocol/implementation";

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

test("a scripted Planner turn reaches read_plan and list_pull_requests through real host tools and sockets", async ({ join, page, seed }) => {
	await seed("# Harness parent\nThe harp needs new strings.\n");

	let toolFrames: Chat.Tool[] = [];
	let stateFrames: Chat.State[] = [];
	let answerFrames: Array<Chat.Message | Chat.Delta> = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind: string };
				if (frame.kind === "chat:tool") toolFrames.push(frame as Chat.Tool);
				if (frame.kind === "chat:state") stateFrames.push(frame as Chat.State);
				if (frame.kind === "chat:message" || frame.kind === "chat:delta") {
					answerFrames.push(frame as Chat.Message | Chat.Delta);
				}
			}
			route.send(message);
		});
	});

	let opened = await join("ana");
	let chat = chatPane(opened);
	let draft = chatInput(chat);
	await draft.fill("@chopin what does the plan say, and what is the latest pull request?");
	await chat.getByRole("button", { name: "Send message" }).click();

	await expect.poll(() => stateFrames.some(frame => frame.busy)).toBe(true);
	await expect.poll(() =>
		toolFrames.some(frame =>
			frame.activity.name === "read_plan" && frame.activity.status === "running"
		)
	).toBe(true);
	await expect.poll(() =>
		toolFrames.some(frame =>
			frame.activity.name === "read_plan" && frame.activity.status === "done"
		)
	).toBe(true);
	await expect.poll(() =>
		toolFrames.some(
			frame => frame.activity.name === "list_pull_requests" && frame.activity.status === "running",
		)
	).toBe(true);
	await expect.poll(() =>
		toolFrames.some(frame =>
			frame.activity.name === "list_pull_requests" && frame.activity.status === "done"
		)
	).toBe(true);

	await expect(chat.getByText("Harness parent", { exact: false })).toBeVisible();
	await expect(chat.getByText(PULL_REQUESTS[0]!.title, { exact: false })).toBeVisible();
	await expect.poll(() => stateFrames.at(-1)?.busy).toBe(false);

	let deliveredText = replyText(answerFrames);
	expect(deliveredText).toContain("Harness parent");
	expect(deliveredText).toContain(PULL_REQUESTS[0]!.title);

	let calls = await (await fetch(`http://127.0.0.1:${FAKE_MCP_PORT}/__calls__`)).json() as {
		method: string;
		toolName?: string;
		arguments?: { owner?: string; repo?: string };
		hasBearer: boolean;
		readonly: string | null;
		toolsets: string | null;
	}[];
	let listCall = calls.find(call => call.toolName === "list_pull_requests");
	expect(listCall?.hasBearer).toBe(true);
	expect(listCall?.readonly).toBe("true");
	expect(listCall?.toolsets).toBe("pull_requests");
	expect(listCall?.arguments?.owner).toBe("octo-org");
	expect(listCall?.arguments?.repo).toBe("score");
	expect(calls.some(call => call.toolName === "search_code")).toBe(false);

	await opened.reload();
	await ready(opened);
	let reloadedChat = chatPane(opened);
	await expect(reloadedChat.getByText("Harness parent", { exact: false })).toBeVisible();
	await expect(reloadedChat.getByText(PULL_REQUESTS[0]!.title, { exact: false })).toBeVisible();
});

test("a message with the Chopin chip reaches the Planner, which takes a turn, and one without it goes to the team alone", async ({ join, page, seed }) => {
	await seed("# Chip routing\nThe harp needs new strings.\n");
	let sent: Chat.Send[] = [];
	let states: Chat.State[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string" && message.includes('"chat:send"')) {
				sent.push(JSON.parse(message) as Chat.Send);
			}
			server.send(message);
		});
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind: string };
				if (frame.kind === "chat:state") states.push(frame as Chat.State);
			}
			route.send(message);
		});
	});
	let opened = await join("ana");
	let chat = chatPane(opened);
	let draft = chatInput(chat);
	let chip = chat.getByRole("group", { name: "Asking Chopin", exact: true });

	// With the chip the message is Chopin's: it goes to the Planner, which takes a turn and answers.
	await chat.getByRole("button", { name: "Ask Chopin", exact: true }).click();
	await expect(chip).toBeVisible();
	await draft.fill("what does the plan say?");
	await draft.press("Enter");
	await expect.poll(() => states.some(frame => frame.busy)).toBe(true);
	await expect(chat.getByText("Chip routing", { exact: false })).toBeVisible();
	await expect.poll(() => states.at(-1)?.busy).toBe(false);
	expect(sent.at(-1)).toMatchObject({ to: "planner", text: "@chopin what does the plan say?" });
	let turns = states.filter(frame => frame.busy).length;
	expect(turns).toBeGreaterThan(0);

	// The chip stays on, so the next is Chopin's too, until it is removed.
	await expect(chip).toBeVisible();
	await chat.getByRole("button", { name: "Remove Chopin", exact: true }).click();
	await expect(chip).toHaveCount(0);

	// Without it the message is the team's: it is in the Chat, and the Planner is not asked.
	await draft.fill("thanks, both of you");
	await draft.press("Enter");
	await expect(chat.getByText("thanks, both of you", { exact: true })).toBeVisible();
	expect(sent.at(-1)).toMatchObject({ to: "room", text: "thanks, both of you" });
	await expect.poll(() => sent.length).toBe(2);
	await expect(chat.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
	expect(states.filter(frame => frame.busy).length).toBe(turns);
});

test("tool activity redacts credential text before broadcast and history replay", async ({ join, page, seed }) => {
	await seed(
		'# Credential fixture\n\n```json\n{"password":"synthetic-password","AWS_SECRET_ACCESS_KEY":"synthetic-aws-secret","region":"eu-test-1"}\n```\n',
	);
	let frames = await recordChat(page);
	let opened = await join("ana");
	let chat = chatPane(opened);
	await chatInput(chat).fill("@chopin read the document and latest pull request");
	await chat.getByRole("button", { name: "Send message" }).click();
	await expect.poll(() =>
		frames("chat:tool").some(item =>
			item.frame.activity.name === "read_plan" && item.frame.activity.status === "done"
		)
	).toBe(true);
	let result = frames("chat:tool").find(item =>
		item.frame.activity.name === "read_plan" && item.frame.activity.status === "done"
	)!.frame.activity.result!;
	expect(result).toContain("[redacted]");
	expect(result).toContain("eu-test-1");
	let activity = JSON.stringify(frames("chat:tool"));
	expect(activity).not.toContain("synthetic-password");
	expect(activity).not.toContain("synthetic-aws-secret");
	await expect.poll(() => frames("chat:state").at(-1)?.frame.busy).toBe(false);

	await opened.reload();
	await ready(opened);
	await expect.poll(() => frames("chat:history", 2).length).toBeGreaterThan(0);
	let history = frames("chat:history", 2)[0]!.frame.entries.flatMap(entry => entry.tools ?? []);
	expect(history.find(tool => tool.name === "read_plan")?.result).toBe(result);
	expect(JSON.stringify(history)).not.toContain("synthetic-password");
	expect(JSON.stringify(history)).not.toContain("synthetic-aws-secret");
});

test("the composer addresses one message without changing the next message's destination", async ({ join, page, seed }) => {
	await seed("# Addressed turn\n\nCompare export formats.\n");
	let sent: Chat.Send[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Chat.Send;
				if (frame.kind === "chat:send") sent.push(frame);
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	let opened = await join("ana");
	let chat = chatPane(opened);
	let draft = chatInput(chat);
	await draft.fill("@chopin compare the export options");
	await chat.getByRole("button", { name: "Send message" }).click();
	await expect.poll(() => sent[0]).toMatchObject({
		text: "@chopin compare the export options",
		to: "planner",
	});
	await expect(chat.getByText(PULL_REQUESTS[0]!.title, { exact: false })).toBeVisible();
	await draft.fill("Let's discuss those options");
	await chat.getByRole("button", { name: "Send message" }).click();
	await expect.poll(() => sent[1]).toMatchObject({
		text: "Let's discuss those options",
		to: "room",
	});
});

// Frame order and arrival time are the contract; the browser UI is incidental.
type Seen = { at: number; order: number; connection: number; frame: Chat.Outgoing };

function replyText(frames: Array<Chat.Message | Chat.Delta>): string {
	let replies = new Map<string, string>();
	for (let frame of frames) {
		if (frame.kind === "chat:message" && frame.entry.author.kind === "agent") {
			replies.set(frame.entry.id, frame.entry.text);
		} else if (frame.kind === "chat:delta") {
			replies.set(frame.id, (replies.get(frame.id) ?? "") + frame.text);
		}
	}
	return [...replies.values()].join("\n");
}

async function recordChat(page: Page) {
	let seen: Seen[] = [];
	let connections = 0;
	await page.routeWebSocket("**/ws?**", route => {
		let connection = ++connections;
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Chat.Outgoing;
				if (frame.kind.startsWith("chat:")) {
					seen.push({ at: Date.now(), order: seen.length, connection, frame });
				}
			}
			route.send(message);
		});
	});
	return <K extends Chat.Outgoing["kind"]>(kind: K, connection?: number) =>
		seen.filter(item =>
			item.frame.kind === kind && (connection ?? item.connection) === item.connection
		) as Array<
			Seen & { frame: Extract<Chat.Outgoing, { kind: K }> }
		>;
}

async function sendSlowTurn(page: Page) {
	let chat = chatPane(page);
	await chatInput(chat).fill("@chopin SLOW-LIVE show your work");
	await chat.getByRole("button", { name: "Send message" }).click();
}

test("a live Planner turn streams state and a tool row that settles at its own end", async ({ join, page, seed }) => {
	await seed("# Live parent\nThe harp needs new strings.\n");
	let frames = await recordChat(page);
	let opened = await join("ana");
	await sendSlowTurn(opened);
	let replies = () =>
		frames("chat:message").filter(item =>
			item.frame.entry.author.kind === "agent" && item.frame.entry.text.trim()
		);

	await expect.poll(
		() =>
			frames("chat:state").some(item => item.frame.busy)
			&& frames("chat:state").some(item => !item.frame.busy && replies().length > 0),
		{ timeout: 20_000 },
	).toBe(true);

	let started = frames("chat:state").find(item => item.frame.busy)!;
	let turn = started.frame.turn!;
	expect(turn.startedAt).toBeGreaterThan(0);
	expect(started.order).toBeLessThan(replies()[0]!.order);
	expect(replies().at(-1)!.frame.entry.text).toBe("Streaming slowly now.");
	expect(replies().every(item => !item.frame.entry.text.includes("Considering"))).toBe(true);
	expect(frames("chat:delta").every(item => !item.frame.text.includes("Considering"))).toBe(true);

	let rows = frames("chat:tool");
	let running = rows.find(item => item.frame.activity.status === "running")!;
	let settled = rows.find(item => item.frame.activity.status === "done")!;
	expect(running.frame.activity.name).toBe("read_plan");
	expect(running.frame.activity.startedAt).toBeGreaterThanOrEqual(turn.startedAt!);
	expect(settled.frame.activity.id).toBe(running.frame.activity.id);

	// The tool ends after its own 2.5s step, well before the 7.5s turn does.
	let took = settled.frame.activity.took!;
	expect(took).toBeGreaterThanOrEqual(2_000);
	expect(took).toBeLessThan(4_500);
	expect(Math.abs(settled.at - running.at - took)).toBeLessThan(1_000);
	expect(settled.order).toBeLessThan(replies()[0]!.order);

	let idle = frames("chat:state").find(item => !item.frame.busy && item.at > started.at)!;
	expect(idle.frame.turn).toBeUndefined();
	expect(idle.at).toBeGreaterThan(settled.at);
	expect(idle.order).toBeGreaterThan(replies().at(-1)!.order);
});

test("a reconnect mid-turn restores the running tool and turn start from history without reasoning", async ({ join, page, seed }) => {
	await seed("# Live parent\nThe harp needs new strings.\n");
	let frames = await recordChat(page);
	let opened = await join("ana");
	await sendSlowTurn(opened);

	await expect.poll(() => frames("chat:tool", 1).length, { timeout: 5_000 }).toBeGreaterThan(0);
	let started = frames("chat:state", 1).find(item => item.frame.busy)!.frame.turn!;
	let running = frames("chat:tool", 1)[0]!.frame.activity;
	await opened.reload();
	await ready(opened);

	await expect.poll(() => frames("chat:history", 2).length, { timeout: 5_000 }).toBeGreaterThan(0);
	let history = frames("chat:history", 2)[0]!.frame;
	let restored = history.entries.flatMap(entry => entry.tools ?? []);
	expect(history.busy).toBe(true);
	expect(history.turn).toMatchObject({ id: started.id, startedAt: started.startedAt });
	expect(restored).toHaveLength(1);
	expect(restored[0]).toMatchObject({
		name: "read_plan",
		status: "running",
		startedAt: running.startedAt,
	});
	expect(JSON.stringify(history)).not.toContain("Considering");

	await expect.poll(() => frames("chat:state", 2).some(item => !item.frame.busy), {
		timeout: 20_000,
	}).toBe(true);
	expect(frames("chat:tool", 2).some(item => item.frame.activity.status === "done")).toBe(true);
});

/** Record the task-draft requests a page sends, and any Chat sends alongside them. */
async function recordDrafts(page: Page) {
	let drafts: Implementation.Draft[] = [];
	let sends: Chat.Send[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind: string };
				if (frame.kind === "implementation:draft") {
					drafts.push(frame as unknown as Implementation.Draft);
				}
				if (frame.kind === "chat:send") sends.push(frame as unknown as Chat.Send);
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	return { drafts, sends };
}

test("only Build plan asks the Planner for tasks, once, without a Chat message, and offers Retry", async ({ join, page, seed }) => {
	await seed("# Build draft\nThe harp needs new strings.\n");
	let { drafts, sends } = await recordDrafts(page);
	let opened = await join("ana");
	let control = opened.getByRole("group", { name: "Document view" });
	let tab = control.getByRole("button", { name: "Build", exact: true });
	let view = opened.getByRole("region", { name: "Build", exact: true });
	await expect(tab).toBeDisabled();
	await tab.click({ force: true });

	await opened.getByRole("button", { name: "Build plan", exact: true }).click();
	// Frames arrive in order, so a draft from the tab would land before Build plan's.
	await expect.poll(() => drafts.length).toBeGreaterThan(0);
	expect(drafts).toHaveLength(1);
	expect(drafts[0]!.build).toBe(true);
	expect(drafts[0]!.planRevision).toBeGreaterThanOrEqual(0);
	await expect(tab).toBeEnabled();
	// The scripted Planner answers without tasks, so the press stops with a way to retry.
	let stopped = opened.getByRole("button", { name: "Build stopped", exact: true });
	await expect(stopped).toBeVisible();
	await expect(stopped).toHaveAccessibleDescription(
		"Chopin couldn’t break the plan into tasks.",
	);
	expect(sends).toHaveLength(0);
	let transcript = chatPane(opened);
	// The notice renders its @mention as a name.
	await expect(transcript).toContainText(/asked Chopin to break the plan into tasks\./);
	await expect(transcript).not.toContainText("Prepare an implementation graph");

	await stopped.click();
	await expect(view).toBeVisible();
	await control.getByRole("button", { name: "Document", exact: true }).click();
	await tab.click();
	await opened.getByRole("button", { name: "Retry", exact: true }).click();
	// Opening Build sent nothing: the next draft is Retry's own.
	await expect.poll(() => drafts.length).toBeGreaterThan(1);
	expect(drafts).toHaveLength(2);
	expect(drafts[1]!.build).toBe(true);
	expect(drafts[1]!.planRevision).toBe(drafts[0]!.planRevision);
	expect(sends).toHaveLength(0);
});

/**
 * A reply that ends without finishing is one quiet banner by the composer, never a modal, in a
 * machine's plain words, with Retry only where sending the same turn again can help. Each way
 * the fake Planner can end a reply is named by the message that asks for it.
 */
const ENDINGS = [
	{
		kind: "error",
		prompt: "FAIL-MODEL",
		title: "Couldn't finish the reply.",
		detail: "429 Too Many Requests",
		retry: true,
	},
	{ kind: "timed-out", prompt: "FAIL-TIMEOUT", title: "The reply took too long.", retry: true },
	{
		kind: "tool",
		prompt: "FAIL-TOOL",
		title: "The reply stopped: a tool it needed isn't available.",
		retry: true,
	},
	{
		kind: "refused",
		prompt: "FAIL-REFUSED",
		title: "The reply stopped: it needed something it isn't allowed to use.",
		retry: false,
	},
] as const;
// `unreachable` (a turn that throws something that is not an Error) cannot be driven through the
// harness: it wraps whatever a turn throws into a stream error, which is told as `error`. That kind
// is pinned by `turn-failure.test.ts` and `failure.test.ts`.

/** Words that are Chopin's own, which a failure never says to a person. */
const JARGON = /boundary|approval|Planner|attach|bash|harness|Error:/i;

async function ask(page: Page, text: string): Promise<void> {
	let chat = chatPane(page);
	await chatInput(chat).fill(`@chopin ${text}`);
	await chat.getByRole("button", { name: "Send message" }).click();
}

/** How many times the Chat's words say it: the banner is the one place, the transcript's own line gives way. */
function said(text: string, words: string): number {
	return text.split(words).length - 1;
}

/** Chat is a tab of its own on a phone. */
async function openChat(page: Page): Promise<void> {
	let input = chatInput(chatPane(page));
	if (await input.isVisible()) return;
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).click();
	await expect(input).toBeVisible();
}

function chatBanner(page: Page, kind?: string) {
	return chatPane(page).locator(
		`.chat-composer [data-error-banner]${kind ? `[data-kind="${kind}"]` : ""}`,
	);
}

for (let ending of ENDINGS) {
	test(
		`a reply that ends as ${ending.kind} is one quiet banner by the composer, ${
			ending.retry ? "with Retry" : "with no button, since asking again would be refused again"
		}, and nothing else says it`,
		async ({ join, seed }) => {
			await seed("# Failing turn\nThe harp needs new strings.\n");
			let page = await join("ana");
			let chat = chatPane(page);
			await ask(page, `${ending.prompt} ${ending.kind} outline the plan`);

			let banner = chatBanner(page, ending.kind);
			await expect(banner).toHaveCount(1, { timeout: 20_000 });
			await expect(banner).toBeVisible();
			// A notice, not a modal: an alert in the composer's own place, over nothing, taking no focus.
			await expect(chat.getByRole("alert")).toHaveCount(1);
			await expect(page.getByRole("dialog")).toHaveCount(0);
			await expect(chatInput(chat)).toBeEditable();
			await expect(banner).toContainText(ending.title);
			let detail = banner.locator(".composer-notice-line");
			if ("detail" in ending) await expect(detail).toHaveText(ending.detail);
			else await expect(detail).toHaveCount(0);
			await expect(banner).not.toContainText(JARGON);
			// One cause, one banner: the connection is fine, and the failed reply's own line in the
			// transcript is what the banner stands in for, so the words are said once.
			await expect(allBanners(page)).toHaveCount(1);
			await expect(connectionBanner(page)).toHaveCount(0);
			await expect.poll(async () => said(await chat.innerText(), ending.title)).toBe(1);
			if ("detail" in ending) {
				expect(said(await chat.innerText(), ending.detail)).toBe(1);
			}
			await expect(chat).not.toContainText(JARGON);

			let retry = banner.getByRole("button", { name: "Retry", exact: true });
			if (ending.retry) await expect(retry).toBeVisible();
			else {
				await expect(banner.getByRole("button")).toHaveCount(0);
				await expect(banner.getByRole("link")).toHaveCount(0);
			}

			// It is the room's record, so it is there after a reload, said the same way.
			await page.reload();
			await ready(page);
			await expect(chatBanner(page, ending.kind)).toHaveCount(1);
			await expect(chatBanner(page, ending.kind)).toContainText(ending.title);
			await expect(allBanners(page)).toHaveCount(1);
		},
	);
}

test("Retry sends the same turn again, once, as a new request, and the banner goes with the answer", async ({ join, page, seed }) => {
	await seed("# Retried turn\nThe harp needs new strings.\n");
	let sent: Chat.Send[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Chat.Send;
				if (frame.kind === "chat:send") sent.push(frame);
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	let opened = await join("ana");
	let chat = chatPane(opened);
	let words = `FAIL-ONCE ${crypto.randomUUID()} compare the export options`;
	await ask(opened, words);
	let banner = chatBanner(opened, "error");
	await expect(banner).toContainText("Couldn't finish the reply.", { timeout: 20_000 });
	expect(sent).toHaveLength(1);
	expect(sent[0]).toMatchObject({ text: `@chopin ${words}`, to: "planner" });

	await banner.getByRole("button", { name: "Retry", exact: true }).click();
	// The same words to the same place, as a request of its own, and nothing more than one.
	await expect.poll(() => sent.length).toBe(2);
	// The room keeps the instruction without its summons, and the destination is what addresses it.
	expect(sent[1]).toMatchObject({ text: instruction(sent[0]!.text), to: sent[0]!.to });
	expect(sent[1]!.requestId).not.toBe(sent[0]!.requestId);
	expect(sent[1]!.focus).toBe(sent[0]!.focus);
	expect(sent[1]!.references).toEqual(sent[0]!.references);
	// It worked this time: the reply is in the Chat and no banner is left.
	await expect(chat.getByText(PULL_REQUESTS[0]!.title, { exact: false })).toBeVisible({
		timeout: 20_000,
	});
	await expect(failureBanner(opened)).toHaveCount(0);
	await expect(allBanners(opened)).toHaveCount(0);
	expect(sent).toHaveLength(2);
});

test("only the person who asked is offered Retry; another member reads the same failure with no button, and it goes for both with the answer", async ({ join, seed }) => {
	await seed("# Shared failure\nThe harp needs new strings.\n");
	let ana = await join("ana");
	let ben = await join("ben");
	await ask(ana, `FAIL-ONCE ${crypto.randomUUID()} shorten the summary`);
	let hers = chatBanner(ana, "error");
	let his = chatBanner(ben, "error");
	await expect(hers).toContainText("Couldn't finish the reply.", { timeout: 20_000 });
	await expect(his).toContainText("Couldn't finish the reply.");
	await expect(hers.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
	await expect(his.getByRole("button")).toHaveCount(0);
	await expect(allBanners(ben)).toHaveCount(1);
	await hers.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(chatPane(ben).getByText(PULL_REQUESTS[0]!.title, { exact: false })).toBeVisible({
		timeout: 20_000,
	});
	await expect(allBanners(ana)).toHaveCount(0);
	await expect(allBanners(ben)).toHaveCount(0);
});

for (
	let [shape, options] of [
		["desktop", undefined],
		["phone", { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } }],
	] as const
) {
	test(`the failure banner is reached and used from the keyboard, enters once and not at all under reduced motion, and has nothing axe objects to, on a ${shape}`, async ({ join, seed }) => {
		await seed("# Keyed failure\nThe harp needs new strings.\n");
		let page = await join("ana", options);
		await page.emulateMedia({ reducedMotion: "reduce" });
		let chat = chatPane(page);
		let sent = 0;
		await page.routeWebSocket("**/ws?**", route => {
			let server = route.connectToServer();
			route.onMessage(message => {
				if (typeof message === "string" && message.includes('"chat:send"')) sent++;
				server.send(message);
			});
			server.onMessage(message => route.send(message));
		});
		await page.reload();
		await ready(page);
		await openChat(page);
		await ask(page, `FAIL-ONCE ${crypto.randomUUID()} keyboard`);
		let banner = chatBanner(page, "error");
		await expect(banner).toBeVisible({ timeout: 20_000 });
		// Reduced motion: it simply appears.
		expect(await banner.evaluate(element => getComputedStyle(element).animationName)).toBe("none");

		let result = await new AxeBuilder({ page }).include("[data-error-banner]").analyze();
		expect(result.violations).toEqual([]);

		// From the keyboard: Retry is reached forward, from the Chat's own first control, and shows
		// its ring; Enter asks again.
		let retry = banner.getByRole("button", { name: "Retry", exact: true });
		await chat.getByRole("button").first().focus();
		let visited: string[] = [];
		for (let step = 0; step < 40; step++) {
			if (await retry.evaluate(element => element === document.activeElement)) break;
			await page.keyboard.press("Tab");
			visited.push(
				await page.evaluate(() => {
					let active = document.activeElement;
					return active
						? `${active.tagName}:${
							active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 20)
						}`
						: "nothing";
				}),
			);
		}
		expect(visited.at(-1) ?? "", `Tab visited ${visited.join(" > ")}`).toContain("Retry");
		await expectFocusIndicator(retry);
		await expect(banner).toBeInViewport();
		let before = sent;
		await page.keyboard.press("Enter");
		await expect.poll(() => sent).toBe(before + 1);
		await expect(chat.getByText(PULL_REQUESTS[0]!.title, { exact: false })).toBeVisible({
			timeout: 20_000,
		});
		await expect(allBanners(page)).toHaveCount(0);
	});
}

test("a failed reply waits behind the connection banner when the connection drops, and is back, unchanged, when it returns: one cause, one banner, always", async ({ join, page, seed }) => {
	test.setTimeout(90_000);
	await seed("# Cut failure\nThe harp needs new strings.\n");
	let sockets: WebSocketRoute[] = [];
	let offline = false;
	await page.routeWebSocket("**/ws?**", route => {
		if (offline) return route.close();
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => route.send(message));
		sockets.push(route);
	});
	await page.addInitScript(() => {
		Math.random = () => 0.999;
		let seen = { most: 0 };
		(window as unknown as { mostBanners: typeof seen }).mostBanners = seen;
		let count = () => {
			seen.most = Math.max(seen.most, document.querySelectorAll("[data-banner]").length);
		};
		addEventListener("DOMContentLoaded", () => {
			new MutationObserver(count).observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
			});
		});
	});
	await watchBanners(page);
	let opened = await join("ana");
	await ask(opened, `FAIL-MODEL ${crypto.randomUUID()} cut`);
	let failure = chatBanner(opened, "error");
	await expect(failure).toContainText("Couldn't finish the reply.", { timeout: 20_000 });

	offline = true;
	for (let route of sockets) await route.close();
	// The connection is the cause now, and it is the one thing said: the failure waits.
	await expect(connectionBanner(opened)).toHaveAttribute("data-layer", "socket", {
		timeout: 30_000,
	});
	await expect(failureBanner(opened)).toHaveCount(0);
	await expect(allBanners(opened)).toHaveCount(1);
	await expect(opened.getByRole("alert")).toHaveCount(0);

	offline = false;
	await opened.evaluate(() => dispatchEvent(new Event("online")));
	await expect(connectionBanner(opened)).toHaveAttribute("data-phase", "resumed", {
		timeout: 30_000,
	});
	await expect(allBanners(opened)).toHaveCount(1);
	await expect(failureBanner(opened)).toHaveCount(0);
	// The room's connection has told its own end, and then the failure is told again, as it was.
	await expect(connectionBanner(opened)).toHaveCount(0, RESUMED_WAIT);
	await expect(failure).toContainText("Couldn't finish the reply.");
	await expect(failure.locator(".composer-notice-line")).toHaveText("429 Too Many Requests");
	await expect(allBanners(opened)).toHaveCount(1);
	// At no moment, from any frame the page drew, were there two.
	expect(
		await opened.evaluate(() =>
			(window as unknown as { mostBanners: { most: number } }).mostBanners.most
		),
	).toBe(1);
	// The failure is not one of the live region's words: only the connection is spoken.
	await expect(phaseVoice(opened)).not.toContainText(/429|reply/);
});
