/** A database-backed channel of one's own, per test. */

import { expect, test as base } from "@playwright/test";
import { appendFileSync } from "node:fs";

import {
	createChannel,
	readSource,
	seedChannel,
	seedLegacyCalloutChannel,
	testChannelPath,
} from "./database";

import type { SeedState } from "../apps/server/src/testing/plan";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "@playwright/test";

/** Passive, bounded startup evidence for the contained readonly case. */
function observeReaderStartup(page: Page): void {
	let remaining = 200;
	let cleanups: (() => void)[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	let sockets = 0;
	let errors = 0;
	let consoles = 0;
	let emit = (value: unknown, final = false) => {
		if (remaining <= (final ? 0 : 1)) return;
		remaining--;
		try {
			appendFileSync(
				new URL("./test-results/conversation-plan/reader-startup.jsonl", import.meta.url),
				JSON.stringify(value) + "\n",
			);
		} catch {}
	};
	let stop = () => {
		clearTimeout(timer);
		clearTimeout(deadline);
		remaining = 0;
		for (let cleanup of cleanups.splice(0)) cleanup();
	};
	let websocket = (socket: import("@playwright/test").WebSocket) => {
		if (++sockets > 16) return;
		for (let direction of ["framesent", "framereceived"] as const) {
			let frame = ({ payload }: { payload: string | Buffer }) => {
				try {
					if (payload.length > 1_000_000 || remaining <= 0) return;
					let value = JSON.parse(payload.toString());
					emit({
						direction,
						kind: typeof value.kind === "string" && /^[a-z-]{1,32}:[a-z-]{1,32}$/.test(value.kind)
							? value.kind
							: "other",
						rid: typeof value.rid === "string" && /^[a-f0-9-]{1,64}$/i.test(value.rid)
							? value.rid
							: undefined,
						epoch: typeof value.epoch === "string" && /^[a-f0-9-]{1,64}$/i.test(value.epoch)
							? value.epoch
							: undefined,
						updateLength: typeof value.update === "string" ? value.update.length : undefined,
					});
				} catch {}
			};
			if (direction === "framesent") {
				socket.on("framesent", frame);
				cleanups.push(() => socket.off("framesent", frame));
			} else {
				socket.on("framereceived", frame);
				cleanups.push(() => socket.off("framereceived", frame));
			}
		}
	};
	let error = (value: Error) =>
		emit({
			pageErrors: ++errors,
			name: ["Error", "TypeError", "ReferenceError", "SyntaxError"].includes(value.name)
				? value.name
				: "other",
		});
	let console = () => {
		consoles++;
	};
	let loaded = () => {
		deadline = setTimeout(stop, 4000);
		timer = setTimeout(() => {
			void page.evaluate(() => {
				let editors = Array.from(
					document.querySelectorAll(".plan-content,[aria-label='editable markdown']"),
				);
				let statusText = document.querySelector(".plan-status > span:not([aria-hidden])")
					?.textContent?.trim();
				let status =
					["Loading", "Ready", "Reconnecting", "Could not open the plan", "Agent is working"].find(
						label => label === statusText,
					) ?? "other";
				return {
					status,
					editors: editors.slice(0, 4).map(element => ({
						role: element.getAttribute("role") === "textbox" ? "textbox" : "other",
						contenteditable: element.getAttribute("contenteditable") === "false"
							? "false"
							: element.getAttribute("contenteditable") === "true"
							? "true"
							: null,
						hidden: !element.getClientRects().length,
						inertAncestor: !!element.closest("[inert],[hidden],[aria-hidden='true']"),
						nodes: element.childNodes.length,
					})),
					editorCount: editors.length,
					statusCount: document.querySelectorAll(".plan-status").length,
					statusNonempty: Array.from(document.querySelectorAll(".plan-status")).some(element =>
						!!element.textContent?.trim()
					),
					hasFixtureQuestion: document.body.textContent?.includes("Should we ship a small pilot?")
						?? false,
					chatMessages: document.querySelectorAll("[data-chat-message-id]").length,
				};
			}).then(dom => emit({ dom, pageErrors: errors, consoleCount: consoles }, true)).catch(
				() => {},
			).finally(stop);
		}, 3000);
	};
	page.on("websocket", websocket).on("pageerror", error).on("console", console).once(
		"domcontentloaded",
		loaded,
	).once("close", stop);
	cleanups.push(() => {
		page.off("websocket", websocket).off("pageerror", error).off("console", console).off(
			"domcontentloaded",
			loaded,
		).off("close", stop);
	});
}

function port(url: string): number {
	return Number(new URL(url).port);
}

export async function authenticate(
	page: Page,
	handle: string,
	baseURL: string,
	returnTo?: string,
): Promise<string> {
	let login = new URL("/auth/github", baseURL);
	if (returnTo) login.searchParams.set("return_to", returnTo);
	let started = await fetch(login, { redirect: "manual" });
	expect(started.status).toBe(302);
	let authorization = new URL(started.headers.get("location")!);
	let state = authorization.searchParams.get("state");
	expect(state).toBeTruthy();
	let stateCookie = (started.headers as Headers & { getSetCookie(): string[] })
		.getSetCookie()[0]!.split(";", 1)[0]!;
	let callback = await fetch(
		`${baseURL}/auth/github/callback?code=e2e-${encodeURIComponent(handle)}&state=${
			encodeURIComponent(state!)
		}`,
		{ headers: { cookie: stateCookie }, redirect: "manual" },
	);
	expect(callback.status).toBe(303);
	let session = (callback.headers as Headers & { getSetCookie(): string[] })
		.getSetCookie().find(value => value.startsWith("chopin_session="));
	expect(session).toBeTruthy();
	let [name, value] = session!.split(";", 1)[0]!.split("=", 2);
	await page.context().addCookies([{ name: name!, value: value!, url: baseURL }]);
	if (process.env.E2E_CONVERSATION_PLAN === "1" && handle === "readonly") {
		try {
			observeReaderStartup(page);
		} catch {}
	}
	return callback.headers.get("location")!;
}

/** Open a room in a context that needs setup before navigation. */
export async function openIsolatedRoom(
	browser: Browser,
	baseURL: string,
	room: string,
	handle: string,
	options: BrowserContextOptions,
	beforeNavigation?: (context: BrowserContext) => Promise<void>,
): Promise<{ close: () => Promise<void>; context: BrowserContext; page: Page }> {
	let context = await browser.newContext({ ...options, baseURL });
	try {
		await beforeNavigation?.(context);
		let page = await context.newPage();
		await authenticate(page, handle, baseURL);
		await page.goto(testChannelPath(room));
		await ready(page);
		return { close: () => context.close(), context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}

type Fixtures = {
	/** The channel this test has to itself. */
	room: string;
	/** Open the channel as somebody. Options always receive an isolated context. */
	join: (handle: string, options?: BrowserContextOptions) => Promise<Page>;
	/** Set the channel's source and optional sidecar before anyone opens it. */
	seed: (source: string, state?: SeedState) => Promise<void>;
	/** Seed the direct-text callout shape written by the original client. */
	seedLegacyCallout: (source: string) => Promise<void>;
};

export const test = base.extend<Fixtures>({
	room: async ({ baseURL }, use) => {
		let id = crypto.randomUUID();
		await createChannel(port(baseURL!), id);
		await use(id);
	},

	join: async ({ baseURL, browser, context, page, room }, use) => {
		let first = true;
		let opened: BrowserContext[] = [];
		await use(async (handle, options) => {
			let target: Page;
			if (first && !options) {
				first = false;
				target = page;
			} else {
				first = false;
				let isolated = await browser.newContext({ ...options, baseURL });
				opened.push(isolated);
				target = await isolated.newPage();
			}
			await authenticate(target, handle, baseURL!);
			await target.goto(testChannelPath(room));
			await ready(target);
			return target;
		});
		await Promise.all(opened.map(item => item.close()));
		await context.clearCookies();
	},

	seed: async ({ baseURL, room }, use) => {
		await use((source, state) => seedChannel(port(baseURL!), room, source, state));
	},

	seedLegacyCallout: async ({ baseURL, room }, use) => {
		await use(source => seedLegacyCalloutChannel(port(baseURL!), room, source));
	},
});

export { expect };
export { testChannelPath as roomPath } from "./database";

/** The editable surface. */
export function content(page: Page) {
	return page.getByRole("textbox", { name: "editable markdown" });
}

/** Wait until the channel has synchronized and can be typed into. */
export async function ready(page: Page): Promise<void> {
	await expect(content(page)).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });
}

/** The status pane, which keeps its label in the DOM even when it draws nothing. */
export function status(page: Page) {
	return page.locator(".plan-status");
}

/** Wait for canonical MDX to reach the durable checkpoint. */
export async function written(page: Page, room: string, text: string | RegExp): Promise<void> {
	await expect
		.poll(() => readSource(port(page.url()), room), { timeout: 15_000 })
		.toMatch(text);
}
