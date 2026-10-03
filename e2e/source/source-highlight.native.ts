import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

import type { ConversationPlan } from "../../packages/protocol/index";
import type { Page } from "@playwright/test";

declare global {
	interface Window {
		sourceLeaf: {
			highlightSource: (
				owner: object,
				element: HTMLElement,
				source: ConversationPlan.SourceRef,
			) => boolean;
			clearSourceHighlight: (owner: object) => void;
		};
		sourceOwners: object[];
	}
}

let script: string;

test.beforeAll(async () => {
	if (typeof Bun === "undefined") {
		throw new Error("Run Playwright through bun --bun so the native leaf can be bundled");
	}
	let path = fileURLToPath(
		new URL("../../apps/web/src/conversation-plan/source.ts", import.meta.url),
	);
	let result = await Bun.build({
		entrypoints: [path],
		target: "browser",
		format: "iife",
		plugins: [{
			name: "source-leaf-test-binding",
			setup(build) {
				build.onLoad({ filter: /\/source\.ts$/ }, async args => ({
					loader: "ts",
					contents: await Bun.file(args.path).text()
						+ "\nwindow.sourceLeaf = { highlightSource, clearSourceHighlight };",
				}));
			},
		}],
	});
	expect(result.success).toBe(true);
	expect(result.outputs).toHaveLength(1);
	script = await result.outputs[0]!.text();
});

async function load(page: Page, html: string): Promise<void> {
	await page.route("**/*", route => route.abort());
	await page.setContent(html);
	await page.addScriptTag({ content: `${script}\nwindow.sourceOwners = [{}, {}];` });
}

function source(quote: string, start: number, end: number): ConversationPlan.SourceRef {
	return {
		messageId: "saved-message",
		author: { kind: "member", handle: "ana" },
		role: "option",
		quote,
		start,
		end,
	};
}

async function mark(page: Page, quote: string, start: number, end: number, owner = 0) {
	return page.evaluate(({ value, owner }) =>
		window.sourceLeaf.highlightSource(
			window.sourceOwners[owner]!,
			document.querySelector<HTMLElement>("article")!,
			value,
		), { value: source(quote, start, end), owner });
}

async function ranges(page: Page) {
	return page.evaluate(() =>
		Array.from(CSS.highlights.get("conversation-source") ?? [], range => {
			if (!(range instanceof Range)) throw new Error("Expected a native Range");
			return {
				text: range.toString(),
				start: range.startOffset,
				end: range.endOffset,
				startText: range.startContainer.textContent,
				endText: range.endContainer.textContent,
				rects: range.getClientRects().length,
			};
		})
	);
}

test("an exact quote creates a native range over its saved text", async ({ page }) => {
	await load(
		page,
		'<article data-chat-raw="Start with a pilot."><div data-chat-message-text>Start with a pilot.</div></article>',
	);
	expect(await mark(page, "a pilot", 11, 18)).toBe(true);
	expect(await ranges(page)).toEqual([{
		text: "a pilot",
		start: 11,
		end: 18,
		startText: "Start with a pilot.",
		endText: "Start with a pilot.",
		rects: 1,
	}]);
});

test("ranges span nested text nodes and exact node boundaries", async ({ page }) => {
	await load(
		page,
		'<article data-chat-raw="Alpha Beta Gamma"><div data-chat-message-text>Alpha <strong>Beta</strong> Gamma</div></article>',
	);
	expect(await mark(page, "Beta Gamma", 6, 16)).toBe(true);
	let [spanning] = await ranges(page);
	expect(spanning).toMatchObject({
		text: "Beta Gamma",
		start: 6,
		end: 6,
		startText: "Alpha ",
		endText: " Gamma",
	});
	expect(spanning!.rects).toBeGreaterThan(0);
	expect(await mark(page, "Beta", 6, 10)).toBe(true);
	let [range] = await ranges(page);
	expect(range).toMatchObject({
		text: "Beta",
		start: 6,
		end: 4,
		startText: "Alpha ",
		endText: "Beta",
	});
	expect(range!.rects).toBeGreaterThan(0);
});

test("saved UTF-16 offsets include emoji correctly", async ({ page }) => {
	await load(
		page,
		'<article data-chat-raw="A😀 pilot"><div data-chat-message-text>A😀 <em>pilot</em></div></article>',
	);
	expect(await mark(page, "😀 pilot", 1, 9)).toBe(true);
	let [range] = await ranges(page);
	expect(range).toMatchObject({
		text: "😀 pilot",
		start: 1,
		end: 5,
		startText: "A😀 ",
		endText: "pilot",
	});
	expect(range!.rects).toBeGreaterThan(0);
});

test("missing or changed rendered source text refuses highlighting", async ({ page }) => {
	for (
		let html of [
			'<article data-chat-raw="pilot">pilot</article>',
			"<article><div data-chat-message-text>pilot</div></article>",
			'<article data-chat-raw="pilot"><div data-chat-message-text>changed</div></article>',
		]
	) {
		await load(page, html);
		expect(await mark(page, "pilot", 0, 5)).toBe(false);
		expect(await ranges(page)).toEqual([]);
	}
	await load(
		page,
		'<article data-chat-raw="pilot"><div data-chat-message-text>pilot</div></article>',
	);
	expect(await mark(page, "other", 0, 5)).toBe(false);
	expect(await ranges(page)).toEqual([]);
});

test("owners coexist and replacing one preserves the other's native range", async ({ page }) => {
	await load(
		page,
		'<article data-chat-raw="Alpha Beta"><div data-chat-message-text>Alpha Beta</div></article>',
	);
	expect(await mark(page, "Alpha", 0, 5)).toBe(true);
	expect(await mark(page, "Beta", 6, 10, 1)).toBe(true);
	await page.evaluate(() => {
		(window as typeof window & { retained?: AbstractRange }).retained =
			Array.from(CSS.highlights.get("conversation-source")!)[1];
	});
	expect(await mark(page, "Alpha Beta", 0, 10)).toBe(true);
	expect((await ranges(page)).map(range => range.text)).toEqual(["Beta", "Alpha Beta"]);
	expect(
		await page.evaluate(() =>
			Array.from(CSS.highlights.get("conversation-source")!)[0]
				=== (window as typeof window & { retained?: AbstractRange }).retained
		),
	).toBe(true);
});

test("a refused replacement clears its owner and final cleanup deletes the registry", async ({ page }) => {
	await load(
		page,
		'<article data-chat-raw="Alpha Beta"><div data-chat-message-text>Alpha Beta</div></article>',
	);
	expect(await mark(page, "Alpha", 0, 5)).toBe(true);
	expect(await mark(page, "Beta", 6, 10, 1)).toBe(true);
	expect(await mark(page, "wrong", 0, 5)).toBe(false);
	expect((await ranges(page)).map(range => range.text)).toEqual(["Beta"]);
	await page.evaluate(() => window.sourceLeaf.clearSourceHighlight(window.sourceOwners[1]!));
	expect(await page.evaluate(() => CSS.highlights.has("conversation-source"))).toBe(false);
	await page.evaluate(() => window.sourceLeaf.clearSourceHighlight(window.sourceOwners[1]!));
	expect(await ranges(page)).toEqual([]);
});

test("an unavailable CSS Highlights API refuses safely", async ({ page }) => {
	await load(
		page,
		'<article data-chat-raw="pilot"><div data-chat-message-text>pilot</div></article>',
	);
	await page.evaluate(() =>
		Object.defineProperty(CSS, "highlights", { configurable: true, value: undefined })
	);
	expect(await mark(page, "pilot", 0, 5)).toBe(false);
	await page.evaluate(() => window.sourceLeaf.clearSourceHighlight(window.sourceOwners[0]!));
});
