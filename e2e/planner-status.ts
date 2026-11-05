/**
 * What the page says about the document's remote Planner. A healthy Planner is not mentioned. The
 * machine button always carries its state, but only a person with a machine has one; the composer
 * says what is wrong with a Planner that cannot start, and says what is wrong with any other only
 * while a message is addressed to Chopin, since that is the one time it matters. These helpers
 * address Chopin to read that.
 */
import { expect } from "@playwright/test";

import { chatInput, fillChat } from "./chat-input";

import type { Locator, Page } from "@playwright/test";

export const NONE = "No Planner is attached. @chopin needs one to reply.";

/** The strip on the composer's top edge. */
export function strip(page: Page): Locator {
	return page.locator(".chat-composer .composer-notice");
}

/** The machine button, named for where the document runs and what its Planner is doing. */
export function machineButton(page: Page): Locator {
	return page.getByRole("button", { name: /^Runs on/ });
}

/** Address Chopin, and leave the draft that way for the strip to speak about it. */
export async function address(page: Page, text = "@chopin are you there"): Promise<void> {
	await fillChat(chatInput(page), text);
}

/** Wait until the page knows no Planner is attached, then leave the draft empty again. */
export async function expectNoPlanner(page: Page): Promise<void> {
	await address(page);
	await expect(strip(page)).toHaveText(NONE);
	await fillChat(chatInput(page), "");
	await expect(strip(page)).toHaveCount(0);
}

/** Wait until the page knows a Planner is attached, then leave the draft empty again. */
export async function expectPlannerAttached(page: Page): Promise<void> {
	await address(page);
	await expect(strip(page)).toHaveCount(0);
	await fillChat(chatInput(page), "");
}

/** The machine button says nothing about its Planner: named for the machine alone, no state on it. */
export async function expectHealthy(button: Locator): Promise<void> {
	await expect(button).toHaveAccessibleName(/^Runs on [^.]+$/);
	await expect(button).not.toHaveAttribute("data-planner");
}
