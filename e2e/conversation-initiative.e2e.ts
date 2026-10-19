import { chatInput, expectChatValue } from "./chat-input";
import { readSource, seedLinkedChildChannel } from "./database";
import { PULL_REQUESTS } from "./harness/fixtures";
import { expect, openIsolatedRoom, ready, test } from "./room";
import type { BrowserContext, Page } from "@playwright/test";
import type { Chat } from "../packages/protocol/index";

type Seen = { at: number; connection: number; frame: Chat.Outgoing };
type Sent = { at: number; frame: Chat.Incoming };

function pane(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

async function record(scope: Page | BrowserContext, loseFirstAcknowledgement = false) {
	let seen: Seen[] = [];
	let sent: Sent[] = [];
	let connections = 0;
	await scope.routeWebSocket("**/ws?**", route => {
		let connection = ++connections;
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Chat.Incoming;
				if (frame.kind.startsWith("chat:")) sent.push({ at: Date.now(), frame });
			}
			server.send(message);
		});
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Chat.Outgoing;
				if (frame.kind.startsWith("chat:")) seen.push({ at: Date.now(), connection, frame });
				if (frame.kind === "chat:send" && loseFirstAcknowledgement) {
					loseFirstAcknowledgement = false;
					server.close();
					route.close();
					return;
				}
			}
			route.send(message);
		});
	});
	return {
		seen,
		sent,
		loseNextAcknowledgement: () => loseFirstAcknowledgement = true,
		starts: () => {
			// Title jobs share state frames; response updates repeat a conversational turn's ID.
			let turns = new Map<string, { at: number; turn: Chat.Turn }>();
			for (let item of seen) {
				if (item.frame.kind !== "chat:state" || !item.frame.busy || !item.frame.turn) continue;
				let turn = item.frame.turn;
				if (turn.handle !== "chopin" && !turns.has(turn.id)) {
					turns.set(turn.id, { at: item.at, turn });
				}
			}
			return [...turns.values()];
		},
		histories: () => seen.flatMap(item => item.frame.kind === "chat:history" ? [item.frame] : []),
		sends: () => sent.flatMap(item => item.frame.kind === "chat:send" ? [item.frame] : []),
		typing: () => sent.filter(item => item.frame.kind === "chat:typing"),
	};
}

async function send(page: Page, text: string) {
	let input = chatInput(pane(page));
	await input.fill(text);
	await input.press("Enter");
	await expectChatValue(input, "");
	await expect(pane(page).getByText(text.replace(/^@chopin\s*/, ""), { exact: true }))
		.toBeVisible();
}

async function reply(page: Page) {
	await expect(pane(page).getByText(PULL_REQUESTS[0]!.title, { exact: false })).toBeVisible();
}

test(
	"every solo human turn gets one reply, including a brief acknowledgment",
	async ({ join, page, seed }, info) => {
		await seed("# Conversational initiative\n\nCompare export formats for a small pilot.\n");
		let frames = await record(page);
		await join("ana");
		await expect(pane(page).getByRole("button", { name: /automatic participation/ }))
			.toHaveCount(0);
		await send(page, "Thanks, that is clear.");
		await reply(page);
		await expect.poll(() => frames.starts().length).toBe(1);
		await expect.poll(() => frames.seen.findLast(item => item.frame.kind === "chat:state")?.frame)
			.toMatchObject({ busy: false });
		await send(page, "Can you compare the export approaches for this small pilot?");
		await reply(page);
		await expect.poll(() => frames.starts().length).toBe(2);
		expect(frames.starts()[0]!.turn.handle).toBe("Chopin");
		await page.screenshot({ path: info.outputPath("initiative-contribution.png"), fullPage: true });
		await page.waitForTimeout(1800);
		expect(frames.starts()).toHaveLength(2);
	},
);

test("two active humans get a silence window, renewed typing holds it, and blur releases it", async ({ baseURL, browser, join, page, room, seed }) => {
	await seed("# Group initiative\n\nCompare export formats for a small pilot.\n");
	let frames = await record(page);
	await join("ana");
	let peerFrames: Awaited<ReturnType<typeof record>> | undefined;
	let peer = await openIsolatedRoom(browser, baseURL!, room, "bo", {}, async context => {
		peerFrames = await record(context);
	});
	try {
		await send(peer.page, "We are discussing export formats.");
		await send(page, "INITIATIVE-USEFUL group: compare the export approaches.");
		let input = chatInput(pane(peer.page));
		let typingStart = peerFrames!.typing().length;
		await input.pressSequentially("I am still considering this", { delay: 140 });
		expect(frames.starts()).toHaveLength(0);
		let active = peerFrames!.typing().slice(typingStart).filter(item =>
			item.frame.kind === "chat:typing" && item.frame.active
		);
		expect(active.length).toBeGreaterThanOrEqual(2);
		for (let index = 1; index < active.length; index++) {
			expect(active[index]!.at - active[index - 1]!.at).toBeGreaterThanOrEqual(1900);
		}
		expect(peerFrames!.typing().every(item => !Object.hasOwn(item.frame, "text"))).toBe(true);
		await input.blur();
		await expect.poll(() => peerFrames!.typing().at(-1)?.frame).toMatchObject({ active: false });
		let stopped = peerFrames!.typing().at(-1)!.at;
		await reply(page);
		expect(frames.starts()).toHaveLength(1);
		expect(frames.starts()[0]!.at - stopped).toBeGreaterThanOrEqual(2850);
		await expectChatValue(input, "I am still considering this");
	} finally {
		await peer.close();
	}
});

test("a direct @chopin request starts while another human types and cancels the pending opportunity", async ({ baseURL, browser, join, page, room, seed }) => {
	await seed("# Direct initiative\n\nCompare export formats for a small pilot.\n");
	let frames = await record(page);
	await join("ana");
	let peer = await openIsolatedRoom(browser, baseURL!, room, "bo", {});
	try {
		await send(peer.page, "We are discussing export formats.");
		await send(page, "INITIATIVE-USEFUL pending: compare the export approaches.");
		await chatInput(pane(peer.page)).fill("I am still typing");
		await send(page, "@chopin read the document and latest pull request now");
		await reply(page);
		expect(frames.starts()).toHaveLength(1);
		expect(frames.starts()[0]!.turn.handle).toBe("ana");
		let direct = frames.sent.find(item =>
			item.frame.kind === "chat:send" && item.frame.to === "planner"
		)!;
		expect(frames.starts()[0]!.at - direct.at).toBeLessThan(900);
		await chatInput(pane(peer.page)).blur();
		await page.waitForTimeout(1800);
		expect(frames.starts()).toHaveLength(1);
	} finally {
		await peer.close();
	}
});

test("losing a send acknowledgement and retrying after reconnect never duplicates the message or initiative", async ({ join, page, seed }) => {
	await seed("# Reconnected initiative\n\nCompare export formats for a small pilot.\n");
	let frames = await record(page, true);
	await join("ana");
	let text = "INITIATIVE-USEFUL retry: compare the export approaches.";
	await chatInput(pane(page)).fill(text);
	await chatInput(pane(page)).press("Enter");
	await expect.poll(() => frames.histories().length).toBeGreaterThanOrEqual(2);
	await pane(page).getByRole("button", { name: "Retry", exact: true }).click();
	await expectChatValue(chatInput(pane(page)), "");
	expect(frames.sends()).toHaveLength(2);
	expect(frames.sends()[1]!.requestId).toBe(frames.sends()[0]!.requestId);
	await expect(pane(page).getByText(text.replace(/^@chopin\s*/, ""), { exact: true })).toHaveCount(
		1,
	);
	await page.waitForTimeout(2200);
	expect(frames.starts().length).toBeLessThanOrEqual(1);
	let count = frames.starts().length;
	await chatInput(pane(page)).fill("Keep this unsent draft after reconnect.");
	let typingBefore = frames.typing().length;
	await page.reload();
	await ready(page);
	await expect.poll(() => frames.histories().length).toBeGreaterThanOrEqual(3);
	await expectChatValue(chatInput(pane(page)), "Keep this unsent draft after reconnect.");
	await page.waitForTimeout(1800);
	expect(frames.starts()).toHaveLength(count);
	expect(frames.histories().at(-1)!.entries.filter(entry => entry.text === text)).toHaveLength(1);
	expect(
		frames.typing().slice(typingBefore).filter(item =>
			item.frame.kind === "chat:typing" && item.frame.active
		),
	).toHaveLength(0);
});

test("losing a child send acknowledgement then returning to the root and reloading preserves retry context", async ({ baseURL, join, page, room, seed }) => {
	await seed("# Reconnected initiative\n\nCompare export formats for a small pilot.\n");
	let title = `Retry child ${room.slice(0, 8)}`;
	let child = await seedLinkedChildChannel(
		Number(new URL(baseURL!).port),
		room,
		crypto.randomUUID(),
		title,
		`# ${title}\n\nOriginal finding.\n`,
	);
	let frames = await record(page, true);
	await join("ana");
	await page.getByRole("link", { name: `#${title}`, exact: true }).click();
	let surface = page.getByRole("region", { name: `Child document: ${title}` });
	await expect(surface.getByText("Original finding.", { exact: true })).toBeVisible();
	let text = "INITIATIVE-USEFUL retry: compare the export approaches.";
	await chatInput(pane(page)).fill(text);
	await chatInput(pane(page)).press("Enter");
	await expect.poll(() => frames.histories().length).toBeGreaterThanOrEqual(2);
	await page.getByRole("button", { name: "Back to Reconnected initiative", exact: true }).click();
	await expect(surface).toBeHidden();
	await page.reload();
	await ready(page);
	await expect.poll(() => frames.histories().length).toBeGreaterThanOrEqual(3);
	await chatInput(pane(page)).press("Enter");
	await expectChatValue(chatInput(pane(page)), "");
	expect(frames.sends()).toHaveLength(2);
	expect(frames.sends()[1]!.requestId).toBe(frames.sends()[0]!.requestId);
	expect(frames.sends().every(frame => frame.focus === child.id)).toBe(true);
	await expect(pane(page).getByText(text.replace(/^@chopin\s*/, ""), { exact: true })).toHaveCount(
		1,
	);
	await page.waitForTimeout(2200);
	expect(frames.starts()).toHaveLength(0);
	let count = frames.starts().length;
	await chatInput(pane(page)).fill("Keep this unsent draft after reconnect.");
	let typingBefore = frames.typing().length;
	await page.reload();
	await ready(page);
	await expect.poll(() => frames.histories().length).toBeGreaterThanOrEqual(4);
	await expectChatValue(chatInput(pane(page)), "Keep this unsent draft after reconnect.");
	await page.waitForTimeout(1800);
	expect(frames.starts()).toHaveLength(count);
	expect(frames.histories().at(-1)!.entries.filter(entry => entry.text === text)).toHaveLength(1);
	expect(
		frames.typing().slice(typingBefore).filter(item =>
			item.frame.kind === "chat:typing" && item.frame.active
		),
	).toHaveLength(0);
});

test("a mentioned request keeps its prepared destination after a lost acknowledgement and reload", async ({ join, page, seed }) => {
	await seed("# Retried direct request\n\nCompare export formats for a small pilot.\n");
	let frames = await record(page, true);
	await join("ana");
	let input = chatInput(pane(page));
	let text = "@chopin Compare the document and latest pull request";
	await input.fill(text);
	await input.press("Enter");
	await expect.poll(() => frames.histories().length).toBeGreaterThanOrEqual(2);
	await page.reload();
	await ready(page);
	await expect.poll(() => frames.histories().length).toBeGreaterThanOrEqual(3);
	await expectChatValue(input, text);
	await input.press("Enter");
	await expectChatValue(input, "");
	expect(frames.sends()).toHaveLength(2);
	let [first, retry] = frames.sends();
	expect(first).toMatchObject({ text, to: "planner" });
	expect(retry).toMatchObject({
		requestId: first!.requestId,
		text: first!.text,
		to: first!.to,
	});
	expect(retry!.focus).toBe(first!.focus);
	expect(retry!.references).toEqual(first!.references);
	await expect(pane(page).getByText(text.replace(/^@chopin\s*/, ""), { exact: true })).toHaveCount(
		1,
	);
	await reply(page);
	await page.waitForTimeout(1800);
	expect(frames.starts().length).toBeLessThanOrEqual(1);
	let next = "Compare the export options for an updated brief";
	frames.loseNextAcknowledgement();
	await input.fill(next);
	await input.press("Enter");
	await expect.poll(() => frames.histories().length).toBeGreaterThanOrEqual(4);
	await page.reload();
	await ready(page);
	await expect.poll(() => frames.histories().length).toBeGreaterThanOrEqual(5);
	await expectChatValue(input, next);
	await input.fill(`${next}, including Markdown`);
	await input.press("Enter");
	await expectChatValue(input, "");
	expect(frames.sends()).toHaveLength(4);
	let [interrupted, edited] = frames.sends().slice(2);
	expect(edited).toMatchObject({ text: `${next}, including Markdown`, to: "room" });
	expect(edited!.requestId).not.toBe(interrupted!.requestId);
});

test("a Planner reply after a pending human message prevents a second automatic turn", async ({ join, page, seed }) => {
	await seed("# Racing initiative\n\nCompare export formats for a small pilot.\n");
	let frames = await record(page);
	await join("ana");
	await send(page, "@chopin SLOW-LIVE show your work");
	await expect.poll(() => frames.starts().length).toBe(1);
	await send(page, "INITIATIVE-USEFUL race: compare the export approaches.");
	await expect.poll(() =>
		frames.seen.some(item =>
			item.frame.kind === "chat:tool" && item.frame.activity.name === "read_plan"
			&& item.frame.activity.status === "done"
		)
	).toBe(true);
	expect(frames.starts()).toHaveLength(1);
	await expect.poll(
		() => frames.seen.findLast(item => item.frame.kind === "chat:state")?.frame,
		{ timeout: 20000 },
	).toMatchObject({ busy: false });
	await page.waitForTimeout(3500);
	expect(frames.starts()).toHaveLength(1);
});

test("ordinary child discussion stays quiet while natural direct requests preserve focus", async ({ baseURL, join, page, room, seed }) => {
	await seed("# Focused initiative root\n\nCompare export formats for a small pilot.\n");
	let title = `Focused child ${room.slice(0, 8)}`;
	let port = Number(new URL(baseURL!).port);
	let child = await seedLinkedChildChannel(
		port,
		room,
		crypto.randomUUID(),
		title,
		`# ${title}\n\nOriginal finding.\n`,
	);
	let frames = await record(page);
	await join("ana");
	await page.getByRole("link", { name: `#${title}`, exact: true }).click();
	let surface = page.getByRole("region", { name: `Child document: ${title}` });
	await expect(surface.getByText("Original finding.", { exact: true })).toBeVisible();
	await send(page, "INITIATIVE-USEFUL focused child: compare the export approaches.");
	expect(frames.sends().at(-1)).toMatchObject({ to: "room", focus: child.id });
	await page.waitForTimeout(2200);
	expect(frames.starts()).toHaveLength(0);
	await send(page, "Chopin, can you CHILD-EDIT add a note to this report?");
	await expect(surface.getByText("Planner note from the root Chat.", { exact: true }))
		.toBeVisible();
	expect(frames.sends().at(-1)).toMatchObject({ to: "room", focus: child.id });
	await expect.poll(() => readSource(port, child.id)).toContain("Planner note from the root Chat.");
	expect(await readSource(port, room)).not.toContain("Planner note");
	await page.getByRole("button", { name: "Back to Focused initiative root", exact: true }).click();
	await expect(surface).toBeHidden();
	await send(page, "INITIATIVE-USEFUL returned root: compare the export approaches.");
	expect(frames.sends().at(-1)?.focus).toBeUndefined();
	await reply(page);
	expect(frames.starts()).toHaveLength(2);
	expect(frames.starts().at(-1)!.turn.handle).toBe("Chopin");
});

test("plain-language direct requests get a prompt reply", async ({ baseURL, browser, join, page, room, seed }) => {
	await seed("# Direct conversation\n\nCompare export formats.\n");
	let frames = await record(page);
	await join("ana");
	let peer = await openIsolatedRoom(browser, baseURL!, room, "bo", {});
	try {
		await send(peer.page, "We are discussing export formats.");
		let sent = Date.now();
		await send(page, "Chopin, can you compare the export approaches?");
		await expect.poll(() => frames.starts().length).toBe(1);
		expect(frames.starts()[0]!.at - sent).toBeLessThan(2850);
		await reply(page);
		await page.waitForTimeout(3500);
		expect(frames.starts()).toHaveLength(1);
	} finally {
		await peer.close();
	}
});
