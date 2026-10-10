import { describe, expect, test } from "bun:test";

import { draggedImageWidth, imageWidth } from "./image-size";

describe("image size", () => {
	test("bounds the width to its container and the document limit", () => {
		expect(imageWidth(25, 500)).toBe(64);
		expect(imageWidth(200, 40)).toBe(40);
		expect(imageWidth(9000, 9000)).toBe(4096);
		expect(imageWidth(125.8, 500)).toBe(126);
	});

	test("each corner grows away from the opposite corner", () => {
		expect(draggedImageWidth(200, 2, 40, 20, "bottom right", 600)).toBe(240);
		expect(draggedImageWidth(200, 2, -40, 20, "bottom left", 600)).toBe(240);
		expect(draggedImageWidth(200, 2, -40, -20, "top left", 600)).toBe(240);
		expect(draggedImageWidth(200, 2, 40, -20, "top right", 600)).toBe(240);
	});

	test("uses the dominant axis without changing the image ratio", () => {
		expect(draggedImageWidth(200, 2, 10, 30, "bottom right", 600)).toBe(260);
		expect(draggedImageWidth(200, 2, -100, -20, "bottom right", 600)).toBe(100);
		expect(draggedImageWidth(200, 2, 800, 0, "bottom right", 500)).toBe(500);
	});
});
