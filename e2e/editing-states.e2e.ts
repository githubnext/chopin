/**
 * A writer can edit the document in every state the page can be in: as whoever opens it, while the
 * Planner is attached, away or running a turn, and after a reload. Each block a document is made of
 * takes typing, deleting, a plain paste and undo in each of them.
 */

import { content, expect, test, written } from "./room";
import { readSource as read } from "./database";

import type { Page } from "@playwright/test";

const DOCUMENT = `# Heading

Paragraph.

- Item

| Name | Note |
| ---- | ---- |
| cell | a    |

<Callout id="01K0N4W3B7P27CBAEC7A8C8WEA" type="note" title="Note">

Inside.

</Callout>

\`\`\`
plain code
\`\`\`
`;

/** Holds the page's view of the Planner where a test puts it, as the server would tell it. */
async function planner(page: Page, state: "attached" | "disconnected" | "running") {
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		let tell = (frame: Record<string, unknown>) => route.send(JSON.stringify(frame));
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			route.send(message);
			if (typeof message !== "string" || !message.includes('"session:hello"')) return;
			tell({
				kind: "session:planner",
				ts: 0,
				planner: { state: state === "disconnected" ? "disconnected" : "attached", login: "ana" },
			});
			if (state === "running") {
				tell({
					kind: "chat:state",
					ts: 0,
					busy: true,
					turn: {
						id: "turn-1",
						handle: "ana",
						started: 1_700_000_001,
						entryOffset: 0,
						responded: false,
					},
				});
			}
		});
	});
}

function readSource(page: Page, room: string) {
	return read(Number(new URL(page.url()).port), room);
}

/** Puts the caret at the end of the text and checks a keystroke, a delete, a paste and undo. */
async function editAt(page: Page, room: string, text: string, label: string) {
	let block = content(page).getByText(text, { exact: true });
	await block.click();
	await page.keyboard.press("End");
	await page.keyboard.type(` ${label}x`);
	await page.keyboard.press("Backspace");
	await page.evaluate(() => navigator.clipboard.writeText("!"));
	await page.keyboard.press("ControlOrMeta+V");
	await written(page, room, new RegExp(`${text} ${label}!`));
	// Undo takes back the burst of typing it was part of, as Notion's does.
	await page.keyboard.press("ControlOrMeta+Z");
	await expect.poll(() => readSource(page, room)).not.toContain(`${label}!`);
}

for (let state of ["plain", "attached", "disconnected", "running", "reloaded"] as const) {
	test(`a writer edits every kind of block (${state})`, async ({ context, join, room, seed }) => {
		await seed(DOCUMENT);
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		let page = await join("ana");
		if (state === "attached" || state === "disconnected" || state === "running") {
			await planner(page, state);
			await page.reload();
		}
		if (state === "reloaded") await page.reload();
		await expect(content(page)).toHaveAttribute("contenteditable", "true");

		let label = state.slice(0, 3);
		await editAt(page, room, "Heading", `h${label}`);
		await editAt(page, room, "Paragraph.", `p${label}`);
		await editAt(page, room, "Item", `l${label}`);
		await editAt(page, room, "cell", `t${label}`);
		await editAt(page, room, "Inside.", `c${label}`);
		await editAt(page, room, "plain code", `k${label}`);
	});
}

test("a second writer edits beside the first", async ({ join, room, seed }) => {
	await seed(DOCUMENT);
	let ana = await join("ana");
	let bo = await join("bo");
	await content(bo).getByText("Paragraph.", { exact: true }).click();
	await bo.keyboard.press("End");
	await bo.keyboard.type(" bo");
	await expect(content(ana).getByText("Paragraph. bo", { exact: true })).toBeVisible();
	await content(ana).getByText("Inside.", { exact: true }).click();
	await ana.keyboard.press("End");
	await ana.keyboard.type(" ana");
	await expect(content(bo).getByText("Inside. ana", { exact: true })).toBeVisible();
	await written(ana, room, /Paragraph\. bo[\s\S]*Inside\. ana/);
});
