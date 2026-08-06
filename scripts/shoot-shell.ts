#!/usr/bin/env bun
/**
 * The shell, photographed at the two widths the design was drawn against.
 *
 * The acceptance for task 005 is a pair of pictures, and a picture taken by
 * hand is one nobody can take again: the room has to hold the same plan, the
 * same questionnaire and the same conversation, or the second photograph is of
 * a different app. So the room is seeded here and the browser is driven to the
 * same place twice, at 1280 and at 1680.
 *
 * It is not part of `bun run ci` because it needs a browser. Run it with
 * `bun run shot:shell`, after `bun run e2e:browsers` once.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { chromium } from "@playwright/test";

import { start } from "./stack";

import type { Page } from "@playwright/test";

const ROOT = dirname(import.meta.dir);

/** Beside the task they answer, which is where the images for 003 to 009 live. */
const SHOTS = join(ROOT, "tasks/images");

/** Beside the rooms the e2e suite invents, and ignored by git for the same reason. */
const DATA = join(ROOT, "e2e/.scratch/shell");
const ROOM = "shell-shot";

const READY_MS = 60_000;

/** 16:10, which is what both of the widths in the acceptance are drawn at. */
const WIDTHS = [1280, 1680];

/**
 * Enough plan to fill the page and not so much that it fills the window.
 *
 * The subject is the shell, so the prose stops well above the fold: a page of
 * text running to the bottom edge would hide the one thing the picture is of,
 * which is that the page does too.
 */
const PLAN = `# Export format

Two layers only. One ground carries the nav and both rails; the page is the
single thing that sits on top of it.

## What we settled

Markdown for now, with a JSON sidecar for anchors.
`;

/**
 * A conversation, written to the sidecar rather than typed into the composer.
 *
 * `chat:send` is gated on there being an agent and this runs with `AGENT=off`,
 * so nothing typed into the room would reach the transcript. The transcript is
 * restored from `state.json` on open, which is the same door — and a fixed
 * clock, so two runs a minute apart produce the same picture.
 */
const AT = Date.parse("2026-08-06T13:34:00Z") / 1000; // Seconds: `when` in `transcript.tsx` scales.
const TRANSCRIPT = [
	{
		id: "s1",
		author: { kind: "member", handle: "ana" },
		ts: AT,
		text: "@ai is anything in data/ committed to the repo?",
	},
	{
		id: "s2",
		author: { kind: "agent" },
		ts: AT + 60,
		text: "No — data/ is in .gitignore, explicitly commented as “local scratch.”",
	},
	{
		id: "s3",
		author: { kind: "member", handle: "bo" },
		ts: AT + 120,
		text: "good. @ai add a line to the readme",
	},
];

/** Open on a room that is finished loading, at the size asked for. */
async function ready(page: Page, base: string, width: number): Promise<void> {
	await page.setViewportSize({ width, height: Math.round((width * 10) / 16) });
	// A handle here is unverified, so `github.com/<handle>.png` is a stranger's
	// photograph or a 404 depending on the day. Refused, so `Face` draws the
	// initials it falls back to and the picture is the same without a network.
	await page.route("https://github.com/**", route => route.abort());
	await page.goto(`${base}/r/${ROOM}?as=ana`);

	let content = page.getByRole("textbox", { name: "editable markdown" });
	// readOnly is offline || busy || !synced, so an editable surface is the room
	// being open — the same fact `e2e/room.ts` waits on.
	await content.waitFor({ state: "visible", timeout: READY_MS });
	await page.waitForFunction(
		() =>
			document.querySelector('[aria-label="editable markdown"]')
				?.getAttribute("contenteditable") === "true",
		null,
		{ timeout: READY_MS },
	);
	// The questionnaire arrives over the wire after the document does, and the
	// right rail is empty until it lands.
	await page.locator(".plan-decisions").getByRole("article").first().waitFor({ timeout: READY_MS })
		.catch(() => {});
	await page.waitForTimeout(400);
}

rmSync(join(DATA, ROOM), { recursive: true, force: true });
mkdirSync(join(DATA, ROOM), { recursive: true });
writeFileSync(join(DATA, ROOM, "plan.mdx"), PLAN);
writeFileSync(join(DATA, ROOM, "state.json"), JSON.stringify({ transcript: TRANSCRIPT }));
mkdirSync(SHOTS, { recursive: true });

// The right rail is one of the three things being photographed, and an empty
// one would say nothing about whether it is a panel.
let stack = await start({ data: DATA, env: { DEV_QUESTIONS: "1" } });

try {
	let browser = await chromium.launch();

	for (let width of WIDTHS) {
		let page = await browser.newPage();
		await ready(page, stack.base, width);

		let path = join(SHOTS, `005-shell-${width}.png`);
		await page.screenshot({ path });
		console.log(`  ${path.replace(`${ROOT}/`, "")}`);
		await page.close();
	}

	await browser.close();
} finally {
	await stack.stop();
}
