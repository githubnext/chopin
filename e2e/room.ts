/** A database-backed channel of one's own, per test. */

import { expect, test as base } from "@playwright/test";

import { createChannel, readSource, seedChannel } from "./database";

import type { SeedState } from "../apps/server/src/testing/plan";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "@playwright/test";

function port(url: string): number {
	return Number(new URL(url).port);
}

export async function authenticate(page: Page, handle: string, baseURL: string): Promise<void> {
	let started = await fetch(`${baseURL}/auth/github`, { redirect: "manual" });
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
		await page.goto(`/channels/${room}`);
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
			await target.goto(`/channels/${room}`);
			await ready(target);
			return target;
		});
		await Promise.all(opened.map(item => item.close()));
		await context.clearCookies();
	},

	seed: async ({ baseURL, room }, use) => {
		await use((source, state) => seedChannel(port(baseURL!), room, source, state));
	},
});

export { expect };

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
