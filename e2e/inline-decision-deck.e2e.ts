import { content, expect, test } from "./room";
import { deckSeed } from "./decision-deck-fixtures";

import type { Page } from "@playwright/test";

function deck(page: Page) {
	return page.locator('[data-document-view="plan"] [data-deck]');
}

function slotOf(page: Page, id: string) {
	return page.locator(`[data-document-view="plan"] [data-deck-slot="${id}"]`);
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

type Frame = { at: number; x: number; y: number; layer: number; opacity: number };

/** Wait for a card's move to start, then sample it at fractions of its duration. */
async function sampleMove(page: Page, id: string, fractions: number[]) {
	let slot = slotOf(page, id);
	await expect.poll(() =>
		slot.evaluate(element => element.getAnimations().some(item => item.id === "deck-move"))
	).toBe(true);
	return slot.evaluate((element, points) => {
		let move = element.getAnimations().find(animation => animation.id === "deck-move");
		if (!move) return undefined;
		move.pause();
		let duration = Number(move.effect!.getTiming().duration);
		let frames = points.map(at => {
			move!.currentTime = at * duration;
			let style = getComputedStyle(element);
			let matrix = new DOMMatrix(style.transform);
			return {
				at,
				x: matrix.m41,
				y: matrix.m42,
				layer: Number(style.zIndex),
				opacity: Number(style.opacity),
			};
		});
		move.finish();
		return frames;
	}, fractions) as Promise<Frame[] | undefined>;
}

/**
 * Wait in the page, frame by frame, for a card's move to start, then hold the whole
 * deck there. A move that follows a server round trip starts whenever the reply
 * lands and lasts a few hundred milliseconds, which polling from the test can miss.
 */
function heldMove(page: Page, id: string) {
	return deck(page).evaluate((element, slot) =>
		new Promise<boolean>(resolve => {
			let deadline = performance.now() + 10_000;
			let check = () => {
				let card = element.querySelector<HTMLElement>(`[data-deck-slot="${slot}"]`);
				if (card?.getAnimations().some(item => item.id === "deck-move")) {
					for (let animation of element.getAnimations({ subtree: true })) animation.pause();
					resolve(true);
				} else if (performance.now() > deadline) {
					resolve(false);
				} else {
					requestAnimationFrame(check);
				}
			};
			check();
		}), id);
}

/**
 * Pause the whole deck at moments through a move and read, at each, how much of
 * the best-shown card's content is visible: its opacity times its uncovered share.
 */
function contentVisibility(page: Page, times: number[]) {
	return deck(page).evaluate((element, moments) => {
		let animations = element.getAnimations({ subtree: true });
		for (let animation of animations) animation.pause();
		let readings = moments.map(time => {
			for (let animation of animations) {
				let end = Number(animation.effect!.getComputedTiming().endTime);
				animation.currentTime = Math.min(time, end);
			}
			let slots = [...element.querySelectorAll<HTMLElement>("[data-deck-slot]")];
			return Math.max(...slots.map(slot =>
				Number(getComputedStyle(slot).opacity)
				* (1 - Number(getComputedStyle(slot, "::after").opacity))
			));
		});
		for (let animation of animations) animation.finish();
		return readings;
	}, times);
}

/** The new top card's own opacity and its content cover's, once everything has settled. */
function settledTop(page: Page) {
	return top(page).evaluate(element => ({
		card: Number(getComputedStyle(element).opacity),
		cover: Number(getComputedStyle(element, "::after").opacity),
	}));
}

/** Deck animations that move a card rather than only fade it. */
function movingAnimations(page: Page) {
	return deck(page).evaluate(element =>
		element.getAnimations({ subtree: true }).filter(animation => {
			let frames = (animation.effect as KeyframeEffect).getKeyframes();
			return new Set(frames.map(frame => frame.transform)).size > 1
				|| frames.some(frame => frame.height);
		}).length
	);
}

test("adjacent decisions in a document form one deck", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph.", after: "Trailing paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");

	await expect(deck(page)).toHaveCount(1);
	await expect(deck(page)).toHaveAttribute("aria-roledescription", "carousel");
	await expect(content(page).getByRole("group", { name: "3 decisions", exact: true }))
		.toHaveCount(1);
	await expect(content(page).getByRole("region", { name: /decisions/i })).toHaveCount(0);
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
	// The last card disables next; focus moves to previous rather than dropping to the page.
	await expect(deck(page).getByRole("button", { name: "Previous decision" })).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(top(page).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	await page.keyboard.press("ArrowLeft");
	await expect(top(page).getByRole("heading", { name: fixture.prompts[0] })).toBeVisible();
	await expect(next).toBeFocused();
	// The first card is an end: previous is off and the left arrow does not wrap.
	await expect(deck(page).getByRole("button", { name: "Previous decision" })).toBeDisabled();
	await page.keyboard.press("ArrowLeft");
	await expect(top(page).getByRole("heading", { name: fixture.prompts[0] })).toBeVisible();

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

test("answering the last open card dissolves the deck and hands the caret to the prose after it", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph.", after: "Closing paragraph." }, 2);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");

	await top(page).getByText("Option 1", { exact: true }).click();
	await top(page).getByRole("button", { name: "Save", exact: true }).click();
	await expect(top(page).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	await expect(deck(page).getByText("1 of 2", { exact: true })).toBeVisible();
	await expect(deck(page).locator("[data-deck-settled]")).toHaveCount(1);

	await top(page).getByText("Option 2", { exact: true }).click();
	await top(page).getByRole("button", { name: "Save", exact: true }).click();
	await expect(deck(page)).toHaveCount(0);
	// Without prose a decided card draws nothing in the document; Decisions keeps it.
	await expect(content(page).locator("[data-card-settled]")).toHaveCount(0);
	await expect(content(page)).toContainText("Intro paragraph.");
	await expect(content(page)).toBeFocused();
	await expect(page.locator("[data-plan-announcer]")).toHaveText("Decision saved");
	await page.keyboard.type("Then ");
	await expect(content(page).locator("p").filter({ hasText: "Closing paragraph." }))
		.toHaveText("Then Closing paragraph.");
});

test("a dissolving deck in a blank document puts the caret on its first line", async ({ join, seed }) => {
	let fixture = deckSeed({}, 2);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	// A blank document opens on Decisions; answer in the document instead.
	await page.getByRole("button", { name: "Document", exact: true }).click();
	for (let index = 0; index < 2; index++) {
		await top(page).getByText(`Option ${index + 1}`, { exact: true }).click();
		await top(page).getByRole("button", { name: "Save", exact: true }).click();
	}
	await expect(deck(page)).toHaveCount(0);
	await expect(content(page)).toBeFocused();
	await expect(page.locator("[data-plan-announcer]")).toHaveText("Decision saved");
	await page.keyboard.type("First words");
	await expect(content(page).locator("p").first()).toHaveText("First words");
});

test("an answered decision settles to the back and focus follows the new top", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await top(page).getByText("Option 1", { exact: true }).click();
	await top(page).getByRole("button", { name: "Save", exact: true }).click();

	await expect(top(page).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	await expect(deck(page).locator("[data-deck-settled]")).toHaveCount(1);
	await expect(deck(page).getByRole("status"))
		.toHaveText("Decided. Now showing 1 of 3: Scope");
	await expect(top(page)).toBeFocused();
	// The answered card went to the back, and the rest moved up one place each.
	await expect.poll(() => order(page)).toEqual([fixture.ids[1], fixture.ids[2], fixture.ids[0]]);
	await expect(slotOf(page, fixture.ids[0]!)).toHaveAttribute(
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

	await expect(deck(ana).locator("[data-deck-settled]")).toHaveCount(1);
	await expect(top(ana).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
});

test("a collaborator's answer to my top card settles it and leaves my focus alone", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let ana = await join("ana");
	let ben = await join("ben");
	await expect(top(ana).getByRole("heading", { name: fixture.prompts[0] })).toBeVisible();
	await content(ana).getByText("Intro paragraph.").click();
	await expect(content(ana)).toBeFocused();

	await expect(top(ben).getByRole("heading", { name: fixture.prompts[0] })).toBeVisible();
	await top(ben).getByText("Option 1", { exact: true }).click();
	await top(ben).getByRole("button", { name: "Save", exact: true }).click();

	// Ana's top card was the one answered: it goes to the back and the next open card leads.
	await expect(top(ana).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	await expect(deck(ana).getByText("1 of 3", { exact: true })).toBeVisible();
	await expect(deck(ana).locator("[data-deck-settled]")).toHaveCount(1);
	await expect.poll(() => order(ana)).toEqual([fixture.ids[1], fixture.ids[2], fixture.ids[0]]);
	await expect(slotOf(ana, fixture.ids[0]!)).toHaveAttribute(
		"data-deck-settled",
		"",
	);
	// Someone else's answer neither speaks nor takes Ana's caret.
	await expect(deck(ana).getByRole("status")).toHaveText("");
	await expect(content(ana)).toBeFocused();
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
	await expect(page.locator('[data-document-view="plan"] [data-card-settled]')).toHaveCount(0);
});

test("showing a back decision from Decisions brings it to the top and focuses it", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Anchored paragraph." }, 3, { anchored: [2] });
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await expect.poll(() => order(page)).toEqual(fixture.ids);

	await page.getByRole("button", { name: /^Decisions/ }).click();
	// The Decisions tab is a deck too; bring the anchored card to its top first.
	let decisionsDeck = page.locator('[data-document-view="decisions"] [data-deck]');
	await decisionsDeck.getByRole("button", { name: "Next decision" }).click();
	await decisionsDeck.getByRole("button", { name: "Next decision" }).click();
	let card = decisionsDeck.locator("[data-deck-top] article[data-plan-sidecar-questionnaire]")
		.filter({ hasText: fixture.prompts[2]! });
	await card.getByRole("button", { name: /show in document/i }).click();

	await expect(page.getByRole("button", { name: "Document", exact: true }))
		.toHaveAttribute("aria-pressed", "true");
	await expect(top(page).getByRole("heading", { name: fixture.prompts[2] })).toBeVisible();
	await expect(top(page).locator(`article[data-plan-sidecar-questionnaire="${fixture.ids[2]}"]`))
		.toBeFocused();
	await expect.poll(() => order(page)).toEqual([fixture.ids[2], fixture.ids[0], fixture.ids[1]]);
});

test("next drops the old card a little as it fades in front, then brings it in behind", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph.", after: "Trailing paragraph." }, 3, {
		optionCounts: [8, 1, 1],
	});
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await deck(page).getByRole("button", { name: "Next decision" }).click();
	let fractions = Array.from({ length: 21 }, (_, step) => step / 20);
	let frames = await sampleMove(page, fixture.ids[0]!, fractions);
	expect(frames).toBeDefined();

	// Down a short way and fading over the deck until the midpoint, then in behind it.
	let away = frames!.filter(frame => frame.at < 0.5);
	let behind = frames!.filter(frame => frame.at > 0.5 && frame.at < 1);
	for (let index = 1; index < away.length; index++) {
		expect(away[index]!.y).toBeGreaterThanOrEqual(away[index - 1]!.y);
		expect(away[index]!.opacity).toBeLessThanOrEqual(away[index - 1]!.opacity);
	}
	for (let frame of away) expect(frame.layer).toBeGreaterThan(100);
	for (let frame of behind) expect(frame.layer).toBe(0);
	for (let frame of frames!) {
		expect(Math.abs(frame.x)).toBeLessThanOrEqual(1);
		expect(frame.y).toBeLessThanOrEqual(13);
	}
	await expect.poll(() => order(page)).toEqual([fixture.ids[1], fixture.ids[2], fixture.ids[0]]);
});

test("a tall card leaving never paints over the pager below the deck", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph.", after: "Trailing paragraph." }, 3, {
		optionCounts: [8, 1, 1],
	});
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await deck(page).getByRole("button", { name: "Next decision" }).click();
	await expect.poll(() =>
		slotOf(page, fixture.ids[0]!).evaluate(element =>
			element.getAnimations().some(item => item.id === "deck-move")
		)
	).toBe(true);
	for (let fraction of [0, 0.1, 0.2, 0.3, 0.4, 0.49]) {
		await scrub(page, fraction);
		let overshoot = await deck(page).evaluate((element, id) => {
			let leaving = element.querySelector<HTMLElement>(`[data-deck-slot="${id}"]`)!;
			let pager = element.querySelector<HTMLElement>(".decision-deck-nav")!;
			let rect = leaving.getBoundingClientRect();
			let scale = rect.height / leaving.offsetHeight;
			let clip = /inset\(([^)]*)\)/.exec(getComputedStyle(leaving).clipPath)?.[1] ?? "";
			let bottom = Number.parseFloat(clip.split(/\s+/)[2] ?? "");
			let painted = rect.top + (leaving.offsetHeight - bottom) * scale;
			return { bottom, overshoot: painted - pager.getBoundingClientRect().top };
		}, fixture.ids[0]!);
		expect(Number.isFinite(overshoot.bottom), `clip parsed at ${fraction}`).toBe(true);
		expect(overshoot.overshoot, `at ${fraction}`).toBeLessThanOrEqual(1);
	}
	await deck(page).evaluate(element => {
		for (let animation of element.getAnimations({ subtree: true })) animation.finish();
	});
	await expect(top(page).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
});

test("no frame of a move hides the front card's content", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await page.emulateMedia({ reducedMotion: "no-preference" });
	let moments = Array.from({ length: 21 }, (_, step) => step * 16);
	let play = async (name: "Next decision" | "Previous decision") => {
		await deck(page).getByRole("button", { name }).click();
		await expect.poll(() =>
			deck(page).evaluate(element => element.getAnimations({ subtree: true }).length)
		).toBeGreaterThan(0);
		let visible = await contentVisibility(page, moments);
		for (let [index, reading] of visible.entries()) {
			expect(reading, `${name} at ${moments[index]}ms`).toBeGreaterThan(0.5);
		}
		expect(await settledTop(page)).toEqual({ card: 1, cover: 0 });
	};
	await play("Next decision");
	await play("Previous decision");

	// Answering advances on its own, with the same guarantee.
	await top(page).getByText("Option 1", { exact: true }).click();
	await top(page).getByRole("button", { name: "Save", exact: true }).click();
	expect(await heldMove(page, fixture.ids[0]!), "the answered card moves").toBe(true);
	let visible = await contentVisibility(page, moments);
	for (let reading of visible) expect(reading).toBeGreaterThan(0.5);
	await expect(top(page).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	expect(await settledTop(page)).toEqual({ card: 1, cover: 0 });
});

test("an interrupted move continues from its current frame", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await page.emulateMedia({ reducedMotion: "no-preference" });
	let next = deck(page).getByRole("button", { name: "Next decision" });
	let previous = deck(page).getByRole("button", { name: "Previous decision" });
	await next.click();
	await previous.click();
	let frames = await sampleMove(page, fixture.ids[0]!, [0, 0.25, 0.5, 0.75, 1]);
	expect(frames).toBeDefined();
	// Called back, the card comes over the deck from wherever the first move left it.
	for (let frame of frames!.filter(frame => frame.at < 1)) {
		expect(frame.layer).toBeGreaterThan(100);
	}
	// At the end the no-fill animation releases its raised layer to the resting top slot.
	expect(frames!.find(frame => frame.at === 1)!.layer).toBe(100);
	expect(frames![0]!.opacity).toBeGreaterThan(0);
	await expect.poll(() => order(page)).toEqual(fixture.ids);
	await expect(top(page).getByRole("heading", { name: fixture.prompts[0] })).toBeVisible();
	expect(await settledTop(page)).toEqual({ card: 1, cover: 0 });
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

test("reduced motion crossfades without movement, in the right order", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await deck(page).getByRole("button", { name: "Next decision" }).click();
	expect(await movingAnimations(page)).toBe(0);
	await expect(top(page).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	// The old top card holds its layer while it fades, so read the order once it has.
	await expect.poll(() => order(page)).toEqual([fixture.ids[1], fixture.ids[2], fixture.ids[0]]);

	// Answering settles the card to the back without any animation.
	await top(page).getByText("Option 2", { exact: true }).click();
	await top(page).getByRole("button", { name: "Save", exact: true }).click();
	await expect.poll(() => order(page)).toEqual([fixture.ids[2], fixture.ids[0], fixture.ids[1]]);
	expect(await movingAnimations(page)).toBe(0);
});

test("a decided card on top keeps an open card's footprint", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3, { optionCounts: [2, 2, 2] });
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	let open = (await top(page).boundingBox())!.height;
	await top(page).getByText("Option 1", { exact: true }).click();
	await top(page).getByRole("button", { name: "Save", exact: true }).click();
	await expect(top(page).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();

	let next = deck(page).getByRole("button", { name: "Next decision" });
	await next.click();
	await next.click();
	await expect(deck(page).getByText("3 of 3", { exact: true })).toBeVisible();
	await expect(next).toBeDisabled();
	let decided = top(page).locator(`article[data-plan-sidecar-questionnaire="${fixture.ids[0]}"]`);
	await expect(decided.getByRole("heading", { name: fixture.prompts[0] })).toBeVisible();
	await expect(decided).toContainText("Answered by @ana");
	await expect(top(page).locator("[data-card-settled]")).toHaveCount(0);
	await expect.poll(async () => (await top(page).boundingBox())!.height / open)
		.toBeGreaterThan(0.8);
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

test("on a phone, adjacent decisions stay chips instead of a deck", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	for (let prompt of fixture.prompts) {
		await expect(
			content(page).getByRole("button", { name: `Decision: ${prompt}, answer in Decisions` }),
		).toBeVisible();
	}
	await expect(deck(page)).toHaveCount(0);
});

test("a long new option wraps in place and one confirm adds and chooses it", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 2);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	// Labels are at most 60 characters, so a narrow window makes one wrap.
	await page.setViewportSize({ width: 400, height: 800 });
	let card = top(page);
	let save = card.getByRole("button", { name: "Save", exact: true });
	await expect(save).toBeDisabled();

	await card.getByRole("button", { name: "Add an option", exact: true }).click();
	let field = card.getByRole("textbox", { name: "New option" });
	let confirm = card.getByRole("button", { name: "Add option", exact: true });
	await expect(confirm).toBeDisabled();
	let label = "Keep room state in a small embedded database by the server";
	await field.pressSequentially(label);
	await expect(confirm).toBeEnabled();

	// The field grows downwards; nothing around it scrolls sideways to follow the caret.
	let geometry = await field.evaluate(node => {
		let line = parseFloat(getComputedStyle(node).lineHeight);
		let scrolled: string[] = [];
		for (let at: Element | null = node.parentElement; at; at = at.parentElement) {
			if (at.scrollLeft !== 0) scrolled.push(at.tagName);
		}
		return { height: node.getBoundingClientRect().height, line, scrolled };
	});
	expect(geometry.height).toBeGreaterThan(geometry.line * 1.5);
	expect(geometry.scrolled).toEqual([]);
	await expect(card.getByRole("heading", { name: fixture.prompts[0] })).toBeInViewport();

	await confirm.click();
	let added = card.getByRole("radio", { name: label, exact: true });
	await expect(added).toBeChecked();
	await expect(field).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Add an option", exact: true })).toBeVisible();
	await expect(save).toBeEnabled();
});
