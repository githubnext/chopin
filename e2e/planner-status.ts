/**
 * What the page says about the document's remote Planner. A healthy Planner is not mentioned. A
 * person with a machine button reads every state on it and in its menu; everyone also reads it on
 * the one connection banner at the composer's top edge, with the reason for a machine that cannot
 * be connected to drawn beneath (a person with a machine button is not told "no machine" there).
 * A screen reader hears each state once from the page's one polite live region, which is the
 * connection banner's: it speaks the room's connection and the Planner's alike, and the banner
 * and the button never announce anything themselves. These helpers read all of those.
 */
import { expect } from "@playwright/test";

import { chatInput, fillChat } from "./chat-input";

import type { Locator, Page } from "@playwright/test";

export const NONE = "No machine is connected.";

/** The banner on the composer's top edge. */
export function strip(page: Page): Locator {
	return page.locator(".chat-composer [data-connection-banner]");
}

/**
 * The page's one polite live region for the connection and the Planner's state: empty while both
 * are healthy.
 */
export function announced(page: Page): Locator {
	return page.locator("[data-connection-status]");
}

/** The machine button, named for where the document runs and what its Planner is doing. */
export function machineButton(page: Page): Locator {
	return page.getByRole("button", { name: /^Runs on/ });
}

/** Address Chopin, for tests that type to it; the Planner's state no longer depends on it. */
export async function address(page: Page, text = "@chopin are you there"): Promise<void> {
	await fillChat(chatInput(page), text);
}

/**
 * Record every word the live region is given from now on, in order, across reloads of the page.
 * Install it before the page opens, then read what a screen reader would have been told.
 */
export async function listenForAnnouncements(page: Page): Promise<void> {
	await page.addInitScript(() => {
		let heard: string[] = [];
		(window as unknown as { plannerHeard: string[] }).plannerHeard = heard;
		let last = "";
		let read = () => {
			let text = document.querySelector("[data-connection-status]")?.textContent ?? "";
			if (text === last) return;
			last = text;
			if (text) heard.push(text);
		};
		addEventListener("DOMContentLoaded", () => {
			new MutationObserver(read).observe(document.body, {
				characterData: true,
				childList: true,
				subtree: true,
			});
			read();
		});
	});
}

/** What the live region said, in order. */
export function heard(page: Page): Promise<string[]> {
	return page.evaluate(
		() => [...((window as unknown as { plannerHeard?: string[] }).plannerHeard ?? [])],
	);
}

/** Exactly one live element in the page carries `text`: the one region, not the strip or button. */
export async function expectSaidOnce(page: Page, text: string): Promise<void> {
	await expect(
		page.locator('[role="alert"], [role="status"], [aria-live]').filter({ hasText: text }),
	).toHaveCount(1);
}

/** Wait until the page knows no Planner is attached. */
export async function expectNoPlanner(page: Page): Promise<void> {
	await expect(announced(page)).toHaveText(NONE);
}

/**
 * Wait until a Planner is attached after the page knew none was: the live region has fallen
 * silent and the strip has gone, with nothing typed.
 */
export async function expectPlannerAttached(page: Page): Promise<void> {
	await expect(announced(page)).toHaveText("");
	await expect(strip(page)).toHaveCount(0);
}

/** The machine button says nothing about its Planner: named for the machine alone, no state on it. */
export async function expectHealthy(button: Locator): Promise<void> {
	await expect(button).toHaveAccessibleName(/^Runs on [^.]+$/);
	await expect(button).not.toHaveAttribute("data-planner");
}

/** What a person reads or hears of a machine and its connection, in any form it takes. */
export const MACHINE_WORDS =
	/is offline|Connecting|Your work is kept|No machine|stepped away|Last seen|disconnected|Last reported|when the machine reconnects|It carries on|Answers reach it/;

/**
 * The page says none of it while the connection banner tells the room's own connection: not in
 * what it draws, nor in what a screen reader reads or has been told: no text, label, title or
 * tooltip, and no live region. The live region is not silent now, since it speaks that
 * connection's own words; what it says carries none of the machine's.
 */
export async function expectNoMachineWords(page: Page, said: string | RegExp): Promise<void> {
	await expect(announced(page)).toHaveText(said);
	await expect(announced(page)).not.toHaveText(MACHINE_WORDS);
	await expect(page.locator("body")).not.toContainText(MACHINE_WORDS);
	let live = await page.locator('[aria-live], [role="status"], [role="alert"]').allTextContents();
	expect(live.filter(text => MACHINE_WORDS.test(text))).toEqual([]);
	let described = await page.evaluate(() =>
		[...document.querySelectorAll("[aria-label], [title], [data-tooltip]")].flatMap(element =>
			["aria-label", "title", "data-tooltip"].map(name => element.getAttribute(name) ?? "")
		)
	);
	expect(described.filter(text => MACHINE_WORDS.test(text))).toEqual([]);
}
