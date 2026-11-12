/**
 * Text in angle brackets that is not HTML (a generic type, a comparison, a placeholder) shows as
 * it was written wherever Chopin draws someone's or the Planner's words: a sent message, a reply
 * in a thread, the Planner's reply and a build task. None of it is ever drawn as HTML.
 */

import { chatInput, fillChat } from "./chat-input";
import { failedBuild } from "./build-seed";
import { expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";
import type { Chat } from "../packages/protocol/index";
import type { Graph } from "../apps/server/src/tasks/graphs";

const GENERIC = "Option<u64>";
const NESTED = "Vec<Result<T, E>>";
const COMPARISON = "x < y && y > z";
const PLACEHOLDER = "<not-a-tag>";
const ALL = [GENERIC, NESTED, COMPARISON, PLACEHOLDER];
const SENTENCE = `Returns ${GENERIC} or ${NESTED} when ${COMPARISON}, else ${PLACEHOLDER}.`;

function graph(): Graph {
	return {
		versions: [{
			number: 1,
			revision: 1,
			planRevision: 0,
			state: "draft",
			definition: {
				tasks: [{
					id: "connect",
					title: `Return ${GENERIC} from parse`,
					context: "The parser reads one value at a time.",
					goal: `Collect ${NESTED} and keep ${COMPARISON}.`,
					acceptance: [`A missing value is ${PLACEHOLDER}.`, "A present value is returned."],
					dependsOn: [],
				}],
			},
		}],
	};
}

function reply(): Chat.Entry[] {
	return [{
		id: "planner",
		author: { kind: "agent" },
		text: `Planned: ${SENTENCE}\n\n${PLACEHOLDER}\n**Still bold** after it.`,
		ts: 1_700_000_000,
	}];
}

function chatPane(page: Page): Locator {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

async function send(scope: Locator, text: string): Promise<void> {
	await fillChat(chatInput(scope), text);
	await scope.getByRole("button", { name: "Send message" }).click();
}

async function expectVerbatim(body: Locator): Promise<void> {
	for (let text of ALL) await expect(body).toContainText(text);
	await expect(body.locator("u64, not-a-tag, result")).toHaveCount(0);
}

test("text in angle brackets shows as written in Chat, a thread, the Planner's reply and a build task", async ({ join, seed }) => {
	let tasks = graph();
	await seed("# Angle brackets\n\nText with angle brackets.\n", {
		transcript: reply(),
		graph: tasks,
		builds: [failedBuild(tasks)],
	});
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	let main = chatPane(page).locator(".chat-split-main");

	// The build task's title, its accessible name, its goal and its acceptance.
	let controls = page.getByRole("group", { name: "Document view", exact: true });
	await expect(controls.getByRole("button")).toHaveText(["Document", "Decisions", "Build"]);
	await controls.getByRole("button", { name: "Build", exact: true }).click();
	let view = page.getByRole("region", { name: "Build", exact: true });
	let toggle = view.getByRole("button", { name: /^Return Option<u64> from parse/ });
	await expect(toggle).toHaveText(`Return ${GENERIC} from parse`);
	await toggle.click();
	await expect(view).toContainText(`Collect ${NESTED} and keep ${COMPARISON}.`);
	await expect(view).toContainText(`A missing value is ${PLACEHOLDER}.`);
	await expect(view.locator("u64, not-a-tag, result")).toHaveCount(0);
	await controls.getByRole("button", { name: "Document", exact: true }).click();

	// The Planner's reply, including a line that starts like a tag and the Markdown under it.
	let planner = main.locator('.chat-message-body[data-chat-message-id="planner"]');
	await expectVerbatim(planner);
	await expect(planner.locator("strong")).toHaveText("Still bold");

	// A message someone sends, and one that is nothing but a placeholder.
	await send(main, SENTENCE);
	let sent = main.locator(`.chat-message-body[data-chat-raw="${SENTENCE}"]`);
	await expectVerbatim(sent);
	await send(main, PLACEHOLDER);
	await expect(
		main.locator(`.chat-message-body[data-chat-raw="${PLACEHOLDER}"] [data-chat-markdown]`),
	).toHaveText(PLACEHOLDER);

	// A reply in a thread.
	await sent.hover();
	await sent.getByRole("button", { name: "Reply in thread" }).click();
	let panel = page.locator("[data-thread-panel]");
	await expect(panel).toBeVisible();
	await send(panel, `In the thread: ${SENTENCE}`);
	await expectVerbatim(
		panel.locator(`.chat-message-body[data-chat-raw="In the thread: ${SENTENCE}"]`),
	);
});
