import { expect } from "@playwright/test";

import type { ConversationPlan } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

export type WireFrame = { kind: string; rid?: string; [key: string]: unknown };
type BrowserWire = { socket: WebSocket; frames: WireFrame[] };

/** A second real browser socket, with the same cookie and admission as the UI. */
export async function openJevWire(page: Page, channelId: string): Promise<void> {
	await page.evaluate(async id => {
		let target = window as typeof window & { __jevWire?: BrowserWire };
		target.__jevWire?.socket.close();
		let url = new URL("/ws", location.href);
		url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("channel", id);
		let socket = new WebSocket(url);
		let frames: WireFrame[] = [];
		target.__jevWire = { socket, frames };
		socket.addEventListener("message", event => {
			if (typeof event.data === "string") frames.push(JSON.parse(event.data) as WireFrame);
		});
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("Jev test socket failed")), {
				once: true,
			});
		});
		socket.send(JSON.stringify({ kind: "plan:open", ts: 0, rid: crypto.randomUUID() }));
	}, channelId);
	await expect.poll(async () =>
		(await wireFrames(page)).some(frame => frame.kind === "conversation-plan:snapshot")
	).toBe(true);
}

export async function wireFrames(page: Page): Promise<WireFrame[]> {
	return page.evaluate(() => {
		let target = window as typeof window & { __jevWire?: BrowserWire };
		return target.__jevWire?.frames ?? [];
	});
}

export async function wireState(page: Page): Promise<ConversationPlan.State | undefined> {
	let frames = await wireFrames(page);
	let latest = frames.findLast(frame =>
		frame.kind === "conversation-plan:snapshot" || frame.kind === "conversation-plan:changed"
	);
	return latest?.state as ConversationPlan.State | undefined;
}

export async function wireRequest(
	page: Page,
	frame: Omit<WireFrame, "rid">,
): Promise<WireFrame> {
	return page.evaluate(async input => {
		let target = window as typeof window & { __jevWire?: BrowserWire };
		let socket = target.__jevWire?.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Jev test socket closed");
		let rid = crypto.randomUUID();
		return await new Promise<WireFrame>((resolve, reject) => {
			let timeout = setTimeout(() => {
				socket.removeEventListener("message", onMessage);
				reject(new Error(`no reply for ${input.kind}`));
			}, 10_000);
			let onMessage = (event: MessageEvent) => {
				if (typeof event.data !== "string") return;
				let reply = JSON.parse(event.data) as WireFrame;
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

export async function sendChat(page: Page, text: string): Promise<string> {
	let reply = await wireRequest(page, {
		kind: "chat:send",
		requestId: crypto.randomUUID(),
		text,
		to: "room",
	});
	expect(reply.kind).toBe("chat:send");
	expect(reply.queued).toBe(false);
	expect(reply.id).toEqual(expect.any(String));
	return reply.id as string;
}
