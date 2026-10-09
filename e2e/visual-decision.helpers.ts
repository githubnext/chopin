import { SQL } from "bun";
import { expect } from "@playwright/test";
import { authenticate, roomPath, test as roomTest } from "./room";

import type { VisualDecision } from "../packages/protocol/index";
import type { BrowserContext, Page } from "@playwright/test";

export let test = roomTest.extend({
	join: async ({ baseURL, browser, context, page, room }, use) => {
		let first = true;
		let opened: BrowserContext[] = [];
		await use(async (handle, options) => {
			let target = page;
			if (!first || options) {
				let isolated = await browser.newContext({ ...options, baseURL });
				opened.push(isolated);
				target = await isolated.newPage();
			}
			first = false;
			await authenticate(target, handle, baseURL!);
			await target.goto(roomPath(room));
			await expect(target.getByRole("group", { name: "Document view", exact: true }))
				.toBeVisible();
			return target;
		});
		await Promise.all(opened.map(item => item.close()));
		await context.clearCookies();
	},
});

type WireFrame = { kind: string; rid?: string; [key: string]: unknown };
type BrowserWire = { socket: WebSocket; frames: WireFrame[] };

export function card(page: Page, title: string) {
	return page.locator('[data-document-view="decisions"]').getByRole("article", {
		name: "Visual decision",
		exact: true,
	}).filter({ hasText: title });
}

export async function showDecisions(page: Page) {
	await page.getByRole("button", { name: /^Decisions/ }).click();
}

export async function openWire(page: Page, channelId: string): Promise<void> {
	await page.evaluate(async id => {
		let target = window as typeof window & { __visualWire?: BrowserWire };
		target.__visualWire?.socket.close();
		let url = new URL("/ws", location.href);
		url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("channel", id);
		let socket = new WebSocket(url);
		let frames: WireFrame[] = [];
		target.__visualWire = { socket, frames };
		socket.addEventListener("message", event => {
			if (typeof event.data === "string") frames.push(JSON.parse(event.data) as WireFrame);
		});
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("Visual test socket failed")), {
				once: true,
			});
		});
	}, channelId);
	await request(page, { kind: "plan:open" });
}

export async function request(page: Page, frame: Omit<WireFrame, "rid">): Promise<WireFrame> {
	return page.evaluate(async input => {
		let target = window as typeof window & { __visualWire?: BrowserWire };
		let socket = target.__visualWire?.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			throw new Error("Visual test socket closed");
		}
		let rid = crypto.randomUUID();
		return await new Promise<WireFrame>((resolve, reject) => {
			let timeout = setTimeout(() => {
				socket.removeEventListener("message", onMessage);
				reject(new Error(`No reply for ${input.kind}`));
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

export async function state(page: Page, id: string): Promise<VisualDecision.State> {
	let reply = await request(page, { kind: "visual-decision:open", id });
	expect(reply.ok).toBe(true);
	return reply.state as VisualDecision.State;
}

export async function durableState(channelId: string) {
	let sql = new SQL(process.env.E2E_DATABASE_URL_0!);
	try {
		let [row] = await sql<{ sidecar: string | { visualDecisions?: unknown[] } }[]>`
			SELECT sidecar FROM channel_state WHERE channel_id = ${channelId}
		`;
		return typeof row?.sidecar === "string" ? JSON.parse(row.sidecar) : row?.sidecar;
	} finally {
		await sql.close();
	}
}
