/**
 * Undo and redo in a shared document.
 *
 * Each person undoes only their own edits. `packages/editor/src/history.test.ts`
 * covers which transactions are tracked; this covers the keyboard path, two
 * real peers, and the server accepting what an undo sends.
 */

import { storedAcceptedComment, storedQuestion } from "../apps/server/src/testing/plan";
import { readSource } from "./database";
import { content, expect, test, written } from "./room";

import type { Page } from "@playwright/test";

const UNDO = "ControlOrMeta+z";
const REDO = "ControlOrMeta+Shift+z";

/** Put the caret at the end of the paragraph that reads `text`. */
async function caretAfter(page: Page, text: string) {
	let paragraph = content(page).locator("p").filter({ hasText: text });
	await paragraph.click();
	await page.keyboard.press("End");
}

/** Send one request on a second socket of this page's session and await its reply. */
async function request(page: Page, room: string, frame: Record<string, unknown>) {
	return page.evaluate(async ({ room, frame }) => {
		let url = new URL("/ws", location.href);
		url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("channel", room);
		let socket = new WebSocket(url);
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", reject, { once: true });
		});
		let ask = (input: Record<string, unknown>) =>
			new Promise<Record<string, unknown>>((resolve, reject) => {
				let rid = crypto.randomUUID();
				let timeout = setTimeout(() => reject(new Error(`no reply for ${input.kind}`)), 10_000);
				socket.addEventListener("message", event => {
					let reply = JSON.parse(event.data as string) as Record<string, unknown>;
					if (reply.rid !== rid) return;
					clearTimeout(timeout);
					resolve(reply);
				});
				socket.send(JSON.stringify({ ...input, rid, ts: 0 }));
			});
		await ask({ kind: "plan:open" });
		let reply = await ask(frame);
		socket.close();
		return reply;
	}, { room, frame });
}

test("undo and redo reverse my own typing", async ({ join, room, seed }) => {
	await seed("Storage goes on disk.\n");
	let ana = await join("ana");

	await caretAfter(ana, "Storage goes on disk.");
	await ana.keyboard.type(" As MDX.");
	await expect(content(ana)).toContainText("Storage goes on disk. As MDX.");

	await ana.keyboard.press(UNDO);
	await expect(content(ana)).not.toContainText("As MDX.");
	await expect(content(ana)).toContainText("Storage goes on disk.");
	await written(ana, room, /^Storage goes on disk\.\s*$/);

	await ana.keyboard.press(REDO);
	await expect(content(ana)).toContainText("Storage goes on disk. As MDX.");
	await written(ana, room, "Storage goes on disk. As MDX.");
});

test("my undo leaves a peer's edit alone", async ({ join, room, seed }) => {
	await seed("Ana writes here.\n\nBo writes here.\n");
	let ana = await join("ana");
	let bo = await join("bo");

	await caretAfter(ana, "Ana writes here.");
	await ana.keyboard.type(" Mine.");
	await expect(content(bo)).toContainText("Ana writes here. Mine.");

	await caretAfter(bo, "Bo writes here.");
	await bo.keyboard.type(" Theirs.");
	await expect(content(ana)).toContainText("Bo writes here. Theirs.");

	await content(ana).locator("p").filter({ hasText: "Ana writes here." }).click();
	await ana.keyboard.press(UNDO);

	await expect(content(ana)).not.toContainText("Mine.");
	await expect(content(bo)).not.toContainText("Mine.");
	await expect(content(ana)).toContainText("Bo writes here. Theirs.");
	await expect(content(bo)).toContainText("Bo writes here. Theirs.");
	await written(ana, room, "Bo writes here. Theirs.");
});

test("undo beside a stored accepted decision leaves it in place", async ({ join, page, room, seed }) => {
	let quote = "Keep the pilot reversible.";
	// Comments are no longer accepted, but stored decisions still project into the plan.
	// The server-authored edit arriving mid-history is covered by the option test below.
	let stored = await storedAcceptedComment(`${quote}\n`, quote, {
		by: "ana",
		text: "Record this.",
	});
	await seed(stored.source, { threads: [stored.thread] });
	let resets = 0;
	page.on("websocket", socket =>
		socket.on("framereceived", ({ payload }) => {
			if (typeof payload === "string" && payload.includes('"kind":"plan:reset"')) resets++;
		}));
	let ana = await join("ana");

	await caretAfter(ana, quote);
	await ana.keyboard.press("Enter");
	await ana.keyboard.type("Fresh prose.");
	await written(ana, room, "Fresh prose.");
	await written(ana, room, "<Decision");
	let decision = ana.locator("[data-plan-comment-card]").filter({ hasText: "Record this." });
	await expect(decision).toBeVisible();

	await content(ana).locator("p").filter({ hasText: "Fresh prose." }).click();
	await ana.keyboard.press(UNDO);
	await ana.keyboard.press(UNDO);

	await expect(content(ana)).not.toContainText("Fresh prose.");
	await expect(decision).toBeVisible();
	await expect.poll(() => readSource(Number(new URL(ana.url()).port), room))
		.not.toContain("Fresh prose.");
	await written(ana, room, "<Decision");
	expect(resets).toBe(0);
});

const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";
const DEFINITION = {
	questions: [{
		id: QUESTION,
		header: "Rollout",
		question: "How should we deploy?",
		multiple: false,
		options: [{ id: OPTION, label: "Canary", description: "" }],
	}],
};
const CARD = `<Questionnaire id="${WIDGET}" by="ana">
<Question id="${QUESTION}" header="Rollout" prompt="How should we deploy?" multiple="false">
<Option id="${OPTION}" label="Canary" />
</Question>
</Questionnaire>`;

test("undo past an option the server added is accepted by the server", async ({ join, page, room, seed }) => {
	let quote = "Keep the pilot reversible.";
	await seed(`${quote}\n\n${CARD}\n`, {
		revision: 1,
		questions: [{
			id: WIDGET,
			definition: DEFINITION,
			status: "open",
			origin: "planner",
			history: [],
			optionOrigins: {},
			editors: [],
		}],
		openQuestions: [{
			definition: DEFINITION,
			id: WIDGET,
			model: storedQuestion(DEFINITION),
			revision: 0,
			widget: WIDGET,
		}],
	});
	let resets = 0;
	page.on("websocket", socket =>
		socket.on("framereceived", ({ payload }) => {
			if (typeof payload === "string" && payload.includes('"kind":"plan:reset"')) resets++;
		}));
	let ana = await join("ana");

	await caretAfter(ana, quote);
	await ana.keyboard.press("Enter");
	await ana.keyboard.type("Fresh prose.");
	await written(ana, room, "Fresh prose.");

	// The server writes the option into the questionnaire projection after the typing.
	let added = await request(ana, room, {
		kind: "question:option",
		id: WIDGET,
		question: QUESTION,
		key: "undo-option-key",
		label: "Blue-green",
	});
	expect(added.ok).toBe(true);
	await written(ana, room, 'label="Blue-green"');

	await content(ana).locator("p").filter({ hasText: "Fresh prose." }).click();
	await ana.keyboard.press(UNDO);
	await ana.keyboard.press(UNDO);

	await expect(content(ana)).not.toContainText("Fresh prose.");
	await expect.poll(() => readSource(Number(new URL(ana.url()).port), room))
		.not.toContain("Fresh prose.");
	await written(ana, room, 'label="Blue-green"');
	expect(resets).toBe(0);
});
