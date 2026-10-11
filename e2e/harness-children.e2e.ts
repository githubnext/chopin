/**
 * The root's Chat talks to the Planner about an open child, and the Planner
 * edits that child through real host tools, storage, and sockets, against the
 * isolated `AGENT=on` fake-harness project.
 */
import { chatInput } from "./chat-input";
import { startCommentToChopin } from "./comment-input";
import { readSource, seedChildChannel } from "./database";
import { expect, test } from "./room";

import type { Page, WebSocketRoute } from "@playwright/test";
import type { Chat } from "../packages/protocol/index";

type Frame = { kind: string; rid?: string; [key: string]: unknown };

const GONE = "This comment is no longer here";

/**
 * Every document socket's frames, by channel. A frame the test injects is answered
 * to the test alone, so the page never sees a reply to a request it did not make.
 */
async function watchSockets(page: Page) {
	let sent = new Map<string, Frame[]>();
	let received = new Map<string, Frame[]>();
	let servers = new Map<string, WebSocketRoute>();
	let injected = new Set<string>();
	let record = (frames: Map<string, Frame[]>, channel: string, message: string | Buffer) => {
		if (typeof message !== "string") return undefined;
		let frame = JSON.parse(message) as Frame;
		frames.set(channel, [...frames.get(channel) ?? [], frame]);
		return frame;
	};
	await page.routeWebSocket("**/ws?**", route => {
		let channel = new URL(route.url()).searchParams.get("channel") ?? "";
		let server = route.connectToServer();
		servers.set(channel, server);
		route.onMessage(message => {
			record(sent, channel, message);
			server.send(message);
		});
		server.onMessage(message => {
			let frame = record(received, channel, message);
			if (frame?.rid && injected.has(frame.rid)) return;
			route.send(message);
		});
	});
	return {
		sent: (channel: string) => sent.get(channel) ?? [],
		received: (channel: string) => received.get(channel) ?? [],
		inject(channel: string, frame: Frame & { rid: string }) {
			injected.add(frame.rid);
			servers.get(channel)!.send(JSON.stringify(frame));
		},
		/** The Planner's tool frames finished on the root's socket. */
		done(channel: string, name: string) {
			return (received.get(channel) ?? []).some(frame =>
				frame.kind === "chat:tool"
				&& (frame as unknown as Chat.Tool).activity.name === name
				&& (frame as unknown as Chat.Tool).activity.status === "done"
			);
		},
	};
}

/** Whether any editor ever said a comment had gone, however briefly. */
async function watchForGone(page: Page) {
	await page.evaluate(gone => {
		let seen = window as unknown as { chopinGoneSeen?: boolean };
		seen.chopinGoneSeen = false;
		new MutationObserver(() => {
			if (document.body.textContent?.includes(gone)) seen.chopinGoneSeen = true;
		}).observe(document.body, { childList: true, subtree: true, characterData: true });
	}, GONE);
	return () =>
		page.evaluate(() => (window as unknown as { chopinGoneSeen?: boolean }).chopinGoneSeen);
}

function port(baseURL: string): number {
	return Number(new URL(baseURL).port);
}

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

async function openChild(page: Page, title: string, id: string) {
	await page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: title, exact: true })
		.click();
	let surface = page.getByRole("region", { name: `Child document: ${title}` });
	await expect(surface.locator(`[data-workspace-room="${id}"]`)).toBeVisible();
	return surface;
}

test("the root Planner edits the open child from the root's Chat", async ({ baseURL, join, page, room, seed }) => {
	await seed("# Harness parent\nThe harp needs new strings.\n");
	let title = `Harness child ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		title,
		"# Child report\n\nOriginal finding.\n",
	);
	let sockets = await watchSockets(page);

	let opened = await join("ana");
	let surface = await openChild(opened, title, child.id);
	// A child has no Chat of its own; the root's stays beside it.
	await expect(surface.getByRole("complementary", { includeHidden: true, name: "Chat" }))
		.toHaveCount(0);
	await expect(chatPane(opened)).toHaveCount(1);

	let chat = chatPane(opened);
	await chatInput(chat).fill("@chopin CHILD-EDIT add a note to this report");
	await chat.getByRole("button", { name: "Send message" }).click();

	let sends = () =>
		sockets.sent(room).filter(frame => frame.kind === "chat:send") as unknown as Chat.Send[];
	await expect.poll(() => sends().at(-1)?.focus).toBe(child.id);
	expect(sends().at(-1)?.to).toBe("planner");
	for (let name of ["list_children", "read_child", "edit_child"]) {
		await expect.poll(() => sockets.done(room, name)).toBe(true);
	}
	await expect(surface.getByText("Planner note from the root Chat.")).toBeVisible();
	await expect(chat.getByText("I edited the open child.")).toBeVisible();

	// The edit is durable in the child and never reached the root.
	await expect.poll(() => readSource(port(baseURL!), child.id)).toContain(
		"Planner note from the root Chat.",
	);
	expect(await readSource(port(baseURL!), room)).not.toContain("Planner note");

	// Nothing about Chat is served on the child's socket, and it refuses a Chat message.
	let childFrames = () => sockets.received(child.id);
	expect(childFrames().length).toBeGreaterThan(0);
	expect(
		childFrames().some(frame =>
			["chat:history", "chat:message", "chat:tool", "chat:delta"].includes(frame.kind)
		),
	)
		.toBe(false);
	let rid = crypto.randomUUID();
	sockets.inject(child.id, {
		kind: "chat:send",
		ts: 0,
		rid,
		requestId: crypto.randomUUID(),
		text: "Straight to the child",
		to: "planner",
	});
	await expect.poll(() => childFrames().find(frame => frame.rid === rid)).toMatchObject({
		kind: "session:error",
		message: "this document's Chat is on its root document",
	});

	let reloaded = await opened.context().newPage();
	await reloaded.goto(new URL(child.path, baseURL).href);
	await expect(reloaded.getByText("Planner note from the root Chat.")).toBeVisible();
	// The root's Chat is the one shown at a child's address.
	await expect(chatPane(reloaded).getByText("I edited the open child.")).toBeVisible();
});

test("Send to Chopin on a child comment runs on the root's Chat and replies in the child thread", async ({ baseURL, join, page, room, seed }) => {
	await seed("# Harness parent\nThe harp needs new strings.\n");
	let title = `Commented child ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		title,
		"# Child report\n\nThe tuning section is vague.\n",
	);
	let sockets = await watchSockets(page);
	let opened = await join("ana");
	let goneSeen = await watchForGone(opened);
	let surface = await openChild(opened, title, child.id);

	await startCommentToChopin(opened, surface, "tuning section", "tighten this");

	let chat = chatPane(opened);
	let notice = chat.locator("[data-chat-comment]");
	await expect(notice).toContainText("tighten this");
	await expect(chat.getByText("I replied in the comment thread.")).toBeVisible({ timeout: 20_000 });
	// The thread is in the child, so the turn read the child rather than the root.
	await expect.poll(() => sockets.done(room, "read_child")).toBe(true);
	expect(sockets.done(room, "read_plan")).toBe(false);

	let thread = opened.getByRole("dialog", { name: "Comment thread" });
	await surface.getByRole("button", { name: /^Comment on “.*”\. / }).click();
	await expect(thread.getByText("Done. I tightened the passage you marked.")).toBeVisible();
	await opened.keyboard.press("Escape");
	await expect(thread).toHaveCount(0);

	// From the root, the notice opens the child and its thread.
	await opened.keyboard.press("Escape");
	await expect(surface).toHaveCount(0);
	await expect(opened).toHaveURL(url => !url.pathname.includes("/children/"));
	await notice.click();
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	await expect(opened).toHaveURL(url => url.pathname === child.path);
	await expect(thread.getByText("Done. I tightened the passage you marked.")).toBeVisible();
	// The root's editor, still mounted beneath, never claimed the child's thread.
	await expect(opened.getByText(GONE)).toHaveCount(0);
	expect(await goneSeen()).toBe(false);
});

test("a notice for another child's thread switches to that child and opens it", async ({ baseURL, join, room, seed }) => {
	await seed("# Harness parent\nThe harp needs new strings.\n");
	let first = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		`First child ${room.slice(0, 8)}`,
		"# First report\n\nThe bridge is fine.\n",
	);
	let secondTitle = `Second child ${room.slice(0, 8)}`;
	let second = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		secondTitle,
		"# Second report\n\nThe pegs slip under tension.\n",
	);
	let opened = await join("ana");
	let goneSeen = await watchForGone(opened);

	let secondSurface = await openChild(opened, secondTitle, second.id);
	await startCommentToChopin(opened, secondSurface, "pegs slip", "say which pegs");
	let chat = chatPane(opened);
	await expect(chat.getByText("I replied in the comment thread.")).toBeVisible({ timeout: 20_000 });

	let firstSurface = await openChild(opened, `First child ${room.slice(0, 8)}`, first.id);
	await expect(secondSurface).toHaveCount(0);

	await chat.locator("[data-chat-comment]").filter({ hasText: "say which pegs" }).click();
	await expect(secondSurface.locator(`[data-workspace-room="${second.id}"]`)).toBeVisible();
	await expect(firstSurface).toHaveCount(0);
	await expect(opened).toHaveURL(url => url.pathname === second.path);
	await expect(
		opened.getByRole("dialog", { name: "Comment thread" })
			.getByText("Done. I tightened the passage you marked."),
	).toBeVisible();
	await expect(opened.getByText(GONE)).toHaveCount(0);
	expect(await goneSeen()).toBe(false);
});
