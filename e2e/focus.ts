import { expect } from "@playwright/test";

import { visibleOutlineColor } from "./focus-color";

import type { Locator } from "@playwright/test";

/**
 * `ring` is the element that draws the indicator, when that is not the focused
 * element itself: a preview whose block clips it, say.
 */
export async function expectFocusIndicator(target: Locator, ring = target): Promise<void> {
	await expect(target).toBeFocused();
	let result = await ring.evaluate(element => {
		let style = getComputedStyle(element);
		let width = parseFloat(style.outlineWidth);
		let offset = parseFloat(style.outlineOffset);
		let bounds = element.getBoundingClientRect();
		let html = element as HTMLElement;
		let scaleX = html.offsetWidth ? bounds.width / html.offsetWidth : 1;
		let scaleY = html.offsetHeight ? bounds.height / html.offsetHeight : 1;
		let outside = Math.max(0, width + offset);
		let clippedBy: string[] = [];
		let clips = /^(auto|clip|hidden|scroll)$/;

		for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
			let ancestorStyle = getComputedStyle(ancestor);
			let ancestorBounds = ancestor.getBoundingClientRect();
			let name = `${ancestor.tagName}.${ancestor.getAttribute("class") ?? ""}`;
			if (
				clips.test(ancestorStyle.overflowX)
				&& (bounds.left - outside * scaleX < ancestorBounds.left
					|| bounds.right + outside * scaleX > ancestorBounds.right)
			) clippedBy.push(`${name}:x`);
			if (
				clips.test(ancestorStyle.overflowY)
				&& (bounds.top - outside * scaleY < ancestorBounds.top
					|| bounds.bottom + outside * scaleY > ancestorBounds.bottom)
			) clippedBy.push(`${name}:y`);
		}

		return {
			clippedBy,
			outline: style.outlineStyle !== "none" && width >= 2,
			outlineColor: style.outlineColor,
		};
	});

	expect(result.outline && visibleOutlineColor(result.outlineColor)).toBe(true);
	expect(result.clippedBy).toEqual([]);
}
