/** Stress the durable prose link while nearby document text changes. */

import { content, expect, test, written } from "./room";
import { openJevWire, sendChat, wireFrames, wireRequest } from "./jev-wire";
import { resetPlannerJobs, scriptJob } from "./planner-jobs";
import * as Y from "../apps/server/node_modules/yjs";
import * as PlanRoom from "../apps/server/src/plan/room";
import { readSource } from "./database";

import type { Plan } from "../packages/protocol/index";
import type { Page, WebSocketRoute } from "@playwright/test";

const QUESTION = "Should we ship a small pilot?";
const OPTION = "Start with a small pilot.";
const MARKED_PROSE = "We chose the reversible pilot.";
type ClientNode = {
	getType(): string;
	getChildren(): ClientNode[];
	getDecision?(): { id: string };
	remove(): void;
};
type EditorInternals = { _nodeMap: Map<string, ClientNode> };

function marker(page: Page) {
	return page.getByRole("button", { name: `Decision: ${OPTION}`, exact: true });
}

function prose(page: Page) {
	return content(page).locator("p").filter({ hasText: `We decided: ${OPTION}` });
}

function commentDecision(page: Page) {
	return page.locator("[data-plan-comment-card]").filter({ hasText: "Keep this choice recorded." });
}

function port(page: Page): number {
	return Number(new URL(page.url()).port);
}

async function decide(page: Page, room: string) {
	await scriptJob("prose", [{
		tool: "write_decision_prose",
		args: { revision: "$revision", id: "$target", text: `We decided: ${OPTION}` },
	}]);
	await openJevWire(page, room);
	await sendChat(page, QUESTION);
	await sendChat(page, OPTION);
	let card = page.locator('[data-document-view="plan"] article[data-plan-sidecar-questionnaire]')
		.filter({ has: page.getByRole("heading", { name: QUESTION, exact: true }) });
	await expect(card).toBeVisible();
	await card.getByText(OPTION, { exact: true }).click();
	await card.getByRole("button", { name: "Save", exact: true }).click();
	await expect(prose(page)).toBeVisible();
	await expect(marker(page)).toBeVisible();
}

async function latestDocumentSnapshot(page: Page, room: string): Promise<Plan.Open.Reply> {
	await openJevWire(page, room);
	await expect.poll(async () => (await wireFrames(page)).some(frame => frame.kind === "plan:open"))
		.toBe(true);
	let frame = (await wireFrames(page)).findLast(item => item.kind === "plan:open");
	expect(frame).toBeTruthy();
	return frame as unknown as Plan.Open.Reply;
}

function expectLinked(snapshot: Plan.Open.Reply, widget?: string): string {
	let linked = snapshot.prose!.find(entry =>
		(!widget || entry.widget === widget) && entry.anchors.length > 0
	);
	expect(linked).toBeTruthy();
	expect(linked?.orphaned).toBe(false);
	expect(snapshot.anchors.some(entry => entry.widget === linked?.widget)).toBe(true);
	return linked!.widget;
}

async function placeCaretAtParagraphEnd(page: Page, textContent: string) {
	return content(page).evaluate((root, expectedText) => {
		let paragraph = [...root.querySelectorAll(":scope > p")].find(
			item => item.textContent === expectedText,
		);
		let text = paragraph?.querySelector("[data-lexical-text]")?.firstChild;
		if (!(text instanceof Text)) throw new Error("the destination paragraph has no text node");
		let selection = window.getSelection();
		if (!selection) throw new Error("selection unavailable");
		(root as HTMLElement).focus();
		let range = document.createRange();
		range.setStart(text, text.data.length);
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
		return {
			active: document.activeElement === root,
			anchor: selection.anchorNode === text,
			atEnd: selection.anchorOffset === text.data.length,
			paragraph: paragraph?.textContent ?? null,
			contentEditable: (root as HTMLElement).contentEditable,
		};
	}, textContent);
}

async function expectResolvedDecision(page: Page, room: string) {
	await expect(marker(page)).toBeVisible();
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let history = page.getByRole("button", { name: "1 resolved", exact: true });
	if (await history.getAttribute("aria-expanded") !== "true") await history.click();
	await expect(history).toHaveAttribute("aria-expanded", "true");
	let resolved = page.locator(
		'[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]',
	).filter({ has: page.getByText(QUESTION, { exact: true }) });
	await expect(resolved.getByText(QUESTION, { exact: true })).toBeVisible();
	await expect(resolved).toContainText(OPTION);
	let widget = await resolved.getAttribute("data-plan-sidecar-questionnaire");
	if (!widget) throw new Error("resolved decision id missing");
	expectLinked(await latestDocumentSnapshot(page, room), widget);
	await page.getByRole("button", { name: "Document", exact: true }).click();
}

test.beforeEach(async () => {
	await resetPlannerJobs();
});

test.afterEach(async () => {
	await resetPlannerJobs();
});

test("a custom browser update cannot remove an accepted Decision projection", async ({ join, page, room, seed }) => {
	await seed(`${MARKED_PROSE}\n`);
	let appFrames: Array<Record<string, unknown>> = [];
	let browserSocket: WebSocketRoute | undefined;
	let resolveOpen: ((frame: Plan.Open.Reply) => void) | undefined;
	let resolveReset: (() => void) | undefined;
	let waitForPlanOpen = () => new Promise<Plan.Open.Reply>(resolve => resolveOpen = resolve);
	let waitForReset = () => new Promise<void>(resolve => resolveReset = resolve);
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		browserSocket = server;
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Record<string, unknown>;
				appFrames.push(frame);
				if (frame.kind === "plan:open" && resolveOpen) {
					let resolve = resolveOpen;
					resolveOpen = undefined;
					resolve(frame as unknown as Plan.Open.Reply);
				}
				if (frame.kind === "plan:reset" && resolveReset) {
					let resolve = resolveReset;
					resolveReset = undefined;
					resolve();
				}
			}
			route.send(message);
		});
	});

	let editor = await join("ana");
	let other = await join("ben");
	await openJevWire(editor, room);
	let started = await wireRequest(editor, {
		kind: "comment:start",
		blocks: [0],
		quote: MARKED_PROSE,
		offset: 0,
		length: MARKED_PROSE.length,
		text: "Keep this choice recorded.",
	});
	expect(started.ok).toBe(true);
	let threadId = (started.thread as { id: string }).id;
	let accepted = await wireRequest(editor, { kind: "comment:accept", id: threadId });
	expect(accepted.ok).toBe(true);
	await expect(content(editor)).toContainText(MARKED_PROSE);
	await expect(content(other)).toContainText(MARKED_PROSE);
	await expect(commentDecision(editor)).toContainText(MARKED_PROSE);
	await expect(commentDecision(other)).toContainText(MARKED_PROSE);
	await written(editor, room, "<Decision");

	let openReply = waitForPlanOpen();
	await editor.reload();
	let snapshot = await openReply;
	await expect(content(editor)).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });
	let source = await readSource(port(editor), room);
	let client = await PlanRoom.restore(
		snapshot.epoch,
		Buffer.from(snapshot.update, "base64"),
		source,
		[],
	);
	let before = Y.encodeStateVector(client.doc);
	let decisionId = "";
	let decision: ClientNode | undefined;
	client.editor.getEditorState().read(() => {
		let root = (client.editor.getEditorState() as unknown as EditorInternals)._nodeMap.get("root");
		decision = root?.getChildren().find(node =>
			node.getType() === "plan-decision" && node.getDecision?.().id === threadId
		);
		if (decision) decisionId = decision.getDecision!().id;
	});
	if (!decision) throw new Error("accepted Decision is missing from the opened Yjs state");
	client.editor.update(() => decision!.remove(), { discrete: true });
	await PlanRoom.settle();
	let update = Y.encodeStateAsUpdate(client.doc, before);
	expect(PlanRoom.project(client)).not.toContain(`id="${decisionId}"`);
	expect(update.byteLength).toBeGreaterThan(3);
	client.doc.destroy();
	let rid = crypto.randomUUID();
	let rejectedReset = waitForReset();
	browserSocket?.send(JSON.stringify({
		kind: "plan:update",
		ts: 0,
		rid,
		id: crypto.randomUUID(),
		epoch: snapshot.epoch,
		update: Buffer.from(update).toString("base64"),
	}));
	await rejectedReset;
	expect(appFrames.some(frame => frame.kind === "plan:ack" && frame.rid === rid)).toBe(false);
	expect(appFrames.some(frame => frame.kind === "plan:reset")).toBe(true);
	await expect(content(editor)).toContainText(MARKED_PROSE);
	await expect(content(other)).toContainText(MARKED_PROSE);
	await expect(commentDecision(editor)).toContainText(MARKED_PROSE);
	await expect(commentDecision(other)).toContainText(MARKED_PROSE);
	await expect.poll(() => readSource(port(editor), room)).toMatch(
		new RegExp(`<Decision[^>]*id="${decisionId}"`),
	);
	await expect.poll(() => readSource(port(editor), room)).toContain(MARKED_PROSE);

	await editor.reload();
	await expect(content(editor)).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });
	await expect(content(editor)).toContainText(MARKED_PROSE);
	await expect(commentDecision(editor)).toContainText(MARKED_PROSE);
	await openJevWire(editor, room);
	let synced = (await wireFrames(editor)).findLast(frame => frame.kind === "comment:sync") as {
		threads?: Array<{ id: string; status: string; quote?: string }>;
	} | undefined;
	expect(synced?.threads).toContainEqual(expect.objectContaining({
		id: threadId,
		status: "accepted",
		quote: MARKED_PROSE,
	}));
	await expect(content(other)).toContainText(MARKED_PROSE);
	await expect(commentDecision(other)).toContainText(MARKED_PROSE);
});

test(
	"adjacent edits and a reconnect preserve a resolved decision's prose anchor",
	async ({ join, page, room }, testInfo) => {
		let sockets: WebSocketRoute[] = [];
		await page.routeWebSocket("**/ws?**", route => {
			route.connectToServer();
			sockets.push(route);
		});
		let editor = await join("ana");
		await decide(editor, room);
		let other = await join("ben");
		await expect(marker(other)).toBeVisible();
		let widget = expectLinked(await latestDocumentSnapshot(editor, room));

		// Create a following line, then use one Backspace to join it to the decision.
		let trailing = content(editor).locator(":scope > p").last();
		await trailing.click();
		await editor.keyboard.type("Following detail.");
		let following = content(editor).locator("p").filter({ hasText: "Following detail." });
		await expect(following).toHaveText("Following detail.");
		await editor.keyboard.press(process.platform === "darwin" ? "Meta+ArrowLeft" : "Home");
		await editor.keyboard.press("Backspace");
		await editor.keyboard.type(" More detail.");
		await expect(prose(editor)).toContainText(`We decided: ${OPTION} More detail.`);
		await expect(prose(other)).toContainText("More detail.");
		await expect(marker(other)).toBeVisible();
		widget = expectLinked(await latestDocumentSnapshot(editor, room), widget);

		// Shift the associated paragraph down by inserting context above it.
		let leading = content(editor).locator(":scope > p").first();
		await expect(leading).toBeEmpty();
		await leading.click();
		await editor.keyboard.type("Earlier context.");
		let context = content(editor).locator("p").filter({ hasText: "Earlier context." });
		await expect(context).toHaveText("Earlier context.");
		let order = await content(editor).locator("p").allTextContents();
		expect(order.findIndex(text => text.includes("Earlier context."))).toBeLessThan(
			order.findIndex(text => text.includes(`We decided: ${OPTION}`)),
		);
		await expect(marker(editor)).toBeVisible();
		await expect(marker(other)).toBeVisible();
		widget = expectLinked(await latestDocumentSnapshot(editor, room), widget);

		// An edited anchored paragraph should retain the same live relation.
		await prose(editor).click();
		await editor.keyboard.press("End");
		await editor.keyboard.type(" Still the same decision.");
		await expect(prose(editor)).toContainText("Still the same decision.");
		await expect(prose(other)).toContainText("Still the same decision.");
		widget = expectLinked(await latestDocumentSnapshot(editor, room), widget);
		await expectResolvedDecision(editor, room);

		// Drop the UI connection and let the provider reopen the document itself.
		await sockets[0]!.close();
		await expect(content(editor)).toHaveAttribute("contenteditable", "false");
		await expect(content(editor)).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });
		await prose(editor).click();
		await editor.keyboard.press("End");
		await editor.keyboard.type(" After reconnect.");
		await expect(prose(editor)).toContainText("After reconnect.");
		await expect(prose(other)).toContainText("After reconnect.");
		widget = expectLinked(await latestDocumentSnapshot(editor, room), widget);

		await editor.reload();
		await expect(prose(editor)).toContainText("After reconnect.");
		await expect(prose(other)).toContainText("After reconnect.");
		await expect(marker(other)).toBeVisible();
		await expectResolvedDecision(editor, room);
		expectLinked(await latestDocumentSnapshot(editor, room), widget);
		let followingBlock = content(editor).locator("p").filter({ hasText: "Following detail." });
		await followingBlock.click();
		await editor.keyboard.press("End");
		await editor.mouse.move(40, 650);
		await editor.screenshot({ path: testInfo.outputPath("decision-anchor-after-edits.png") });
	},
);

test(
	"cut and paste carries the decision anchor with the moved prose",
	async ({ context, join, room }, testInfo) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		let page = await join("ana");
		await decide(page, room);
		let widget = expectLinked(await latestDocumentSnapshot(page, room));
		let contextParagraph = content(page).locator(":scope > p").last();
		await contextParagraph.click();
		await page.keyboard.type("Move destination.");
		await expect(contextParagraph).toHaveText("Move destination.");
		let beforeMove = await content(page).locator(":scope > p").allTextContents();
		expect(beforeMove.findIndex(text => text.includes(`We decided: ${OPTION}`))).toBeLessThan(
			beforeMove.findIndex(text => text === "Move destination."),
		);

		await prose(page).selectText();
		await page.keyboard.press("ControlOrMeta+X");
		await expect(content(page)).not.toContainText(`We decided: ${OPTION}`);
		let destination = content(page).locator(":scope > p").filter({
			hasText: /^Move destination\.$/,
		});
		await expect(destination).toHaveCount(1);
		let caret = await placeCaretAtParagraphEnd(page, "Move destination.");
		expect(caret).toEqual({
			active: true,
			anchor: true,
			atEnd: true,
			paragraph: "Move destination.",
			contentEditable: "true",
		});
		await page.keyboard.press("Enter");
		let pasteTarget = destination.locator("xpath=following-sibling::p[1]");
		await expect(pasteTarget).toBeEmpty();
		await expect.poll(async () =>
			pasteTarget.evaluate(paragraph => {
				let selection = window.getSelection();
				let anchor = selection?.anchorNode;
				return selection?.isCollapsed === true && !!anchor
					&& (paragraph === anchor || paragraph.contains(anchor));
			})
		).toBe(true);
		await page.keyboard.press("ControlOrMeta+V");
		let moved = prose(page);
		await expect(moved).toHaveText(`We decided: ${OPTION}`);
		let afterMove = await content(page).locator(":scope > p").allTextContents();
		expect(afterMove.findIndex(text => text === "Move destination.")).toBeLessThan(
			afterMove.findIndex(text => text.includes(`We decided: ${OPTION}`)),
		);
		let snapshot = await latestDocumentSnapshot(page, room);
		let relationship = snapshot.prose!.find(entry => entry.widget === widget);
		expect(relationship).toBeTruthy();
		expect(snapshot.anchors.some(entry => entry.widget === widget)).toBe(true);
		console.log("Post-cut/paste authoritative decision prose:", JSON.stringify(relationship));
		await testInfo.attach("decision-prose-anchor-after-cut-paste.json", {
			body: JSON.stringify(
				{
					relationship,
					decision: snapshot.anchors.find(entry => entry.widget === widget),
				},
				null,
				2,
			),
			contentType: "application/json",
		});
		await page.getByRole("button", { name: /^Decisions/ }).click();
		await expect(page.getByRole("button", { name: "1 resolved", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Document", exact: true }).click();
		await page.screenshot({ path: testInfo.outputPath("decision-anchor-after-cut-paste.png") });
		await moved.scrollIntoViewIfNeeded();
		let glyph = await moved.evaluate(paragraph => {
			let range = document.createRange();
			range.selectNodeContents(paragraph);
			let rect = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0);
			if (!rect) throw new Error("moved prose has no rendered text range");
			let x = rect.left + rect.width / 2;
			let y = rect.top + rect.height / 2;
			let target = document.elementFromPoint(x, y);
			return { x, y, hitsProse: !!target && paragraph.contains(target) };
		});
		expect(glyph.hitsProse).toBe(true);
		await page.mouse.move(5, 5);
		await page.mouse.move(glyph.x, glyph.y);
		await expect(page.getByRole("tooltip")).toContainText(QUESTION);
		await page.screenshot({ path: testInfo.outputPath("decision-anchor-after-move-hover.png") });
		expectLinked(await latestDocumentSnapshot(page, room), widget);
	},
);
