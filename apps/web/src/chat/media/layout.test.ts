import { describe, expect, test } from "bun:test";

import {
	copyWidth,
	fileType,
	fittedBox,
	galleryShape,
	placeholderOf,
	thumbnailUrl,
} from "./layout";

describe("galleryShape", () => {
	test("lays out two, three and four images as Slack does, and folds the rest into +N", () => {
		expect(galleryShape(2)).toEqual({ shape: "pair", shown: 2, more: 0 });
		expect(galleryShape(3)).toEqual({ shape: "trio", shown: 3, more: 0 });
		expect(galleryShape(4)).toEqual({ shape: "quad", shown: 4, more: 0 });
		expect(galleryShape(5)).toEqual({ shape: "quad", shown: 4, more: 1 });
		expect(galleryShape(12)).toEqual({ shape: "quad", shown: 4, more: 8 });
	});
});

describe("fileType", () => {
	test("gives each kind of file its icon and its type in words", () => {
		expect([
			"brief.pdf",
			"notes.DOCX",
			"latency-by-day.csv",
			"deck.pptx",
			"cache-policy.ts",
			"rollout-notes.md",
			"build.log",
			"bundle.tar.gz",
			"diagram.svg",
			"standup.mov",
			"voice-note.m4a",
			"Dockerfile",
			"data.bin",
			"README",
		].map(fileType)).toEqual([
			{ kind: "pdf", label: "PDF" },
			{ kind: "document", label: "Word document" },
			{ kind: "spreadsheet", label: "CSV" },
			{ kind: "slides", label: "Presentation" },
			{ kind: "code", label: "TypeScript" },
			{ kind: "text", label: "Markdown" },
			{ kind: "text", label: "Log" },
			{ kind: "archive", label: "Archive" },
			{ kind: "image", label: "SVG image" },
			{ kind: "video", label: "QuickTime video" },
			{ kind: "audio", label: "Audio" },
			{ kind: "code", label: "Dockerfile" },
			{ kind: "generic", label: "BIN file" },
			{ kind: "generic", label: "File" },
		]);
	});

	test("reads a name that only starts with a dot as having no type", () => {
		expect(fileType(".env")).toEqual({ kind: "generic", label: "File" });
	});
});

describe("thumbnails", () => {
	test("asks for a copy at a width, beside any query the address already has", () => {
		expect(thumbnailUrl("/api/channels/c/attachments/a", 480)).toBe(
			"/api/channels/c/attachments/a?w=480",
		);
		expect(thumbnailUrl("/images/x.png?document=d", 360)).toBe("/images/x.png?document=d&w=360");
	});

	test("draws the narrowest of Slack's copies that fills the box on the screen it is on", () => {
		expect(copyWidth(480)).toBe(480);
		expect(copyWidth(480, 2)).toBe(960);
		expect(copyWidth(480, 1.5)).toBe(720);
		expect(copyWidth(240)).toBe(360);
		expect(copyWidth(240, 2)).toBe(480);
		expect(copyWidth(480, 3)).toBe(1024);
		expect(copyWidth(480, 0.5)).toBe(480);
	});
});

describe("fittedBox", () => {
	test("keeps an image's shape inside the bounds and never makes it larger", () => {
		let bounds = { width: 480, height: 360 };
		expect(fittedBox(1600, 800, bounds)).toEqual({ width: 480, height: 240 });
		expect(fittedBox(800, 1600, bounds)).toEqual({ width: 180, height: 360 });
		expect(fittedBox(200, 100, bounds)).toEqual({ width: 200, height: 100 });
	});
});

describe("placeholderOf", () => {
	test("stands a quiet box in while an image loads, and says why once it will not", () => {
		expect(placeholderOf("loadable", "loading")).toEqual({ state: "loading" });
		expect(placeholderOf("loadable", "shown")).toBeUndefined();
		expect(placeholderOf("loadable", "broken")).toEqual({
			state: "broken",
			words: "Couldn’t load image",
		});
		expect(placeholderOf("unavailable", "loading")).toEqual({
			state: "unavailable",
			words: "Image can’t be shown",
		});
	});
});
