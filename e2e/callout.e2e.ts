/** Browser-owned callout behavior: focus, composition and a live editor lock. */

import { content, expect, test, written } from "./room";
import { expectFocusIndicator } from "./focus";

import type { WebSocketRoute } from "@playwright/test";

let CALLOUT = `<Callout id="01K0N4W3B7P27CBAEC7A8C8WEA" type="note" title="Note">

Body text.

</Callout>`;

test("a callout type menu has one keyboard path", async ({ join, seed }) => {
	await seed(CALLOUT);
	let page = await join("ana");
	let callout = content(page).locator("aside[data-plan-type]");
	let trigger = callout.getByRole("combobox", { name: "Change callout type: Note" });
	await expect(page.getByRole("listbox", { name: "Callout type" })).toHaveCount(0);

	await trigger.click();
	let menu = page.getByRole("listbox", { name: "Callout type" });
	let options = menu.getByRole("option");
	await expect(options).toHaveCount(5);
	await expect(menu.getByRole("option", { name: "Note" })).toHaveAttribute("aria-selected", "true");

	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await expect(trigger).toBeFocused();

	let pausedAnimations = await page.addStyleTag({
		content: ".plan-callout-menu { animation-play-state: paused !important; }",
	});
	await page.keyboard.press("ArrowDown");
	await expect(menu).toBeVisible();
	let note = menu.getByRole("option", { name: "Note" });
	await expect(note).toBeFocused();
	let midFlight = await menu.evaluate(element => {
		let animation = element.getAnimations()[0];
		let duration = animation?.effect?.getComputedTiming().duration;
		if (!animation || typeof duration !== "number") throw new Error("Callout animation is missing");
		animation.currentTime = duration / 2;
		animation.pause();
		return { currentTime: animation.currentTime, duration, playState: animation.playState };
	});
	expect(midFlight).toEqual({
		currentTime: midFlight.duration / 2,
		duration: midFlight.duration,
		playState: "paused",
	});
	await expectFocusIndicator(note);
	let settled = await menu.evaluate(element => {
		let animation = element.getAnimations()[0];
		let duration = animation?.effect?.getComputedTiming().duration;
		if (!animation || typeof duration !== "number") throw new Error("Callout animation is missing");
		animation.finish();
		return { currentTime: animation.currentTime, duration, playState: animation.playState };
	});
	expect(settled).toEqual({
		currentTime: settled.duration,
		duration: settled.duration,
		playState: "finished",
	});
	await expectFocusIndicator(note);
	await pausedAnimations.evaluate(element => element.parentNode?.removeChild(element));
	// Radix queues arrow focus, so keep the second arrow and Enter in the same
	// browser task: this is the rapid keyboard path the picker has to honour.
	await page.evaluate(() => {
		for (let key of ["ArrowDown", "Enter"]) {
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", {
					bubbles: true,
					cancelable: true,
					key,
				}),
			);
		}
	});
	await expect(menu).toHaveCount(0);
	await expect(callout).toHaveAttribute("data-plan-type", "tip");
	await expect(callout.getByRole("combobox", { name: "Change callout type: Tip" })).toBeFocused();
});

test("locking the plan closes an open callout type menu", async ({ join, page, seed }) => {
	let sockets: WebSocketRoute[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		route.connectToServer();
		sockets.push(route);
	});

	await seed(CALLOUT);
	await join("ana");
	let callout = content(page).locator("aside[data-plan-type]");
	let trigger = callout.getByRole("combobox", { name: "Change callout type: Note" });
	await trigger.click();
	await expect(page.getByRole("listbox", { name: "Callout type" })).toBeVisible();

	await sockets.at(-1)!.close();

	await expect(content(page)).toHaveAttribute("contenteditable", "false");
	await expect(page.getByRole("listbox", { name: "Callout type" })).toHaveCount(0);
	await expect(trigger).toBeDisabled();
	await expect(callout).toHaveAttribute("data-plan-type", "note");
});

test("a callout title preserves the browser's edit and composition state", async ({ join, room, seed }) => {
	await seed(CALLOUT);
	let page = await join("ana");
	let callout = content(page).locator("aside[data-plan-type]");
	let title = callout.getByRole("textbox", { name: "Callout title" });
	await title.fill("Worth knowing");
	await title.evaluate(element => {
		let text = element.firstChild!;
		let range = document.createRange();
		range.setStart(text, 6);
		range.collapse(true);
		let selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	});
	await page.keyboard.type("really ");
	await expect(title).toHaveText("Worth really knowing");

	await title.evaluate(element => {
		element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		element.textContent = "One\nTwo";
		element.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
	});
	await expect(title).toHaveText("One\nTwo");

	await title.evaluate(element => {
		element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
	});
	await expect(title).toHaveText("One Two");
	await written(page, room, /title="One Two"/);

	let maximum = "x".repeat(100);
	await title.fill(maximum + "extra");
	await expect(title).toHaveText(maximum);
	await written(page, room, new RegExp(`title="${maximum}"`));
	await title.blur();
});

test("a callout title pastes plain text at its caret", async ({ context, join, room, seed }) => {
	await seed(CALLOUT);
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	let page = await join("ana");
	let title = content(page).locator("aside[data-plan-type]").getByRole("textbox", {
		name: "Callout title",
	});
	await title.fill("Worth very knowing");
	await title.evaluate(element => {
		let range = document.createRange();
		range.setStart(element.firstChild!, 6);
		range.setEnd(element.firstChild!, 10);
		let selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	});
	await page.evaluate(async () => {
		await navigator.clipboard.write([
			new ClipboardItem({
				"text/html": new Blob(["<strong>really</strong><br><em>important</em>"], {
					type: "text/html",
				}),
				"text/plain": new Blob(["really\nimportant"], { type: "text/plain" }),
			}),
		]);
	});
	await page.keyboard.press("ControlOrMeta+V");
	await expect(title).toHaveText("Worth really important knowing");

	await page.keyboard.type("!");
	await expect(title).toHaveText("Worth really important! knowing");
	await written(page, room, /title="Worth really important! knowing"/);
});

test("a focused callout title reconciles a peer edit on blur", async ({ join, seed }) => {
	await seed(CALLOUT);
	let page = await join("ana");
	let callout = content(page).locator("aside[data-plan-type]");
	let title = callout.getByRole("textbox", { name: "Callout title" });
	await title.fill("Local draft");

	let peer = await join("bo");
	let peerCallout = content(peer).locator("aside[data-plan-type]");
	let peerTitle = peerCallout.getByRole("textbox", {
		name: "Callout title",
	});
	await peerTitle.fill("Changed elsewhere");
	await peerCallout.getByRole("combobox", { name: "Change callout type: Note" }).click();
	await peer.getByRole("option", { name: "Warning" }).click();
	await expect(callout).toHaveAttribute("data-plan-type", "warning");

	await expect(title).toBeFocused();
	await expect(title).toHaveText("Local draft");
	await title.blur();
	await expect(title).toHaveText("Changed elsewhere");
});
