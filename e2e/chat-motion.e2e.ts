/**
 * Chat's motion, as Slack's feels: a row's shade and toolbar fade in under the pointer and out a
 * little quicker; a reaction that arrives pops in and a count that changes rolls into place, while a
 * message drawn with its reactions shows them at once; the emoji picker grows from its button; a
 * thread's panel slides in; the hint fades back once a message is sent. Every one is drawn from
 * Chopin's motion tokens, moves only transform and opacity, and is gone under reduced motion.
 */
import { expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

const ROWS = [
	{
		id: "motion-first",
		author: { kind: "member", handle: "ben" },
		text: "The canary held.",
		ts: 1,
	},
	{
		id: "motion-second",
		author: { kind: "member", handle: "cy" },
		text: "The drill runs at three.",
		ts: 2,
		reactions: [{ emoji: "🎉", handles: ["ben"] }],
	},
];

function chatOf(page: Page): Locator {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

/** A message's row, the `.chat-message-body` that carries its shade and toolbar. */
function row(page: Page, id: string): Locator {
	return chatOf(page).locator(`[data-chat-message-id="${id}"]`);
}

/** Every transition and animation that starts on an element matching `selector`, as it starts. */
async function watch(page: Page, selector: string): Promise<void> {
	await page.evaluate(selector => {
		let seen: Array<{ name: string; property: string; duration: number; on: string }> = [];
		(window as unknown as { __motion: typeof seen }).__motion = seen;
		let note = (element: Element) => {
			for (let animation of element.getAnimations()) {
				let timing = animation.effect?.getComputedTiming();
				seen.push({
					name: (animation as CSSAnimation).animationName ?? "",
					property: (animation as CSSTransition).transitionProperty ?? "",
					duration: Number(timing?.duration ?? 0),
					on: element.className,
				});
			}
		};
		new MutationObserver(records => {
			for (let record of records) {
				for (let node of record.addedNodes) {
					if (!(node instanceof Element)) continue;
					if (node.matches(selector)) note(node);
					for (let inner of node.querySelectorAll(selector)) note(inner);
				}
			}
		}).observe(document.body, { childList: true, subtree: true });
	}, selector);
}

async function motion(page: Page) {
	return await page.evaluate(() =>
		(window as unknown as {
			__motion: Array<{ name: string; property: string; duration: number; on: string }>;
		}).__motion
	);
}

/** A token's value in milliseconds, as the page resolves it. */
async function token(page: Page, expression: string): Promise<number> {
	return await page.evaluate(expression => {
		let probe = document.createElement("div");
		probe.style.transitionDuration = expression;
		document.body.append(probe);
		let value = Number.parseFloat(getComputedStyle(probe).transitionDuration) * 1000;
		probe.remove();
		return Math.round(value);
	}, expression);
}

async function shadeTiming(target: Locator): Promise<{ opacity: number; duration: number }> {
	return await target.evaluate(body => {
		let style = getComputedStyle(body, "::before");
		return {
			opacity: Number(style.opacity),
			duration: Math.round(Number.parseFloat(style.transitionDuration) * 1000),
		};
	});
}

test("a row's shade and toolbar fade in at the pointer's pace and out quicker; a new reaction pops and a count rolls, but none that was already there", async ({ join, seed }) => {
	await seed("# Motion\nRows that move.\n", { transcript: ROWS });
	let ana = await join("ana");
	let cy = await join("cy");
	let fast = await token(ana, "var(--duration-fast)");
	let pop = await token(ana, "var(--badge-pop-dur)");
	expect(fast).toBe(120);

	// Under the pointer the shade arrives over the feedback time; leaving, over two thirds of it.
	let second = row(ana, "motion-second");
	await second.locator("[data-chat-message-text]").hover();
	await expect.poll(() => shadeTiming(second)).toEqual({ opacity: 1, duration: fast });
	let toolbar = second.locator(".chat-message-toolbar");
	expect(await toolbar.evaluate(node => getComputedStyle(node).transitionProperty)).toBe("opacity");
	await row(ana, "motion-first").locator("[data-chat-message-text]").hover();
	await expect.poll(() => shadeTiming(second)).toEqual({
		opacity: 0,
		duration: Math.round(fast * 2 / 3),
	});

	// The reaction drawn with the message on arrival did not move.
	expect(
		await second.locator('[data-chat-reaction="🎉"]').evaluate(node => node.getAnimations().length),
	).toBe(0);

	// One that arrives while the message is on screen pops in, from opacity and scale only.
	await watch(ana, ".chat-reaction, .chat-reaction-count");
	await second.locator("[data-chat-message-text]").hover();
	await second.getByRole("toolbar", { name: "Reactions and actions" }).getByRole("button", {
		name: "Looks right",
		exact: true,
	}).click();
	await expect(second.getByRole("button", { name: "You reacted with ✅" })).toBeVisible();
	let popped = (await motion(ana)).filter(item => item.on.includes("chat-reaction"));
	expect(popped.map(item => item.property).sort()).toEqual(["opacity", "scale"]);
	expect(popped.every(item => item.duration === pop)).toBe(true);

	// A count another person changes rolls up into place on this screen.
	await watch(ana, ".chat-reaction-count");
	let theirs = row(cy, "motion-second");
	await theirs.locator("[data-chat-message-text]").hover();
	await theirs.getByRole("button", { name: /reacted with 🎉/ }).click();
	await expect(second.locator('[data-chat-reaction="🎉"]')).toHaveText("🎉2");
	let rolled = await motion(ana);
	expect(rolled.map(item => item.property).sort()).toEqual(["opacity", "translate"]);
	expect(rolled.every(item => item.duration === pop)).toBe(true);
});

test("the picker grows from its button, a thread slides in and the hint fades back after a send", async ({ join, seed }) => {
	await seed("# Motion\nRows that move.\n", { transcript: ROWS });
	let ana = await join("ana", { viewport: { width: 1600, height: 900 } });
	let base = await token(ana, "var(--duration-base)");
	let panel = await token(ana, "var(--panel-open-dur)");

	await watch(ana, ".chat-message-picker, .chat-split-thread");
	let second = row(ana, "motion-second");
	await second.locator("[data-chat-message-text]").hover();
	await second.getByRole("button", { name: "Add reaction" }).click();
	let picker = ana.locator(".chat-message-picker");
	await expect(picker).toBeVisible();
	let grown = (await motion(ana)).filter(item => item.on.includes("chat-message-picker"));
	expect(grown).toEqual([
		{ name: "emoji-picker-in", property: "", duration: base, on: "chat-message-picker" },
	]);
	// It grows from the corner at its button, the end edge, above or below it.
	expect(await picker.evaluate(node => node.style.transformOrigin)).toMatch(/^right (top|bottom)$/);
	await ana.keyboard.press("Escape");

	await second.locator("[data-chat-message-text]").hover();
	await second.getByRole("button", { name: "Reply in thread" }).click();
	await expect(ana.locator("[data-thread-panel]")).toBeVisible();
	let slid = (await motion(ana)).filter(item => item.on.includes("chat-split-thread"));
	expect(slid.map(item => item.property).sort()).toEqual(["opacity", "translate"]);
	expect(slid.every(item => item.duration === panel)).toBe(true);

	// The hint comes back with a fade once the words have gone.
	let main = chatOf(ana).locator(".chat-split-main");
	let input = main.getByRole("combobox", { name: "Message" });
	await input.click();
	await ana.keyboard.type("The dashboards are up.");
	await ana.keyboard.press("Enter");
	await expect(main.locator(".composer-draft-input[data-empty]")).toBeVisible();
	let hint = await main.locator(".composer-draft-input").evaluate(node => {
		let style = getComputedStyle(node, "::before");
		return { name: style.animationName, duration: Number.parseFloat(style.animationDuration) };
	});
	expect(hint).toEqual({ name: "composer-hint-in", duration: base / 1000 });
});

test("reduced motion: rows, reactions, the picker, a thread and the hint change at once", async ({ join, seed }) => {
	await seed("# Motion\nRows that move.\n", { transcript: ROWS });
	let ana = await join("ana", { reducedMotion: "reduce", viewport: { width: 1600, height: 900 } });
	await watch(
		ana,
		".chat-reaction, .chat-reaction-count, .chat-message-picker, .chat-split-thread",
	);

	let second = row(ana, "motion-second");
	await second.locator("[data-chat-message-text]").hover();
	await expect.poll(() => shadeTiming(second)).toEqual({ opacity: 1, duration: 0 });
	expect(
		await second.locator(".chat-message-toolbar").evaluate(node =>
			Number.parseFloat(getComputedStyle(node).transitionDuration)
		),
	).toBe(0);

	await second.getByRole("toolbar", { name: "Reactions and actions" }).getByRole("button", {
		name: "Looks right",
		exact: true,
	}).click();
	await expect(second.getByRole("button", { name: "You reacted with ✅" })).toBeVisible();
	await second.locator("[data-chat-message-text]").hover();
	await second.getByRole("button", { name: "Add reaction" }).click();
	await expect(ana.locator(".chat-message-picker")).toBeVisible();
	await ana.keyboard.press("Escape");
	await second.locator("[data-chat-message-text]").hover();
	await second.getByRole("button", { name: "Reply in thread" }).click();
	await expect(ana.locator("[data-thread-panel]")).toBeVisible();
	expect(await motion(ana)).toEqual([]);

	let hint = await chatOf(ana).locator(".chat-split-main .composer-draft-input").evaluate(node =>
		getComputedStyle(node, "::before").animationName
	);
	expect(hint).toBe("none");
});
