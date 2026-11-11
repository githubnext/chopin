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
	closed: ["model-selector-trigger"],
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
const TARGETS =
	'[data-slot="model-selector-trigger"], [data-slot="model-selector-item"], [role="radio"], [data-slot="composer-send"]';
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
	expect(checked).toBe(19);
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

/** The icons of a round button, by size, measured as laid out (a faded icon is scaled, so not by its box). */
async function iconSizes(button: Locator): Promise<Record<"arrow" | "square", [number, number]>> {
	return button.evaluate(element => {
		let size = (name: string): [number, number] => {
			let style = getComputedStyle(element.querySelector(`svg.lucide-${name}`)!);
			return [Number.parseFloat(style.width), Number.parseFloat(style.height)];
		};
		return { arrow: size("arrow-up"), square: size("square") };
	});
}

test("the round send and stop button is a 32px circle with no border, its arrow 16px and its square 12px, under both pointers", async ({ page }) => {
	let buttons = plate(page, "assistant-ui").locator('[data-slot="composer-send"]');
	// Five states beside the composer drawn as the element draws it.
	expect(await buttons.count()).toBe(6);
	let measured = async () => {
		let found = [];
		for (let index = 0; index < await buttons.count(); index++) {
			let button = buttons.nth(index);
			await expectClassGeometry(button, "composer-send");
			let box = await measure(button);
			// `grid size-8 place-items-center rounded-full`: 32px, round, and not drawn with a border.
			expect([box.width, box.height], `button ${index} size`).toEqual([32, 32]);
			expect(box.radius, `button ${index} radius`).toBeGreaterThan(1000);
			expect(box.border, `button ${index} border`).toEqual([0, 0, 0, 0]);
			expect(await iconSizes(button), `button ${index} icons`).toEqual({
				arrow: [16, 16],
				square: [12, 12],
			});
			found.push(box);
		}
		return found;
	};
	let fine = await measured();
	for (let index = 0; index < fine.length; index++) {
		expect(
			await buttons.nth(index).evaluate(node => getComputedStyle(node, "::after").content),
			`button ${index} has no target on a fine pointer`,
		).toBe("none");
	}
	// A coarse pointer grows only the target, to 44px; the circle, its border and its icons do not move.
	await page.evaluate(() => document.documentElement.setAttribute("data-plan-coarse-pointer", ""));
	expect(await measured()).toEqual(fine);
	for (let index = 0; index < fine.length; index++) {
		let after = await buttons.nth(index).evaluate(node => {
			let style = getComputedStyle(node, "::after");
			return [style.content, Number.parseFloat(style.width), Number.parseFloat(style.height)];
		});
		expect(after, `button ${index} target`).toEqual(['""', 44, 44]);
	}
});

test("the composer's box is the element's own: 24px corners, 10px padding and a hairline, the field 44px tall, the toolbar's controls 32px", async ({ page }) => {
	let shell = plate(page, "assistant-ui").locator('[data-slot="composer"]');
	let bar = shell.locator('[data-slot="composer-bar"]');
	let box = await measure(bar);
	expect(box.radius).toBe(24);
	expect(box.padding).toEqual([10, 10, 10, 10]);
	expect(box.border).toEqual([1, 1, 1, 1]);
	expect(box.gap).toBe(8);
	let field = await measure(shell.locator('[data-slot="composer-input"]'));
	expect([field.height, field.padding[3], field.fontSize]).toEqual([44, 12, 15]);
	// Each control in the toolbar is what its own classes say: 32px circles, and a 32px pill.
	for (
		let name of ["composer-attach", "composer-voice-button", "composer-send"] as const
	) {
		let control = shell.locator(`[data-slot="${name}"]`).first();
		await expectClassGeometry(control, name);
		let size = await measure(control);
		expect([size.width, size.height], name).toEqual([32, 32]);
	}
	let model = shell.locator('[data-slot="composer-model-trigger"]');
	await expectClassGeometry(model, "composer-model-trigger");
	let pill = await measure(model);
	expect([pill.height, pill.padding[1], pill.padding[3], pill.fontSize]).toEqual([
		32,
		12,
		12,
		12.5,
	]);
	expect(pill.radius).toBeGreaterThan(1000);
});
