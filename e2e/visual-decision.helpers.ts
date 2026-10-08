import { SQL } from "bun";
import { expect } from "@playwright/test";
import { authenticate, roomPath, test as roomTest } from "./room";
import * as Room from "../apps/server/src/plan/room";
import { PostgresStorage } from "../apps/server/src/storage/postgres/adapter";
import * as VisualDecisions from "../apps/server/src/visual-decisions/state";
import type { VisualDecision } from "../packages/protocol/index";
import type { BrowserContext, Page } from "@playwright/test";

// Decisions-only documents intentionally open on Decisions, and viewers have no editable surface.
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

export function card(page: Page) {
	return page.locator('[data-document-view="decisions"]').getByRole("article", {
		name: "Visual decision",
		exact: true,
	});
}

export async function showDecisions(page: Page) {
	await page.getByRole("button", { name: /^Decisions/ }).click();
}

export async function createDecision(page: Page): Promise<string> {
	await showDecisions(page);
	await page.getByRole("button", { name: "Tune decision card", exact: true }).click();
	await expect(card(page)).toBeVisible();
	let id = await card(page).getAttribute("data-visual-decision");
	if (!id) throw new Error("Visual decision has no identity");
	await expect(card(page).getByRole("button", { name: "Save decision", exact: true }))
		.toBeEnabled();
	return id;
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

export async function state(page: Page, id: string): Promise<VisualDecision.State> {
	let reply = await request(page, { kind: "visual-decision:open", id });
	expect(reply.ok).toBe(true);
	return reply.state as VisualDecision.State;
}

export function database() {
	return new SQL(
		process.env.E2E_DATABASE_URL_0
			?? "postgresql://chopin:chopin@127.0.0.1:5433/chopin?sslmode=disable",
	);
}

export async function durableState(channelId: string) {
	let sql = database();
	try {
		let [row] = await sql<{ sidecar: string | { visualDecisions?: unknown[] } }[]>`
			SELECT sidecar FROM channel_state WHERE channel_id = ${channelId}
		`;
		return typeof row?.sidecar === "string" ? JSON.parse(row.sidecar) : row?.sidecar;
	} finally {
		await sql.close();
	}
}

export async function durableProjection(channelId: string): Promise<string> {
	let storage = new PostgresStorage(
		process.env.E2E_DATABASE_URL_0
			?? "postgresql://chopin:chopin@127.0.0.1:5433/chopin?sslmode=disable",
	);
	let document: Room.Document | undefined;
	try {
		let loaded = await storage.collaboration.load(channelId, new Date());
		if (!loaded?.snapshot) throw new Error("Durable visual decision has no checkpoint");
		// Publication follows the journal commit; its asynchronous checkpoint can still be older.
		document = await Room.restore(
			loaded.snapshot.epoch,
			loaded.snapshot.document,
			loaded.snapshot.source,
			loaded.updates,
		);
		if (!loaded.sidecar || typeof loaded.sidecar !== "object" || Array.isArray(loaded.sidecar)) {
			throw new Error("Durable visual decision has no sidecar");
		}
		VisualDecisions.validateProjections(
			VisualDecisions.restore(loaded.sidecar.visualDecisions),
			Room.questionnaireProjections(document),
		);
		return Room.project(document);
	} finally {
		document?.doc.destroy();
		await storage.close();
	}
}
