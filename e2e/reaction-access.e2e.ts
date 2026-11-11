/**
 * A reaction is asked of a viewer, so the server does not take it on the strength of the socket's
 * admission: `chat:react` asks again, as the server does for every other request, whether this
 * person may still read the document. A person whose access is gone, or cannot be confirmed, is
 * refused, and nothing they sent is saved or told to the room.
 *
 * The server trusts an admission for a minute before it asks GitHub again, so these tests wait that
 * long for the socket's check to fall due. The fake GitHub answers for the reader as its gate file
 * says (see `e2e/github.ts`).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import { authenticate, expect, test } from "./room";

import type { Page } from "@playwright/test";

const TARGET = { id: "reaction-access", text: "The cache is keyed by the request path." };

type Frame = { kind: string; rid?: string; code?: string; message?: string };

async function connect(page: Page, channelId: string): Promise<void> {
	await page.evaluate(async id => {
		let target = window as typeof window & { __access?: { socket: WebSocket; closed?: number } };
		let url = new URL("/ws", location.href);
		url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("channel", id);
		let socket = new WebSocket(url);
		let state: { socket: WebSocket; closed?: number } = { socket };
		target.__access = state;
		socket.addEventListener("close", event => {
			state.closed = event.code;
		});
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("reader socket failed")), {
				once: true,
			});
		});
	}, channelId);
	expect((await ask(page, { kind: "plan:open" })).kind).toBe("plan:open");
}

async function ask(page: Page, frame: { kind: string; [key: string]: unknown }): Promise<Frame> {
	return page.evaluate(async input => {
		let socket = (window as typeof window & { __access?: { socket: WebSocket } }).__access
			?.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("reader socket is closed");
		let rid = crypto.randomUUID();
		return await new Promise<Frame>((resolve, reject) => {
			let timeout = setTimeout(() => {
				socket.removeEventListener("message", onMessage);
				reject(new Error(`no reply for ${input.kind}`));
			}, 15_000);
			let onMessage = (event: MessageEvent) => {
				if (typeof event.data !== "string") return;
				let reply = JSON.parse(event.data) as Frame;
				if (reply.rid !== rid) return;
				clearTimeout(timeout);
				socket.removeEventListener("message", onMessage);
				resolve(reply);
			};
			socket.addEventListener("message", onMessage);
			socket.send(JSON.stringify({ ...input, rid, ts: 0 }));
		});
	}, frame);
}

function react(page: Page, emoji: string, on: boolean): Promise<Frame> {
	return ask(page, { kind: "chat:react", id: TARGET.id, emoji, on });
}

test("a reaction from a socket whose read access is gone, or cannot be confirmed, is refused, and neither saved nor told to the room", async ({ baseURL, browser, join, room, seed }) => {
	test.setTimeout(240_000);
	await seed("# Reaction access\n", {
		transcript: [{
			id: TARGET.id,
			author: { kind: "member", handle: "ben" },
			text: TARGET.text,
			ts: 1_700_000_001,
		}],
	});
	let watcher = await join("ana");
	let shown = watcher.getByRole("complementary", { name: "Chat", exact: true })
		.locator(`[data-chat-message-id="${TARGET.id}"]`);
	await expect(shown).toBeVisible();

	let handle = `gated-access-${room.slice(0, 8)}`;
	let gate = joinPath(tmpdir(), "chopin-e2e-access", handle);
	await mkdir(joinPath(tmpdir(), "chopin-e2e-access"), { recursive: true });
	await rm(gate, { force: true });
	let context = await browser.newContext({ baseURL });
	try {
		let reader = await context.newPage();
		await authenticate(reader, handle, baseURL!);
		expect((await reader.goto(`${baseURL}/api/session`))?.status()).toBe(200);
		await connect(reader, room);

		// While the admission is fresh the reader may react, which shows the socket and the frame
		// are sound: what follows is refused for the access, not for the way it was asked.
		expect((await react(reader, "🦄", true)).kind).toBe("chat:react");
		await expect(shown.locator('[data-chat-reaction="🦄"]')).toHaveText("🦄1");
		expect((await react(reader, "🦄", false)).kind).toBe("chat:react");
		await expect(shown.locator('[data-chat-reaction="🦄"]')).toHaveCount(0);

		// GitHub cannot be reached. The server asks it once the minute is up; taking back a reaction
		// that was never there changes nothing, so it is the probe that waits for that.
		await writeFile(gate, "unavailable");
		await expect.poll(async () => (await react(reader, "🦄", false)).kind, {
			intervals: [2_000],
			timeout: 100_000,
		}).toBe("session:error");
		let unconfirmed = await react(reader, "🦄", true);
		expect(unconfirmed).toMatchObject({
			kind: "session:error",
			code: "temporarily-unavailable",
			message: "authorization is temporarily unavailable",
		});
		// A passing trouble leaves the socket open for the next ask.
		expect(
			await reader.evaluate(() =>
				(window as typeof window & { __access: { closed?: number } }).__access.closed
			),
		).toBeUndefined();

		// Now GitHub answers, and the reader no longer has the repository.
		await writeFile(gate, "revoked");
		let revoked = await react(reader, "🦄", true);
		expect(revoked).toMatchObject({ kind: "session:error", message: "authorization expired" });
		expect(revoked).not.toHaveProperty("code");
		await expect.poll(() =>
			reader.evaluate(() =>
				(window as typeof window & { __access: { closed?: number } }).__access.closed
			)
		).toBe(4403);
	} finally {
		await rm(gate, { force: true });
		await context.close();
	}

	// The room heard nothing of either refusal. What ana's own reaction brings is the barrier: it is
	// told after any earlier broadcast, so a reaction wrongly kept would be on the message by then.
	await shown.hover();
	await shown.getByRole("toolbar", { name: "Reactions and actions" }).getByRole("button", {
		name: "Looks right",
	}).click();
	await expect(shown.getByRole("button", { name: "You reacted with ✅" })).toHaveText("✅1");
	await expect(shown.locator("[data-chat-reaction]")).toHaveCount(1);
	// And it was never saved: the Chat opened again is read from what the server keeps.
	await watcher.reload();
	let saved = watcher.getByRole("complementary", { name: "Chat", exact: true })
		.locator(`[data-chat-message-id="${TARGET.id}"]`);
	await expect(saved.getByRole("button", { name: "You reacted with ✅" })).toHaveText("✅1");
	await expect(saved.locator("[data-chat-reaction]")).toHaveCount(1);
});
