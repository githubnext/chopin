/**
 * A Chat row shown under the pointer, with its menu open, with its thread open or jumped to is a
 * shade people can see on the transcript, and everything drawn on it (the name, its tag, the time,
 * the words, links, code, mentions, reactions and the toolbar's icons) meets WCAG 2.2 AA against
 * what is actually behind it: 4.5:1 for text, 3:1 for icons.
 *
 * The shade is a row's `::before`, under the row's ancestors rather than among them, so the DOM walk
 * of `e2e/design/contrast.ts` never sees it. Here every backdrop is read from the rendered pixels
 * instead: the colour most of an element's box is painted, under its words or icon.
 */
import { appendFileSync } from "node:fs";

import { chatInput } from "./chat-input";
import { expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

type Pair = {
	state: string;
	part: string;
	role: "shade" | "text" | "large text" | "icon" | "toolbar" | "toolbar edge";
	fg: string;
	bg: string;
	ratio: number;
	threshold: number;
};

/**
 * Slack's hovered row is `#f8f8f8` on its white pane, 1.06:1, darker than the pane. A row Chat shades
 * must be at least that far darker than the transcript it lies on, and a selected row (its thread
 * open) a further step. The toolbar's white box stands off the shade at least as far again.
 */
const HOVER_STEP = 1.06;
const SELECTED_STEP = 1.12;
const TOOLBAR_STEP = 1.1;
const OUT = process.env.HOVER_CONTRAST_OUT;

function transcript() {
	return [
		{
			id: "ben-1",
			author: { kind: "member" as const, handle: "ben" },
			text:
				"@chopin the cache is keyed by `router.ts` paths. See [the guide](https://example.com/guide) and **retry** once.",
			ts: 1_700_000_000,
			reactions: [{ emoji: "✅", handles: ["ana", "ben"] }, { emoji: "👀", handles: ["ben"] }],
		},
		{
			id: "ben-2",
			author: { kind: "member" as const, handle: "ben" },
			text: "Staging held overnight, and the canary stays at five percent.",
			ts: 1_700_000_030,
		},
		{
			id: "agent-1",
			author: { kind: "agent" as const },
			text:
				"I moved the key into `router.ts` and left the drill on [the plan](https://example.com).",
			ts: 1_700_000_090,
			reactions: [{ emoji: "❓", handles: ["ben"] }],
		},
		{
			id: "ana-1",
			author: { kind: "member" as const, handle: "ana" },
			text: "Booked the drill for Thursday.",
			ts: 1_700_000_200,
		},
	];
}

function chatOf(page: Page): Locator {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function message(page: Page, id: string): Locator {
	return chatOf(page).locator(`.chat-split-main [data-chat-message-id="${id}"]`);
}

/**
 * Reads one row as drawn: the shade against the transcript beside it, each text and each icon in
 * it against the colour most of its own box is painted, and the toolbar's edge against the shade.
 * `ground` is the same point of the transcript read while no row there was shown.
 */
async function measure(page: Page, row: Locator, state: string, ground: string): Promise<Pair[]> {
	let png = (await page.screenshot()).toString("base64");
	let handle = await row.elementHandle();
	return page.evaluate(async ({ data, element, state, ground, toolbarStep }) => {
		let bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
		let bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
		let canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		let context = canvas.getContext("2d", { willReadFrequently: true })!;
		context.drawImage(bitmap, 0, 0);
		let scale = bitmap.width / innerWidth;
		type RGBA = [number, number, number, number];
		let pixel = (x: number, y: number): RGBA => {
			let d = context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
			return [d[0]!, d[1]!, d[2]!, 1];
		};
		// The colour most of a box is painted: its ground, under the words or icon drawn on it.
		let mode = (box: DOMRect): RGBA => {
			let x = Math.max(0, Math.round(box.left * scale)),
				y = Math.max(0, Math.round(box.top * scale));
			let w = Math.max(1, Math.round(box.width * scale)),
				h = Math.max(1, Math.round(box.height * scale));
			let d = context.getImageData(x, y, w, h).data;
			let counts = new Map<number, number>();
			let best = 0, top = 0;
			for (let at = 0; at < d.length; at += 4) {
				let key = (d[at]! << 16) | (d[at + 1]! << 8) | d[at + 2]!;
				let n = (counts.get(key) ?? 0) + 1;
				counts.set(key, n);
				if (n > top) [top, best] = [n, key];
			}
			return [best >> 16 & 255, best >> 8 & 255, best & 255, 1];
		};
		let probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
		let parse = (value: string): RGBA => {
			probe.clearRect(0, 0, 1, 1);
			probe.fillStyle = value;
			probe.fillRect(0, 0, 1, 1);
			let d = probe.getImageData(0, 0, 1, 1).data;
			return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
		};
		let over = (top: RGBA, under: RGBA): RGBA =>
			[0, 1, 2].map(i => top[i]! * top[3] + under[i]! * (1 - top[3])).concat(1) as RGBA;
		let linear = (v: number) => {
			let c = v / 255;
			return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		};
		let luminance = (c: RGBA) =>
			0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
		let ratio = (a: RGBA, b: RGBA) => {
			let [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
			return Math.round(((x! + 0.05) / (y! + 0.05)) * 100) / 100;
		};
		let hex = (c: RGBA) =>
			"#" + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
		let opacity = (node: Element) => {
			let value = 1;
			for (
				let at: Element | null = node;
				at && at !== element.parentElement;
				at = at.parentElement
			) {
				value *= parseFloat(getComputedStyle(at).opacity);
			}
			return value;
		};
		let body = element as HTMLElement;
		let scroller = body.closest<HTMLElement>("[data-chat-scroll]")!.getBoundingClientRect();
		let rect = body.getBoundingClientRect();
		let pairs: Omit<Pair, "state">[] = [];

		// The shade, 8px in from the transcript's start, level with the row's first line.
		let shadePoint = { x: scroller.left + 8, y: rect.top + 8 };
		let shade = pixel(shadePoint.x, shadePoint.y);
		let groundColour = parse(ground);
		// A shade lighter than the transcript is a step the wrong way: its ratio is written under 1.
		let step = ratio(shade, groundColour);
		pairs.push({
			part: "row shade on the transcript",
			role: "shade",
			fg: hex(shade),
			bg: hex(groundColour),
			ratio: luminance(shade) > luminance(groundColour) ? Math.round(100 / step) / 100 : step,
			threshold: 0,
		});

		let head = body.hasAttribute("data-chat-headed")
			? body.previousElementSibling?.matches("[data-chat-head]")
				? body.previousElementSibling
				: null
			: null;
		let elements = [
			...(head ? [head, ...head.querySelectorAll("*")] : []),
			...body.querySelectorAll("*"),
		];
		for (let node of elements) {
			if (
				node.closest("svg")
				|| node.closest(".chat-emoji, .chat-reaction-emoji, .message-actions-emoji")
			) {
				continue;
			}
			if (!node.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
			let own = [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE)
				.map(child => child.textContent ?? "").join("").trim();
			if (!/[\p{L}\p{N}]/u.test(own)) continue;
			let box = node.getBoundingClientRect();
			if (box.width < 2 || box.height < 2) continue;
			let style = getComputedStyle(node);
			let fg = parse(style.color);
			fg[3] *= opacity(node);
			let back = mode(box);
			let size = parseFloat(style.fontSize), weight = parseInt(style.fontWeight, 10);
			let large = size >= 24 || (size >= 18.66 && weight >= 700);
			pairs.push({
				part: own.replace(/\s+/g, " ").slice(0, 40),
				role: large ? "large text" : "text",
				fg: hex(over(fg, back)),
				bg: hex(back),
				ratio: ratio(over(fg, back), back),
				threshold: large ? 3 : 4.5,
			});
		}
		for (let svg of body.querySelectorAll("button svg")) {
			if (!svg.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
			let button = svg.closest("button")!;
			let shape = svg.querySelector("path, circle, rect, line, polyline")!;
			let paint = getComputedStyle(shape).stroke;
			if (!paint || paint === "none") paint = getComputedStyle(shape).fill;
			let fg = parse(paint);
			fg[3] *= opacity(svg);
			let back = mode(button.getBoundingClientRect());
			pairs.push({
				part: `${
					button.getAttribute("aria-label")
					|| (button.matches(".chat-reaction-add") ? "Add-reaction pill" : "button")
				} icon`,
				role: "icon",
				fg: hex(over(fg, back)),
				bg: hex(back),
				ratio: ratio(over(fg, back), back),
				threshold: 3,
			});
		}
		// The toolbar's hairline, at the middle of its start edge, against the shade beside it.
		let toolbar = body.querySelector(".chat-message-toolbar");
		if (toolbar && parseFloat(getComputedStyle(toolbar).opacity) > 0.99) {
			let bar = toolbar.getBoundingClientRect();
			// Its darkest pixel just inside its start edge, where the hairline is drawn.
			let edge = [0, 1, 2].map(step => pixel(bar.left + step, bar.top + bar.height / 2))
				.sort((a, b) => luminance(a) - luminance(b))[0]!;
			let fill = mode(bar);
			pairs.push({
				part: "toolbar edge on the shade",
				role: "toolbar edge",
				fg: hex(edge),
				bg: hex(shade),
				ratio: ratio(edge, shade),
				threshold: 0,
			});
			pairs.push({
				part: "toolbar fill on the shade",
				role: "toolbar",
				fg: hex(fill),
				bg: hex(shade),
				ratio: ratio(fill, shade),
				threshold: toolbarStep,
			});
		}
		return pairs.map(pair => ({ state, ...pair }));
	}, { data: png, element: handle!, state, ground, toolbarStep: TOOLBAR_STEP });
}

/** The transcript's colour at the point `measure` reads a row's shade, while the row is not shown. */
async function groundAt(page: Page, row: Locator): Promise<string> {
	await page.mouse.move(0, 0);
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await expect.poll(() => row.evaluate(node => getComputedStyle(node, "::before").opacity)).toBe(
		"0",
	);
	let point = await row.evaluate(node => {
		let scroller = node.closest("[data-chat-scroll]")!.getBoundingClientRect();
		return { x: scroller.left + 8, y: node.getBoundingClientRect().top + 8 };
	});
	let png = await page.screenshot({ clip: { x: point.x, y: point.y, width: 1, height: 1 } });
	return page.evaluate(async data => {
		let bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
		let bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
		let canvas = new OffscreenCanvas(1, 1);
		let context = canvas.getContext("2d")!;
		context.drawImage(bitmap, 0, 0);
		let d = context.getImageData(0, 0, 1, 1).data;
		return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
	}, png.toString("base64"));
}

function below(pairs: Pair[], step: number): string[] {
	if (OUT) { for (let pair of pairs) appendFileSync(OUT, JSON.stringify(pair) + "\n"); }
	return pairs
		.filter(pair => pair.role === "shade" ? pair.ratio < step : pair.ratio < pair.threshold)
		.map(pair =>
			`${pair.state}: ${pair.role} "${pair.part}" ${pair.fg} on ${pair.bg} is ${pair.ratio}:1`
		);
}

test("a shown Chat row is a shade people can see, and every text and icon on it meets AA", async ({ join, seed }) => {
	await seed("# Rows\n", { transcript: transcript() });
	let page = await join("ana", { reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
	await page.evaluate(() => document.fonts.ready);
	let first = message(page, "ben-1");
	let second = message(page, "ben-2");
	let agent = message(page, "agent-1");
	await expect(message(page, "ana-1")).toBeVisible();
	let failures: string[] = [];

	// Hovered: a person's first message, with its name line, and the one after it, with its time in the gutter.
	for (
		let [row, state] of [[first, "hovered"], [second, "hovered, grouped"], [
			agent,
			"hovered, agent",
		]] as const
	) {
		let ground = await groundAt(page, row);
		await row.locator("[data-chat-message-text]").hover();
		await expect(row.getByRole("toolbar")).toHaveCSS("opacity", "1");
		failures.push(...below(await measure(page, row, state, ground), HOVER_STEP));
	}

	// Its menu open, the pointer gone.
	let ground = await groundAt(page, first);
	await first.locator("[data-chat-message-text]").hover();
	await first.getByRole("button", { name: "Message actions" }).click();
	await expect(page.getByRole("menu")).toBeVisible();
	await page.mouse.move(0, 0);
	failures.push(...below(await measure(page, first, "menu open", ground), HOVER_STEP));
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toHaveCount(0);

	// Jumped to: the transcript washes the row it scrolls to (held here at its full strength).
	ground = await groundAt(page, second);
	await second.evaluate(node => {
		let tint = document.createElement("span");
		tint.className = "chat-source-tint";
		tint.style.animation = "none";
		node.setAttribute("data-chat-source", "");
		node.prepend(tint);
	});
	failures.push(...below(await measure(page, second, "jumped to", ground), HOVER_STEP));
	await second.evaluate(node => node.querySelector(".chat-source-tint")!.remove());

	// Its thread open: the root keeps the selected wash, resting and hovered, and the thread's rows.
	ground = await groundAt(page, first);
	await first.locator("[data-chat-message-text]").hover();
	await first.getByRole("button", { name: "Reply in thread" }).click();
	let panel = page.locator("[data-thread-panel]");
	await expect(panel).toBeVisible();
	await chatInput(panel).fill(
		"Booked for three, with `drill.ts` and [notes](https://example.com).",
	);
	await panel.getByRole("button", { name: "Send message" }).click();
	let reply = panel.locator(".chat-message-body", { hasText: "Booked for three" });
	await expect(reply).toBeVisible();
	await page.mouse.move(0, 0);
	failures.push(...below(await measure(page, first, "thread open", ground), SELECTED_STEP));
	await first.locator("[data-chat-message-text]").hover();
	await expect(first.getByRole("toolbar")).toHaveCSS("opacity", "1");
	failures.push(
		...below(await measure(page, first, "thread open, hovered", ground), SELECTED_STEP),
	);

	let threadGround = await groundAt(page, reply);
	await reply.locator("[data-chat-message-text]").hover();
	await expect(reply.getByRole("toolbar")).toHaveCSS("opacity", "1");
	failures.push(
		...below(await measure(page, reply, "thread reply, hovered", threadGround), HOVER_STEP),
	);

	expect(failures).toEqual([]);
});

test("on a phone a row brought up by a long press is a shade people can see, and everything on it meets AA", async ({ join, seed }) => {
	await seed("# Rows\n", { transcript: transcript() });
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).click();
	await expect.poll(async () => (await chatOf(page).boundingBox())?.x).toBe(0);
	await page.evaluate(() => document.fonts.ready);
	let failures: string[] = [];
	for (let [id, state] of [["ben-1", "phone, held"], ["agent-1", "phone, held, agent"]] as const) {
		let row = message(page, id);
		await row.scrollIntoViewIfNeeded();
		let ground = await groundAt(page, row);
		let box = (await row.locator("[data-chat-message-text]").boundingBox())!;
		let session = await page.context().newCDPSession(page);
		let point = { x: box.x + 24, y: box.y + Math.min(8, box.height / 2) };
		await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
		await page.waitForTimeout(700);
		await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await session.detach();
		await expect(row.getByRole("toolbar")).toBeVisible();
		await expect.poll(() => row.evaluate(node => getComputedStyle(node, "::before").opacity)).toBe(
			"1",
		);
		failures.push(...below(await measure(page, row, state, ground), HOVER_STEP));
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		await page.mouse.click(1, 1).catch(() => {});
	}
	expect(failures).toEqual([]);
});
