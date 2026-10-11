import { content, expect, test } from "./room";
import { deckSeed } from "./decision-deck-fixtures";

import type { Page } from "@playwright/test";

function deck(page: Page) {
	return page.locator('[data-document-view="plan"] [data-deck]');
}

function top(page: Page) {
	return deck(page).locator("[data-deck-top]");
}

/** Slot ids from front to back, read from each slot's layer. Valid at rest. */
function order(page: Page) {
	return deck(page).evaluate(element =>
		[...element.querySelectorAll<HTMLElement>("[data-deck-slot]")]
			.map(slot => ({ id: slot.dataset.deckSlot!, layer: Number(getComputedStyle(slot).zIndex) }))
			.sort((a, b) => b.layer - a.layer)
			.map(slot => slot.id)
	);
}

/** Pause every animation in the deck at `fraction` of its own duration. */
function scrub(page: Page, fraction: number) {
	return deck(page).evaluate((element, at) => {
		for (let animation of element.getAnimations({ subtree: true })) {
			animation.pause();
			animation.currentTime = at * Number(animation.effect!.getTiming().duration);
		}
	}, fraction);
}

type Frame = { at: number; y: number; layer: number; opacity: number };

/** Sample a card's shuffle at fractions of its duration, then let it finish. */
async function sampleShuffle(page: Page, id: string, fractions: number[]) {
	let slot = page.locator(`[data-deck-slot="${id}"]`);
	await expect.poll(() =>
		slot.evaluate(element => element.getAnimations().some(item => item.id === "deck-shuffle"))
	).toBe(true);
	return slot.evaluate((element, points) => {
		let shuffle = element.getAnimations().find(animation => animation.id === "deck-shuffle");
		if (!shuffle) return undefined;
		shuffle.pause();
		let duration = Number(shuffle.effect!.getTiming().duration);
		let frames = points.map(at => {
			shuffle!.currentTime = at * duration;
			let style = getComputedStyle(element);
			return {
				at,
				y: new DOMMatrix(style.transform).m42,
				layer: Number(style.zIndex),
				opacity: Number(style.opacity),
			};
		});
		shuffle.finish();
		return frames;
	}, fractions) as Promise<Frame[] | undefined>;
}

test("adjacent decisions in a document form one deck", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph.", after: "Trailing paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");

	await expect(deck(page)).toHaveCount(1);
	await expect(deck(page)).toHaveAttribute("aria-roledescription", "carousel");
	await expect(top(page).getByRole("heading", { name: fixture.prompts[0] })).toBeVisible();
	await expect(deck(page).locator("[data-deck-slot]:not([data-deck-top])")).toHaveCount(2);
	for (let slot of await deck(page).locator("[data-deck-slot]:not([data-deck-top])").all()) {
		await expect(slot).toHaveAttribute("inert", "");
	}
	await expect(deck(page).getByText("1 of 3")).toBeVisible();

	// Followers and the caret paragraphs before them take no room of their own.
	let followers = content(page).locator("[data-plan-questionnaire]:has(> [data-deck-follower])");
	await expect(followers).toHaveCount(2);
	for (let follower of await followers.all()) await expect(follower).toBeHidden();
	let deckBox = (await deck(page).boundingBox())!;
	let trailing = (await content(page).getByText("Trailing paragraph.").boundingBox())!;
	let lineHeight = await content(page).evaluate(element =>
		Number.parseFloat(getComputedStyle(element).lineHeight)
	);
	expect(trailing.y - (deckBox.y + deckBox.height)).toBeLessThanOrEqual(lineHeight * 1.5);
});

test("decisions separated by prose stay separate cards", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 2, { separated: true });
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await expect(page.locator('[data-document-view="plan"] article[data-plan-sidecar-questionnaire]'))
		.toHaveCount(2);
	await expect(deck(page)).toHaveCount(0);
});

test("next, previous and arrow keys cycle without moving the caret", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph.", after: "Trailing paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await content(page).getByText("Trailing paragraph.").click();
	let caret = await page.evaluate(() => {
		let selection = getSelection()!;
		return [selection.anchorNode?.textContent, selection.anchorOffset];
	});

	let next = deck(page).getByRole("button", { name: "Next decision" });
	await next.click();
	await expect(top(page).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	await expect(deck(page).getByRole("status")).toHaveText("Decision 2 of 3: Scope");

	await next.focus();
	await page.keyboard.press("ArrowRight");
	await expect(top(page).getByRole("heading", { name: fixture.prompts[2] })).toBeVisible();
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("ArrowLeft");
	await expect(top(page).getByRole("heading", { name: fixture.prompts[0] })).toBeVisible();
	await expect(next).toBeFocused();

	await content(page).getByText("Trailing paragraph.").click();
	expect(
		await page.evaluate(() => {
			let selection = getSelection()!;
			return [selection.anchorNode?.textContent, selection.anchorOffset];
		}),
	).toEqual(caret);
	await expect(content(page)).toContainText("Intro paragraph.");
});

test("arrow keys inside a card's options do not cycle the deck", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 2);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await top(page).getByText("Option 1", { exact: true }).click();
	await page.keyboard.press("ArrowRight");
	await expect(top(page).getByRole("heading", { name: fixture.prompts[0] })).toBeVisible();
});

test("the deck keeps its top card, focus and draft when its first card leaves", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let ana = await join("ana");
	let ben = await join("ben");

	await deck(ana).getByRole("button", { name: "Next decision" }).click();
	await expect(top(ana).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	await top(ana).getByRole("button", { name: "Add an option", exact: true }).click();
	let draft = top(ana).getByRole("textbox", { name: "New option" });
	await draft.fill("Keep it in Yjs");
	await expect(draft).toBeFocused();

	let first = top(ben);
	await expect(first.getByRole("heading", { name: fixture.prompts[0] })).toBeVisible();
	await first.getByRole("button", { name: "Discard", exact: true }).click();
	await first.getByRole("button", { name: "Discard", exact: true }).click();

	await expect(deck(ana).getByText("1 of 2")).toBeVisible();
	await expect(top(ana).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	await expect(draft).toHaveValue("Keep it in Yjs");
	await expect(draft).toBeFocused();
});

test("answering the last open card hands focus to its settled line", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 2);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");

	await top(page).getByText("Option 1", { exact: true }).click();
	await top(page).getByRole("button", { name: "Save", exact: true }).click();
	await expect(top(page).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	await expect(deck(page).getByText("1 of 2 · 1 decided")).toBeVisible();

	await top(page).getByText("Option 2", { exact: true }).click();
	await top(page).getByRole("button", { name: "Save", exact: true }).click();
	await expect(deck(page)).toHaveCount(0);
	let settled = content(page).locator(
		`[data-plan-questionnaire="${fixture.ids[1]}"] [data-card-settled]`,
	);
	await expect(settled).toBeFocused();
});

test("an answered decision settles to the back and focus follows the new top", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await top(page).getByText("Option 1", { exact: true }).click();
	await top(page).getByRole("button", { name: "Save", exact: true }).click();

	await expect(top(page).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	await expect(deck(page).getByText("1 decided")).toBeVisible();
	await expect(deck(page).getByRole("status"))
		.toHaveText("Decided. Now showing 1 of 3: Scope");
	await expect(top(page)).toBeFocused();
	// The answered card went to the back, and the rest moved up one place each.
	await expect.poll(() => order(page)).toEqual([fixture.ids[1], fixture.ids[2], fixture.ids[0]]);
	await expect(page.locator(`[data-deck-slot="${fixture.ids[0]}"]`)).toHaveAttribute(
		"data-deck-settled",
		"",
	);
});

test("a collaborator's answer reorders without moving my top card", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let ana = await join("ana");
	let ben = await join("ben");
	await deck(ana).getByRole("button", { name: "Next decision" }).click();
	await expect(top(ana).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();

	await top(ben).getByText("Option 1", { exact: true }).click();
	await top(ben).getByRole("button", { name: "Save", exact: true }).click();

	await expect(deck(ana).getByText("1 decided")).toBeVisible();
	await expect(top(ana).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
});

test("answering every decision dissolves the deck", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 2);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	for (let index = 0; index < 2; index++) {
		await top(page).getByText(`Option ${index + 1}`, { exact: true }).click();
		await top(page).getByRole("button", { name: "Save", exact: true }).click();
	}
	await expect(deck(page)).toHaveCount(0);
	await expect(page.locator('[data-document-view="plan"] [data-card-settled]')).toHaveCount(2);
});

test("showing a back decision from Decisions brings it to the top and focuses it", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Anchored paragraph." }, 3, { anchored: [2] });
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await expect.poll(() => order(page)).toEqual(fixture.ids);

	await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = page.locator(
		'[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]',
	)
		.filter({ hasText: fixture.prompts[2]! });
	await card.getByRole("button", { name: /show in document/i }).click();

	await expect(page.getByRole("button", { name: "Document", exact: true }))
		.toHaveAttribute("aria-pressed", "true");
	await expect(top(page).getByRole("heading", { name: fixture.prompts[2] })).toBeVisible();
	await expect(top(page).locator(`article[data-plan-sidecar-questionnaire="${fixture.ids[2]}"]`))
		.toBeFocused();
	await expect.poll(() => order(page)).toEqual([fixture.ids[2], fixture.ids[0], fixture.ids[1]]);
});

test("cycling shuffles the outgoing card from over the deck to under it", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await deck(page).getByRole("button", { name: "Next decision" }).click();
	let fractions = Array.from({ length: 21 }, (_, step) => step / 20);
	let frames = await sampleShuffle(page, fixture.ids[0]!, fractions);
	expect(frames).toBeDefined();

	// Out and down to the midpoint, then back up into the slot behind the deck.
	let first = frames!.filter(frame => frame.at <= 0.45);
	let second = frames!.filter(frame => frame.at >= 0.45);
	for (let index = 1; index < first.length; index++) {
		expect(first[index]!.y).toBeGreaterThanOrEqual(first[index - 1]!.y);
	}
	for (let index = 1; index < second.length; index++) {
		expect(second[index]!.y).toBeLessThanOrEqual(second[index - 1]!.y);
	}
	expect(Math.max(...frames!.map(frame => frame.y))).toBeGreaterThan(40);
	// No frame jumps: neighbouring samples stay within a card's travel.
	let travel = Math.max(...frames!.map(frame => frame.y))
		- Math.min(...frames!.map(frame => frame.y));
	for (let index = 1; index < frames!.length; index++) {
		expect(Math.abs(frames![index]!.y - frames![index - 1]!.y)).toBeLessThan(travel * 0.6);
	}
	// The card passes over the deck, then drops under it near the midpoint.
	for (let frame of frames!) {
		if (frame.at < 0.4) expect(frame.layer).toBeGreaterThan(100);
		// At 1 the card has landed and returns to its slot's own layer.
		if (frame.at > 0.5 && frame.at < 1) expect(frame.layer).toBe(0);
		expect(frame.opacity).toBe(1);
	}
	await expect.poll(() => order(page)).toEqual([fixture.ids[1], fixture.ids[2], fixture.ids[0]]);
});

test("an interrupted shuffle continues from its current frame and keeps its layer", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await page.emulateMedia({ reducedMotion: "no-preference" });
	let next = deck(page).getByRole("button", { name: "Next decision" });
	let previous = deck(page).getByRole("button", { name: "Previous decision" });
	await next.click();
	await previous.click();
	let frames = await sampleShuffle(page, fixture.ids[0]!, [0, 0.1, 0.2, 0.3, 0.44, 0.6, 1]);
	expect(frames).toBeDefined();
	// Reversed before the midpoint, the card never dips under the deck.
	for (let frame of frames!.filter(frame => frame.at < 1)) {
		expect(frame.layer).toBeGreaterThan(100);
	}
	// It resumes from where the first move had taken it, not from its slot.
	expect(frames![0]!.y).not.toBe(0);
	await expect.poll(() => order(page)).toEqual(fixture.ids);
	await expect(top(page).getByRole("heading", { name: fixture.prompts[0] })).toBeVisible();
});

test("a tall card coming forward never paints over what is below the deck", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph.", after: "Trailing paragraph." }, 3, {
		optionCounts: [1, 8, 1],
	});
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await deck(page).getByRole("button", { name: "Next decision" }).click();
	for (let fraction of [0.1, 0.3, 0.5, 0.7, 0.9]) {
		await scrub(page, fraction);
		let overshoot = await deck(page).evaluate((element, id) => {
			let incoming = element.querySelector<HTMLElement>(`[data-deck-slot="${id}"]`)!;
			let stage = element.querySelector<HTMLElement>(".decision-deck-stage")!;
			let rect = incoming.getBoundingClientRect();
			let scale = rect.height / incoming.offsetHeight;
			let clip = /inset\(([^)]*)\)/.exec(getComputedStyle(incoming).clipPath)?.[1] ?? "";
			let bottom = Number.parseFloat(clip.split(/\s+/)[2] ?? "");
			let visible = rect.top + (incoming.offsetHeight - bottom) * scale;
			return { bottom, overshoot: visible - stage.getBoundingClientRect().bottom };
		}, fixture.ids[1]!);
		// A tall card coming forward is clipped; a missing clip must not read as zero.
		expect(Number.isFinite(overshoot.bottom), `clip parsed at ${fraction}`).toBe(true);
		expect(overshoot.bottom, `clip at ${fraction}`).toBeGreaterThan(0);
		expect(overshoot.overshoot, `at ${fraction}`).toBeLessThanOrEqual(2);
	}
	await deck(page).evaluate(element => {
		for (let animation of element.getAnimations({ subtree: true })) animation.finish();
	});
	await expect(top(page).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
});

test("reduced motion reorders instantly and in the right order", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await deck(page).getByRole("button", { name: "Next decision" }).click();
	expect(await deck(page).evaluate(element => element.getAnimations({ subtree: true }).length))
		.toBe(0);
	await expect(top(page).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	expect(await order(page)).toEqual([fixture.ids[1], fixture.ids[2], fixture.ids[0]]);

	// Answering settles the card to the back without any animation.
	await top(page).getByText("Option 2", { exact: true }).click();
	await top(page).getByRole("button", { name: "Save", exact: true }).click();
	await expect.poll(() => order(page)).toEqual([fixture.ids[2], fixture.ids[0], fixture.ids[1]]);
	expect(await deck(page).evaluate(element => element.getAnimations({ subtree: true }).length))
		.toBe(0);
});

test("a deck fits a 390px document without horizontal scroll", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana", { viewport: { width: 390, height: 800 } });
	let destination = page.getByRole("button", { name: "Document", exact: true });
	if ((await destination.getAttribute("aria-pressed")) !== "true") await destination.click();
	await expect(deck(page)).toBeVisible();
	let box = (await deck(page).boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(390);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
