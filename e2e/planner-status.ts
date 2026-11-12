/**
 * What the page says about the document's remote Planner. A healthy Planner is not mentioned, and
 * Chat never draws its state: a person with a machine button reads every state in its dot and name
 * and the steps to fix it in its menu, chopin's avatar carries the same presence, and a message
 * chopin cannot take is its ephemeral row. A screen reader hears each state once from the page's
 * one polite live region, which speaks the room's connection and the Planner's alike (a person with
 * a machine button is not told "no machine" there); the button never announces anything itself.
 * These helpers read all of those.
 */
import { expect } from "@playwright/test";

import { chatInput, fillChat } from "./chat-input";

import type { Locator, Page } from "@playwright/test";

export const NONE = "No machine is connected.";

/**
 * Whatever the page draws of a connection: only the offline bar, for the room's own socket. The
 * Planner's machine is never drawn there, so for it this is always empty.
 */
export function strip(page: Page): Locator {
	return page.locator("[data-connection-banner]");
}

/**
 * The page tells `text` of the Planner's machine: in the machine button's name and tooltip where the
 * person has a button, and from the page's live region where they have none. Nothing of it is drawn
 * in Chat either way.
 */
export async function expectTold(page: Page, text: string | RegExp): Promise<void> {
	let button = machineButton(page);
	if (await button.count() > 0) {
		let words = typeof text === "string"
			? new RegExp(`\\. ${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
			: new RegExp(`\\. ${text.source.replace(/^\^/, "")}`);
		await expect(button).toHaveAttribute("data-tooltip", words);
		await expect(button).toHaveAccessibleName(words);
	} else {
		await expect(announced(page)).toContainText(text);
	}
	await expect(strip(page)).toHaveCount(0);
}

/** chopin's ephemeral row: a message it could not take, said to this person alone. */
export function quietNote(page: Page): Locator {
	return page.locator("[data-quiet-note]");
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
 * silent and nothing is drawn, with nothing typed.
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

/** The connecting dots inside `within`: the banner's icon or the machine button's badge. */
export function connectingDots(within: Locator): Locator {
	return within.locator("[data-connecting]");
}

/**
 * The dots brighten in turn: each runs the one endless wave, by opacity alone, a step after the one
 * before it, so nothing turns, grows or moves.
 */
export async function expectConnectingWave(dots: Locator): Promise<void> {
	await expect(dots).toBeVisible();
	let waves = await dots.evaluate(indicator =>
		[...indicator.querySelectorAll(".connecting-dot")].map(dot =>
			dot.getAnimations().map(animation => {
				let effect = animation.effect as KeyframeEffect;
				return {
					name: (animation as CSSAnimation).animationName,
					state: animation.playState,
					iterations: effect.getComputedTiming().iterations,
					delay: effect.getTiming().delay,
					changes: [
						...new Set(
							effect.getKeyframes().flatMap(frame =>
								Object.keys(frame).filter(key =>
									!["offset", "computedOffset", "easing", "composite"].includes(key)
								)
							),
						),
					],
				};
			})
		)
	);
	expect(waves).toEqual([0, 200, 400].map(delay => [{
		name: "connecting-wave",
		state: "running",
		iterations: Infinity,
		delay,
		changes: ["opacity"],
	}]));
}

/**
 * Under reduced motion the dots hold still, stepped from faint to full: an ellipsis, which reads as
 * under way with nothing moving.
 */
export async function expectConnectingStill(dots: Locator): Promise<void> {
	await expect(dots).toBeVisible();
	await expect.poll(() =>
		dots.evaluate(indicator =>
			[...indicator.querySelectorAll(".connecting-dot")].map(dot => ({
				moving: dot.getAnimations().length,
				opacity: getComputedStyle(dot).opacity,
			}))
		)
	).toEqual([
		{ moving: 0, opacity: "0.35" },
		{ moving: 0, opacity: "0.65" },
		{ moving: 0, opacity: "1" },
	]);
}

/**
 * Over one whole wave and a little more, every frame lays out `targets` exactly where the first did:
 * the dots, and what is around them, never shift. It starts once every entrance has finished (the
 * banner's own slide in moves all of it together); the dots' wave never finishes, by design.
 */
export async function expectSteadyLayout(targets: Locator[]): Promise<void> {
	let handles = await Promise.all(targets.map(target => target.elementHandle()));
	let page = targets[0]!.page();
	let boxes = await page.evaluate(async elements => {
		await Promise.all(
			document.getAnimations()
				.filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
				.map(animation => animation.finished.catch(() => undefined)),
		);
		let seen = new Set<string>();
		let end = performance.now() + 1_400;
		while (performance.now() < end) {
			seen.add(JSON.stringify(elements.map(element => {
				let box = element!.getBoundingClientRect();
				return [box.x, box.y, box.width, box.height];
			})));
			await new Promise(resolve => requestAnimationFrame(resolve));
		}
		return [...seen];
	}, handles);
	expect(boxes).toHaveLength(1);
}
