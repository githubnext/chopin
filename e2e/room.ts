/**
 * A room of one's own, per test.
 *
 * A room exists because somebody opened its URL, so isolation costs a name
 * rather than a fixture that has to create and destroy anything. That is what
 * makes the suite safe to run fully parallel against one server: two tests can
 * only collide if they choose the same name, and they do not.
 *
 * Signing in is a query parameter. `adopt()` writes `?as=` into sessionStorage
 * before React renders, so a handle in the URL means the form never appears —
 * there is no login to script, and two pages in one context are two people
 * because sessionStorage is per tab.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as Path from "node:path";

import { expect, test as base } from "@playwright/test";

import { scratch } from "./servers";

import type { Page } from "@playwright/test";

/** Server-side rule: `/^[a-z0-9][a-z0-9-]{0,63}$/`. */
function name(): string {
	return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function port(url: string): number {
	return Number(new URL(url).port);
}

type Fixtures = {
	/** The room this test has to itself. */
	room: string;
	/** Open the room as somebody. The first call uses the default page. */
	join: (handle: string) => Promise<Page>;
	/** Write the room's plan before anyone opens it. */
	seed: (source: string) => Promise<void>;
};

export const test = base.extend<Fixtures>({
	// Playwright reads a fixture's dependencies out of its destructuring
	// pattern, and refuses a first argument that is not one. A fixture that
	// depends on nothing therefore has to destructure nothing, which is the
	// empty pattern the linter is otherwise right about.
	// eslint-disable-next-line no-empty-pattern
	room: async ({}, use) => {
		await use(name());
	},

	join: async ({ context, page, room }, use) => {
		let first = true;
		await use(async handle => {
			let target = first ? page : await context.newPage();
			first = false;
			await target.goto(`/r/${room}?as=${handle}`);
			await ready(target);
			return target;
		});
	},

	seed: async ({ baseURL, room }, use) => {
		await use(async source => {
			let dir = Path.join(scratch(port(baseURL!)), room);
			await mkdir(dir, { recursive: true });
			await writeFile(Path.join(dir, "plan.mdx"), source);
		});
	},
});

export { expect };

/**
 * The editable surface.
 *
 * Not `.plan-content`: MDXEditor gives the placeholder the same class as the
 * surface it sits behind, so that selector matches two elements and only one
 * of them can be typed into. The role and the label are on the real one in
 * both states, read-only included, which is what makes them the address for a
 * thing whose whole point is that it is sometimes locked.
 */
export function content(page: Page) {
	return page.getByRole("textbox", { name: "editable markdown" });
}

/**
 * Wait until the plan can be typed into.
 *
 * `readOnly` is `offline || busy || !synced`, so an editable surface is the one
 * honest answer to "is this room open yet" — it covers the socket, the
 * document arriving, and no agent holding the turn, and it is the same fact
 * the person in front of it is waiting for.
 */
export async function ready(page: Page): Promise<void> {
	await expect(content(page)).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });
}

/** The status pane, which keeps its label in the DOM even when it draws nothing. */
export function status(page: Page) {
	return page.locator(".plan-status");
}

/** Where the server writes this room. */
export function source(page: Page, room: string): string {
	return Path.join(scratch(port(page.url())), room, "plan.mdx");
}

/**
 * Wait for canonical MDX on disk.
 *
 * The status pane says "Saved" whenever nothing is pending, including before
 * anything has been typed, so watching it cannot distinguish "written" from
 * "not yet started". The file can. This is also the assertion worth making:
 * saved is supposed to mean the source reached disk, not that the server
 * acknowledged an edit.
 */
export async function written(page: Page, room: string, text: string | RegExp): Promise<void> {
	let file = source(page, room);
	await expect
		.poll(async () => await readFile(file, "utf8").catch(() => ""), { timeout: 15_000 })
		.toMatch(text);
}
