/**
 * Slice 5: a scripted Planner turn through the real host tools, chat
 * projection, and sockets, against the isolated `AGENT=on` harness project.
 */
import { FAKE_MCP_PORT, PULL_REQUESTS } from "./harness/fixtures";
import { expect, ready, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

test("a scripted Planner turn reaches read_plan and list_pull_requests through real host tools and sockets", async ({ join, page, seed }) => {
	await seed("# Harness parent\nThe harp needs new strings.\n");

	let toolFrames: Chat.Tool[] = [];
	let stateFrames: Chat.State[] = [];
	let deltaFrames: Chat.Delta[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind: string };
				if (frame.kind === "chat:tool") toolFrames.push(frame as Chat.Tool);
				if (frame.kind === "chat:state") stateFrames.push(frame as Chat.State);
				if (frame.kind === "chat:delta") deltaFrames.push(frame as Chat.Delta);
			}
			route.send(message);
		});
	});

	let opened = await join("ana");
	let chat = chatPane(opened);
	let draft = chat.getByPlaceholder("Use @chopin to ask Chopin");
	await draft.fill("@chopin what does the plan say, and what is the latest pull request?");
	await chat.getByRole("button", { name: "Send message" }).click();

	await expect.poll(() => stateFrames.some(frame => frame.busy)).toBe(true);
	await expect.poll(() =>
		toolFrames.some(frame =>
			frame.activity.name === "read_plan" && frame.activity.status === "running"
		)
	).toBe(true);
	await expect.poll(() =>
		toolFrames.some(frame =>
			frame.activity.name === "read_plan" && frame.activity.status === "done"
		)
	).toBe(true);
	await expect.poll(() =>
		toolFrames.some(
			frame => frame.activity.name === "list_pull_requests" && frame.activity.status === "running",
		)
	).toBe(true);
	await expect.poll(() =>
		toolFrames.some(frame =>
			frame.activity.name === "list_pull_requests" && frame.activity.status === "done"
		)
	).toBe(true);

	await expect(chat.getByText("Harness parent", { exact: false })).toBeVisible();
	await expect(chat.getByText(PULL_REQUESTS[0]!.title, { exact: false })).toBeVisible();
	await expect.poll(() => stateFrames.at(-1)?.busy).toBe(false);

	let streamedText = deltaFrames.map(frame => frame.text).join("");
	expect(streamedText).toContain("Harness parent");
	expect(streamedText).toContain(PULL_REQUESTS[0]!.title);

	let calls = await (await fetch(`http://127.0.0.1:${FAKE_MCP_PORT}/__calls__`)).json() as {
		method: string;
		toolName?: string;
		arguments?: { owner?: string; repo?: string };
		hasBearer: boolean;
		readonly: string | null;
		toolsets: string | null;
	}[];
	let listCall = calls.find(call => call.toolName === "list_pull_requests");
	expect(listCall?.hasBearer).toBe(true);
	expect(listCall?.readonly).toBe("true");
	expect(listCall?.toolsets).toBe("pull_requests");
	expect(listCall?.arguments?.owner).toBe("octo-org");
	expect(listCall?.arguments?.repo).toBe("score");
	expect(calls.some(call => call.toolName === "search_code")).toBe(false);

	await opened.reload();
	await ready(opened);
	let reloadedChat = chatPane(opened);
	await expect(reloadedChat.getByText("Harness parent", { exact: false })).toBeVisible();
	await expect(reloadedChat.getByText(PULL_REQUESTS[0]!.title, { exact: false })).toBeVisible();
});
