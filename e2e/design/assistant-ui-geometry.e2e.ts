import { expect } from "@playwright/test";
import { plate, test } from "./fixture";
import { expected } from "./tailwind-geometry";

import type { Sides } from "./tailwind-geometry";

import type { Locator, Page } from "@playwright/test";

/**
 * Every copied assistant-ui element on the audit plate is measured against its own Tailwind classes
 * (`tailwind-geometry.ts`), under a fine pointer and under a forced coarse one. To add an element:
 * put it on the plate, add its roots to `ROOTS` and what a finger aims at to `TARGETS`.
 */
type Measured = {
	width: number;
	height: number;
	padding: Sides;
	border: Sides;
	radius: number;
	gap: number;
	fontSize: number;
	lineHeight: number;
};

/** The visible box of an element, in numbers. */
async function measure(element: Locator): Promise<Measured> {
	return element.evaluate(node => {
		let style = getComputedStyle(node);
		let box = node.getBoundingClientRect();
		let px = (value: string) => Number.parseFloat(value) || 0;
		return {
			width: box.width,
			height: box.height,
			padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(
				px,
			),
			border: [
				style.borderTopWidth,
				style.borderRightWidth,
				style.borderBottomWidth,
				style.borderLeftWidth,
			].map(px),
			radius: px(style.borderTopLeftRadius),
			gap: px(style.columnGap),
			fontSize: px(style.fontSize),
			lineHeight: px(style.lineHeight),
		} as Measured;
	});
}

/** Every measured property that the element's own classes decide equals the class's pixels. */
async function expectClassGeometry(element: Locator, label: string) {
	let className = (await element.getAttribute("class")) ?? "";
	let want = expected(className);
	let got = await measure(element);
	let at = `${label} (${className})`;
	if (want.height !== undefined) expect(got.height, `${at} height`).toBeCloseTo(want.height, 1);
	if (want.width !== undefined) expect(got.width, `${at} width`).toBeCloseTo(want.width, 1);
	for (let [index, side] of Object.entries(want.padding ?? {})) {
		expect(got.padding[Number(index) as 0 | 1 | 2 | 3], `${at} padding side ${index}`)
			.toBeCloseTo(side, 2);
	}
	expect(got.border, `${at} border widths`).toEqual(want.border);
	if (want.radius === Infinity) expect(got.radius, `${at} radius`).toBeGreaterThan(1000);
	else expect(got.radius, `${at} radius`).toBeCloseTo(want.radius, 2);
	if (want.gap !== undefined) expect(got.gap, `${at} gap`).toBeCloseTo(want.gap, 2);
	if (want.fontSize !== undefined) {
		expect(got.fontSize, `${at} font size`).toBeCloseTo(want.fontSize, 2);
	}
	if (want.lineHeight !== undefined) {
		expect(got.lineHeight, `${at} line height`).toBeCloseTo(want.lineHeight, 2);
	}
}

/** Each root a copied element draws, and what a person can aim at in it. */
const ROOTS = {
	closed: [
		"model-selector-trigger",
		"composer-menu",
		"composer-menu-item",
		"directive-text-chip",
		"composer-attachments",
		"composer-attachment",
		"composer-voice",
		"composer-voice-button",
		"message-attachments",
	],
	open: [
		"model-selector-content",
		"command",
		"command-input-wrapper",
		"input-group",
		"model-selector-search",
		"model-selector-list",
		"command-group",
		"model-selector-item",
		"model-selector-effort",
	],
} as const;
/** What a staged chip's picture box and a sent file's tiles are, which the roots above hold. */
const BOXES = [
	'[data-slot="composer-attachment"] > span:first-child',
	'[data-slot="message-attachments"] > *',
] as const;
const TARGETS =
	'[data-slot="model-selector-trigger"], [data-slot="model-selector-item"], [data-slot="composer-menu-item"], [role="radio"], [data-slot="composer-voice-button"], [data-slot="composer-attachment"] button:not([data-chopin-control]), [data-slot="message-attachments"] button';
const slot = (page: Page, name: string) => page.locator(`[data-slot="${name}"]`);
const effortRadios = (page: Page) => slot(page, "model-selector-effort").getByRole("radio");

async function openSelector(page: Page): Promise<Locator> {
	let trigger = plate(page, "assistant-ui").getByRole("combobox").first();
	await trigger.scrollIntoViewIfNeeded();
	await trigger.click();
	await expect(slot(page, "model-selector-content")).toBeVisible();
	await expect(slot(page, "model-selector-effort")).toBeVisible();
	// The popup enters with a zoom and a fade; measure it settled.
	await expect.poll(() =>
		slot(page, "model-selector-content").evaluate(node => getComputedStyle(node).opacity)
	).toBe("1");
	return trigger;
}

test("a copied element is as many pixels as its Tailwind classes say, not as Chopin's scale would make it", async ({ page }) => {
	let checked = 0;
	for (let name of ROOTS.closed) {
		let elements = plate(page, "assistant-ui").locator(`[data-slot="${name}"]`);
		expect(await elements.count()).toBeGreaterThan(1);
		for (let index = 0; index < await elements.count(); index++) {
			await expectClassGeometry(elements.nth(index), name);
			checked++;
		}
	}
	// The box of a chip's icon, and the tiles of a sent message's files, which the roots hold.
	for (let selector of BOXES) {
		let boxes = plate(page, "assistant-ui").locator(selector);
		expect(await boxes.count(), `${selector} is drawn`).toBeGreaterThan(1);
		for (let index = 0; index < await boxes.count(); index++) {
			await expectClassGeometry(boxes.nth(index), selector);
			checked++;
		}
	}
	await openSelector(page);
	for (let name of ROOTS.open) {
		let elements = slot(page, name);
		expect(await elements.count(), `${name} is drawn`).toBeGreaterThan(0);
		for (let index = 0; index < await elements.count(); index++) {
			await expectClassGeometry(elements.nth(index), name);
			checked++;
		}
	}
	let radios = slot(page, "model-selector-effort").getByRole("radio");
	expect(await radios.count()).toBe(3);
	for (let index = 0; index < 3; index++) {
		await expectClassGeometry(radios.nth(index), "effort radio");
		checked++;
	}
	expect(checked).toBe(52);
});

test("assistant-ui's own radii, in pixels, where Chopin's scale differs", async ({ page }) => {
	// Tailwind's `rounded-xl` is 12px and Chopin's is 10px: the popup and its list are the proof.
	await openSelector(page);
	expect((await measure(slot(page, "model-selector-content"))).radius).toBe(12);
	expect((await measure(slot(page, "command").first())).radius).toBe(12);
	expect((await measure(slot(page, "model-selector-item").first())).radius).toBe(8);
	expect((await measure(effortRadios(page).first())).radius).toBe(6);
	// And its type: `text-sm` is 14px on 20px, not Chopin's fluid step on 1.5.
	let trigger = await measure(plate(page, "assistant-ui").getByRole("combobox").first());
	expect([trigger.fontSize, trigger.lineHeight]).toEqual([14, 20]);
	expect([trigger.height, trigger.padding[1], trigger.padding[3]]).toEqual([36, 12, 12]);
});

test("a coarse pointer grows only the hit area: the visible box, border, radius and type do not move", async ({ page }) => {
	let trigger = await openSelector(page);
	let targets = page.locator(TARGETS);
	let count = await targets.count();
	expect(count).toBeGreaterThan(8);
	let fine = [];
	for (let index = 0; index < count; index++) fine.push(await measure(targets.nth(index)));
	// A fine pointer has no invisible target.
	for (let index = 0; index < count; index++) {
		expect(await targets.nth(index).evaluate(node => getComputedStyle(node, "::after").content))
			.toBe("none");
	}

	await page.evaluate(() => document.documentElement.setAttribute("data-plan-coarse-pointer", ""));
	let coarse = [];
	for (let index = 0; index < count; index++) coarse.push(await measure(targets.nth(index)));
	expect(coarse).toEqual(fine);
	for (let index = 0; index < count; index++) {
		let target = targets.nth(index);
		let after = await target.evaluate(node => {
			let style = getComputedStyle(node, "::after");
			return { content: style.content, width: style.width, height: style.height };
		});
		expect(after.content).toBe('""');
		let box = fine[index]!;
		// `max(100%, 44px)` of the padding box: as big as the control inside its border, and 44px at least.
		let inside = (size: number, edges: number) => Math.max(size - edges, 44);
		expect(Number.parseFloat(after.width)).toBeCloseTo(
			inside(box.width, box.border[1] + box.border[3]),
			1,
		);
		expect(Number.parseFloat(after.height)).toBeCloseTo(
			inside(box.height, box.border[0] + box.border[2]),
			1,
		);
	}

	// The effort levels are 24px tall: a touch 8px above or below one still lands on it, through its
	// target. The popup may settle somewhere else as the page changes, so each aim reads the live box.
	let radio = effortRadios(page).first();
	let own = await radio.textContent();
	let aim = async (offset: "above" | "below") => {
		let box = (await radio.boundingBox())!;
		expect(box.height).toBeLessThan(44);
		let y = offset === "above" ? box.y - 8 : box.y + box.height + 8;
		return page.evaluate(([px, py]) => {
			let hit = document.elementFromPoint(px!, py!);
			return hit?.closest('[role="radio"]')?.textContent ?? hit?.tagName ?? null;
		}, [box.x + box.width / 2, y]);
	};
	expect(await aim("above")).toBe(own);
	expect(await aim("below")).toBe(own);
	await page.evaluate(() => document.documentElement.removeAttribute("data-plan-coarse-pointer"));
	expect(await aim("above")).not.toBe(own);
	expect(await aim("below")).not.toBe(own);
	await expect(trigger).toBeVisible();
});

test("Chopin's global button behaviour does not reach a copy: its press, transition and focus ring are its own", async ({ page }) => {
	let trigger = plate(page, "assistant-ui").getByRole("combobox").first();
	let style = await trigger.evaluate(node => {
		let computed = getComputedStyle(node);
		return { transition: computed.transitionProperty, scale: computed.scale };
	});
	// `transition-colors` in the copy, not Chopin's `transition: scale`.
	expect(style.transition).toContain("color");
	expect(style.transition).not.toBe("scale");
	await trigger.focus();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Shift+Tab");
	let ring = await trigger.evaluate(node => {
		let computed = getComputedStyle(node);
		return { outlineStyle: computed.outlineStyle, shadow: computed.boxShadow };
	});
	// assistant-ui draws a 1px ring in `box-shadow`; Chopin's 2px outline is not added beside it.
	expect(ring.outlineStyle).toBe("none");
	expect(ring.shadow).not.toBe("none");
});

/**
 * The message box is Chopin's own, in Slack's proportions as built: an 8px box with a hairline, a
 * toolbar and a row of 28px ghost buttons with 16px icons, and a 28px rounded-square send. It is
 * measured where Chat draws it, on the chat plate of the audit.
 */
test("the message box is an 8px box with a 1px border, 28px controls with 16px icons and a 28px rounded-square send, under both pointers", async ({ page }) => {
	let composer = plate(page, "chat").locator(".chat-composer").first();
	await composer.scrollIntoViewIfNeeded();
	let box = composer.locator(".composer-surface");
	let boxed = await measure(box);
	expect(boxed.radius).toBe(8);
	expect(boxed.border).toEqual([1, 1, 1, 1]);

	let controls = composer.locator(".composer-format button, .composer-row .btn-icon");
	let icons = controls.locator("svg:not([data-send-stop-status])");
	expect(await controls.count()).toBeGreaterThanOrEqual(10);
	let sized = async () => {
		let found = [];
		for (let index = 0; index < await controls.count(); index++) {
			let control = controls.nth(index);
			if (!await control.isVisible()) continue;
			let size = await measure(control);
			expect([size.width, size.height], `control ${index} size`).toEqual([28, 28]);
			found.push(size);
		}
		return found;
	};
	let fine = await sized();
	for (let index = 0; index < await icons.count(); index++) {
		let icon = icons.nth(index);
		if (!await icon.isVisible()) continue;
		expect(
			await icon.evaluate(
				node => [node.getBoundingClientRect().width, node.getBoundingClientRect().height],
			),
			`icon ${index}`,
		).toEqual([16, 16]);
	}
	let send = composer.locator("[data-send-stop]");
	let rounded = await measure(send);
	// A rounded square, not a circle: Chopin's medium radius.
	expect(rounded.radius).toBe(6);
	expect(rounded.border).toEqual([0, 0, 0, 0]);

	for (let index = 0; index < fine.length; index++) {
		let visible = [];
		for (let item = 0; item < await controls.count(); item++) {
			if (await controls.nth(item).isVisible()) visible.push(item);
		}
		expect(
			await controls.nth(visible[index]!).evaluate(node =>
				getComputedStyle(node, "::after").content
			),
			`control ${index} has no target on a fine pointer`,
		).toBe("none");
	}
	// A coarse pointer grows only the target, to 44px: the boxes, border and icons do not move.
	await page.evaluate(() => document.documentElement.setAttribute("data-plan-coarse-pointer", ""));
	expect(await sized()).toEqual(fine);
	let after = await send.evaluate(node => {
		let style = getComputedStyle(node, "::after");
		return [style.content, Number.parseFloat(style.width), Number.parseFloat(style.height)];
	});
	expect(after).toEqual(['""', 44, 44]);
});

/**
 * The slots the box fills from the hooks: the `+` is one of its 28px ghost buttons, the files it
 * stages (assistant-ui's chips) and the voice it listens with sit inside the box above the text, and
 * the microphone (assistant-ui's own 32px round button) is in the bottom row with the other controls.
 */
test("the + is a 28px ghost button in the row; the staged files and the voice are inside the box above the text; the microphone is in the row", async ({ page }) => {
	let staged = plate(page, "chat").locator(".chat-composer").filter({
		has: page.locator(".composer-staging [data-slot='composer-attachment']"),
	}).first();
	await staged.scrollIntoViewIfNeeded();
	let box = (await staged.locator(".composer-surface").boundingBox())!;
	let row = (await staged.locator(".composer-row").boundingBox())!;
	let field = (await staged.locator(".composer-field").boundingBox())!;

	let plus = staged.getByRole("button", { name: "Add files", exact: true });
	await expect(plus).toBeVisible();
	let sized = await measure(plus);
	expect([sized.width, sized.height]).toEqual([28, 28]);
	expect(sized.radius).toBe(6);
	expect(
		await plus.locator("svg").evaluate(node => [node.clientWidth, node.clientHeight]),
	).toEqual([16, 16]);
	let at = (await plus.boundingBox())!;
	expect(at.y).toBeGreaterThanOrEqual(row.y);
	expect(at.y + at.height).toBeLessThanOrEqual(row.y + row.height);

	// The chips are in the box, above the field, and below nothing else of the draft's.
	let chips = staged.locator(".composer-staging [data-slot='composer-attachment']");
	expect(await chips.count()).toBe(3);
	for (let index = 0; index < 3; index++) {
		let chip = (await chips.nth(index).boundingBox())!;
		expect(chip.x, `chip ${index} is inside the box`).toBeGreaterThanOrEqual(box.x);
		expect(chip.x + chip.width, `chip ${index} is inside the box`).toBeLessThanOrEqual(
			box.x + box.width + 0.5,
		);
		expect(chip.y + chip.height, `chip ${index} is above the text`).toBeLessThanOrEqual(field.y);
	}

	// The microphone is the element's own 32px round button, in the row beside the other controls.
	let mic = staged.getByRole("button", { name: "Dictate", exact: true });
	let round = await measure(mic);
	expect([round.width, round.height]).toEqual([32, 32]);
	expect(round.radius).toBeGreaterThan(1000);
	let micAt = (await mic.boundingBox())!;
	expect(micAt.y).toBeGreaterThanOrEqual(row.y);
	expect(micAt.y + micAt.height).toBeLessThanOrEqual(row.y + row.height);
	expect(micAt.x).toBeGreaterThan(at.x);

	// Listening shows the element's voice above the text, 44px tall, with its clock in whole minutes.
	let listening = plate(page, "chat").locator(".chat-composer").filter({
		has: page.locator("[data-slot='composer-voice']"),
	}).first();
	await listening.scrollIntoViewIfNeeded();
	let voice = listening.locator("[data-slot='composer-voice']");
	let heard = (await voice.boundingBox())!;
	expect(heard.height).toBe(44);
	expect(heard.y + heard.height).toBeLessThanOrEqual(
		(await listening.locator(".composer-field").boundingBox())!.y,
	);
	await expect(voice).toContainText("1:05");
	await expect(voice).toHaveAttribute("data-recording", "true");
});
