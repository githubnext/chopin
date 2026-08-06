/**
 * The shell, as two layers.
 *
 * None of this can be asserted without a browser: it is all rectangles, a
 * computed colour, and a pseudo-element that exists only while a pointer is
 * over it. What the suite is protecting is the one claim the design makes —
 * that there is a single ground and exactly one thing standing on it — because
 * a fill added to a rail is invisible in a diff and obvious on a screen.
 */

import { expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

/** Transparent, as Chromium serialises it. */
const NONE = "rgba(0, 0, 0, 0)";

/** The ground: `Workspace`'s own root, and the only child `App` renders into. */
function ground(page: Page) {
	return page.locator("#root > div");
}

/**
 * The nav.
 *
 * By role rather than by tag: both rails open with a `<header>` of their own,
 * and a `<header>` inside an `<aside>` is not a banner — being the one at the
 * top of the app is exactly what distinguishes this one.
 */
function nav(page: Page) {
	return page.getByRole("banner");
}

/**
 * The page, which is the surface behind the plan rather than a box around it.
 *
 * It is hidden from the accessibility tree because it draws and holds nothing
 * — which also makes `aria-hidden` the honest way to name it here.
 */
function surface(page: Page) {
	return page.locator("main > div[aria-hidden='true']");
}

function rails(page: Page) {
	return {
		chat: page.locator("aside").first(),
		decisions: page.locator("aside").last(),
	};
}

/**
 * What an element's fill actually comes out as, in hex.
 *
 * A computed colour is serialised in the space it was authored in — the ground
 * reads back as `oklch(0.9674 0.0029 95)`, which is true and says nothing about
 * whether it is the grey it was supposed to be. So it is painted onto a canvas
 * and the pixel is read, which is the same conversion the screen does.
 */
function paint(target: Locator): Promise<string> {
	return target.evaluate(element => {
		let canvas = document.createElement("canvas");
		canvas.width = canvas.height = 1;

		let context = canvas.getContext("2d")!;
		context.fillStyle = getComputedStyle(element).backgroundColor;
		context.fillRect(0, 0, 1, 1);

		// `Array.from` rather than mapping the pixel data in place: that is a
		// `Uint8ClampedArray`, whose `map` coerces every string back to a number
		// and so produces `#000` for any colour at all.
		let pixel = context.getImageData(0, 0, 1, 1).data;
		return `#${
			Array.from(pixel.slice(0, 3), channel => channel.toString(16).padStart(2, "0")).join("")
		}`;
	});
}

function box(target: Locator) {
	return target.evaluate(element => element.getBoundingClientRect().toJSON() as DOMRect);
}

/**
 * Whether a handle's bar is painted.
 *
 * It is a pseudo-element, so it is not in the DOM to be found and its presence
 * is not the question anyway — it is always there and almost always invisible.
 */
function drawn(handle: Locator): Promise<string> {
	return handle.evaluate(element => getComputedStyle(element, "::after").opacity);
}

test("the nav and both rails have no fill of their own", async ({ join, page }) => {
	await join("ana");

	// One ground, and nothing between it and the eye. A rail with a fill of its
	// own is a panel again even when the fill happens to match.
	expect(await paint(ground(page))).toBe("#f5f4f2");
	for (let layer of [nav(page), rails(page).chat, rails(page).decisions]) {
		expect(await layer.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(NONE);
	}
});

test("the page is the only thing in the shell that is lifted", async ({ join, page }) => {
	await join("ana");

	expect(await paint(surface(page))).toBe("#ffffff");
	expect(await surface(page).evaluate(el => getComputedStyle(el).boxShadow)).not.toBe("none");

	for (let flat of [nav(page), rails(page).chat, rails(page).decisions]) {
		await expect(flat).toHaveCSS("box-shadow", "none");
	}
});

/**
 * "The document page is the only element with a shadow", read as written.
 *
 * Asserting `none` on the three layers would pass on a shell that had grown a
 * fourth, so every element is asked instead and the answer has to be a list of
 * one. It is a resting room: nothing floating is open, no table is drawing its
 * rails, and the plan is healthy, so nothing that earns a shadow by appearing
 * has appeared. Those — the slash menu and the bubble, the notice pill, the
 * change chips, a table's grips — are the exceptions this cannot see and 008,
 * 009 and 010 own; an offender is named rather than counted so that a shadow
 * put back on a rail says which rail.
 */
test("no element in a resting room has a shadow except the page", async ({ join, page }) => {
	await join("ana");

	let shadowed = await page.evaluate(() =>
		[...document.querySelectorAll("body *")]
			.filter(element => getComputedStyle(element).boxShadow !== "none")
			.map(element =>
				element.matches("main > [aria-hidden='true']")
					? "the page"
					: `${element.localName}.${element.getAttribute("class") ?? ""}`
			)
	);

	expect(shadowed).toEqual(["the page"]);
});

test("the nav is 48px tall and the page starts 16px below it", async ({ join, page }) => {
	await join("ana");

	let bar = await box(nav(page));
	let paper = await box(surface(page));

	expect(bar.height).toBe(48);
	expect(paper.top - bar.bottom).toBe(16);
});

test("the page has four pixels of ground either side of it", async ({ join, page }) => {
	await join("ana");

	let paper = await box(surface(page));
	let chat = await box(rails(page).chat);
	let decisions = await box(rails(page).decisions);

	// Measured against the rails rather than against `main`, because the four
	// pixels are what a reader sees between the two things, not a padding value.
	expect(paper.left - chat.right).toBe(4);
	expect(decisions.left - paper.right).toBe(4);
});

test("the page runs off the bottom of the window rather than ending above it", async ({ join, page }) => {
	await join("ana");

	let paper = await box(surface(page));
	let height = page.viewportSize()!.height;

	expect(paper.bottom).toBeGreaterThan(height);
	// Round at the top, square at the bottom — the corners say which end is the
	// one that was cut off.
	let corners = await surface(page).evaluate(el => {
		let style = getComputedStyle(el);
		return [
			style.borderTopLeftRadius,
			style.borderTopRightRadius,
			style.borderBottomLeftRadius,
			style.borderBottomRightRadius,
		];
	});
	expect(corners).toEqual(["10px", "10px", "0px", "0px"]);
});

test("neither resize handle is drawn until the pointer is over it", async ({ join, page }) => {
	await join("ana");

	for (let name of ["Resize the conversation", "Resize the decisions"]) {
		let handle = page.getByRole("separator", { name });

		expect(await drawn(handle)).toBe("0");
		await handle.hover();
		await expect.poll(() => drawn(handle)).toBe("1");
		// Away again, so the second handle is not measured under a pointer that
		// happens to still be resting on the first.
		await page.mouse.move(0, 0);
		await expect.poll(() => drawn(handle)).toBe("0");
	}
});

/**
 * A drag that is taken away rather than finished.
 *
 * The bar is held up for the length of a drag, because pointer capture does not
 * reliably keep `:hover` and it would otherwise blink out from under the hand
 * moving it. Anything that ends a drag without a `pointerup` — Escape, a pen
 * leaving the tablet, the browser taking the pointer back — therefore has to
 * put it down again, or the handle stays painted with nothing near it.
 *
 * Capture is revoked from script here because that is what those all do and
 * none of them can be typed: a synthetic `pointercancel` releases nothing, so
 * it would test the dispatcher rather than the handle.
 *
 * The order of the last three lines is the test. A handle follows the pointer
 * for as long as the drag is working, so it is under the pointer the whole way
 * and a `pointerup` at the end of one lands on it however far it went —
 * clearing the state there looks right until the pointer is somewhere else
 * when the button comes up, which is precisely what an interruption leaves.
 * Written the other way round this passed against the bug it is here for.
 */
test("a drag the browser takes away still puts the bar down", async ({ join, page }) => {
	await join("ana");

	let handle = page.getByRole("separator", { name: "Resize the conversation" });
	let start = await box(handle);

	await handle.hover();
	await page.mouse.down();
	await page.mouse.move(start.x + 40, start.y + start.height / 2);
	await expect.poll(() => drawn(handle)).toBe("1");

	await handle.evaluate(element => {
		// Chromium's mouse is pointer 1, and `releasePointerCapture` throws on a
		// pointer it does not hold — so a wrong id fails the test rather than
		// passing it for the wrong reason.
		(element as HTMLElement).releasePointerCapture(1);
	});
	await page.mouse.move(0, 0);
	await page.mouse.up();

	await expect.poll(() => drawn(handle)).toBe("0");
});

test("both rails can be resized with the keyboard alone", async ({ join, page }) => {
	await join("ana");

	// Right widens the rail on the left and narrows the one on the right, so the
	// key names a direction on the screen rather than one in the layout.
	for (
		let { grew, name, rail } of [
			{ name: "Resize the conversation", rail: rails(page).chat, grew: 32 },
			{ name: "Resize the decisions", rail: rails(page).decisions, grew: -32 },
		]
	) {
		let handle = page.getByRole("separator", { name });
		let before = (await box(rail)).width;

		await handle.focus();
		await handle.press("ArrowRight");
		await handle.press("ArrowRight");

		let after = (await box(rail)).width;
		expect({ rail: name, moved: after - before }).toEqual({ rail: name, moved: grew });
		await expect(handle).toHaveAttribute("aria-valuenow", String(after));
	}
});
