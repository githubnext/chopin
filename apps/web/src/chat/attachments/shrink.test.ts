import { expect, test } from "bun:test";

import { MAX_SENT_PIXELS, needsShrinking, shrinkSteps, shrunkName } from "./shrink";

test("an image is sent smaller only when it is over the cap or more pixels than the server reads", () => {
	let cap = 1_048_576;
	expect(needsShrinking(cap, { width: 4000, height: 3000 }, cap)).toBe(false);
	expect(needsShrinking(cap + 1, { width: 400, height: 300 }, cap)).toBe(true);
	expect(needsShrinking(20_000, { width: 12000, height: 8000 }, cap)).toBe(true);
	expect(needsShrinking(cap + 1, undefined, cap)).toBe(true);
	expect(12000 * 8000).toBeGreaterThan(MAX_SENT_PIXELS);
});

test("a copy is tried from 4096 pixels down, keeping the image's shape", () => {
	let steps = shrinkSteps({ width: 12000, height: 8000 });
	expect(steps[0]).toEqual({ width: 4096, height: 2731 });
	expect(steps[1]).toEqual({ width: 3072, height: 2048 });
	expect(steps.at(-1)!.width).toBeGreaterThanOrEqual(192);
	for (let step of steps) expect(step.width / step.height).toBeCloseTo(1.5, 2);
	expect(shrinkSteps({ width: 800, height: 3000 })[0]).toEqual({ width: 800, height: 3000 });
});

test("a copy keeps its name, with the extension of what it now is", () => {
	expect(shrunkName("whiteboard.JPG", "image/jpeg")).toBe("whiteboard.jpg");
	expect(shrunkName("diagram.png", "image/webp")).toBe("diagram.webp");
	expect(shrunkName("diagram.png", "image/png")).toBe("diagram.png");
	expect(shrunkName(".png", "image/webp")).toBe("image.webp");
});
