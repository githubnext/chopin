import { chatInput } from "./chat-input";
/**
 * Slice 5: a scripted Planner turn through the real host tools, chat
 * projection, and sockets, against the isolated `AGENT=on` harness project.
 */
import { FAKE_MCP_PORT, PULL_REQUESTS } from "./harness/fixtures";
import { content, expect, ready, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page } from "@playwright/test";
import type { Graph } from "../apps/server/src/tasks/graphs";
import type { Implementation } from "../packages/protocol/implementation";

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
	let draft = chatInput(chat);
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

test("tool activity redacts credential text before broadcast and history replay", async ({ join, page, seed }) => {
	await seed(
		'# Credential fixture\n\n```json\n{"password":"synthetic-password","AWS_SECRET_ACCESS_KEY":"synthetic-aws-secret","region":"eu-test-1"}\n```\n',
	);
	let frames = await recordChat(page);
	let opened = await join("ana");
	let chat = chatPane(opened);
	await chatInput(chat).fill("@chopin read the document and latest pull request");
	await chat.getByRole("button", { name: "Send message" }).click();
	await expect.poll(() =>
		frames("chat:tool").some(item =>
			item.frame.activity.name === "read_plan" && item.frame.activity.status === "done"
		)
	).toBe(true);
	let result = frames("chat:tool").find(item =>
		item.frame.activity.name === "read_plan" && item.frame.activity.status === "done"
	)!.frame.activity.result!;
	expect(result).toContain("[redacted]");
	expect(result).toContain("eu-test-1");
	let activity = JSON.stringify(frames("chat:tool"));
	expect(activity).not.toContain("synthetic-password");
	expect(activity).not.toContain("synthetic-aws-secret");
	await expect.poll(() => frames("chat:state").at(-1)?.frame.busy).toBe(false);

	await opened.reload();
	await ready(opened);
	await expect.poll(() => frames("chat:history", 2).length).toBeGreaterThan(0);
	let history = frames("chat:history", 2)[0]!.frame.entries.flatMap(entry => entry.tools ?? []);
	expect(history.find(tool => tool.name === "read_plan")?.result).toBe(result);
	expect(JSON.stringify(history)).not.toContain("synthetic-password");
	expect(JSON.stringify(history)).not.toContain("synthetic-aws-secret");
});

test("the composer marks its destination in the mode switch before sending", async ({ join }) => {
	let opened = await join("ana");
	let chat = chatPane(opened);
	let draft = chatInput(chat);
	let toggle = chat.getByRole("button", { name: "Talk to Chopin", exact: true });
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await draft.fill("should we ask about auth first?");
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await draft.fill("@chopin should we ask about auth first?");
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
});

// Frame order and arrival time are the contract; the browser UI is incidental.
type Seen = { at: number; connection: number; frame: Chat.Outgoing };

async function recordChat(page: Page) {
	let seen: Seen[] = [];
	let connections = 0;
	await page.routeWebSocket("**/ws?**", route => {
		let connection = ++connections;
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Chat.Outgoing;
				if (frame.kind.startsWith("chat:")) seen.push({ at: Date.now(), connection, frame });
			}
			route.send(message);
		});
	});
	return <K extends Chat.Outgoing["kind"]>(kind: K, connection?: number) =>
		seen.filter(item =>
			item.frame.kind === kind && (connection ?? item.connection) === item.connection
		) as Array<
			Seen & { frame: Extract<Chat.Outgoing, { kind: K }> }
		>;
}

async function sendSlowTurn(page: Page) {
	let chat = chatPane(page);
	await chatInput(chat).fill("@chopin SLOW-LIVE show your work");
	await chat.getByRole("button", { name: "Send message" }).click();
}

test("a live Planner turn streams state and a tool row that settles at its own end", async ({ join, page, seed }) => {
	await seed("# Live parent\nThe harp needs new strings.\n");
	let frames = await recordChat(page);
	let opened = await join("ana");
	await sendSlowTurn(opened);

	await expect.poll(
		() =>
			frames("chat:state").some(item => item.frame.busy)
			&& frames("chat:state").some(item => !item.frame.busy && frames("chat:delta").length > 0),
		{ timeout: 20_000 },
	).toBe(true);

	let started = frames("chat:state").find(item => item.frame.busy)!;
	let turn = started.frame.turn!;
	expect(turn.startedAt).toBeGreaterThan(0);
	expect(started.at).toBeLessThan(frames("chat:delta")[0]!.at);
	expect(frames("chat:delta").every(item => !item.frame.text.includes("Considering"))).toBe(true);

	let rows = frames("chat:tool");
	let running = rows.find(item => item.frame.activity.status === "running")!;
	let settled = rows.find(item => item.frame.activity.status === "done")!;
	expect(running.frame.activity.name).toBe("read_plan");
	expect(running.frame.activity.startedAt).toBeGreaterThanOrEqual(turn.startedAt!);
	expect(settled.frame.activity.id).toBe(running.frame.activity.id);

	// The tool ends after its own 2.5s step, well before the 7.5s turn does.
	let took = settled.frame.activity.took!;
	expect(took).toBeGreaterThanOrEqual(2_000);
	expect(took).toBeLessThan(4_500);
	expect(Math.abs(settled.at - running.at - took)).toBeLessThan(1_000);
	expect(settled.at).toBeLessThan(frames("chat:delta").at(-1)!.at);

	let idle = frames("chat:state").find(item => !item.frame.busy && item.at > started.at)!;
	expect(idle.frame.turn).toBeUndefined();
	expect(idle.at).toBeGreaterThan(settled.at);
});

test("a reconnect mid-turn restores the running tool and turn start from history without reasoning", async ({ join, page, seed }) => {
	await seed("# Live parent\nThe harp needs new strings.\n");
	let frames = await recordChat(page);
	let opened = await join("ana");
	await sendSlowTurn(opened);

	await expect.poll(() => frames("chat:tool", 1).length, { timeout: 5_000 }).toBeGreaterThan(0);
	let started = frames("chat:state", 1).find(item => item.frame.busy)!.frame.turn!;
	let running = frames("chat:tool", 1)[0]!.frame.activity;
	await opened.reload();
	await ready(opened);

	await expect.poll(() => frames("chat:history", 2).length, { timeout: 5_000 }).toBeGreaterThan(0);
	let history = frames("chat:history", 2)[0]!.frame;
	let restored = history.entries.flatMap(entry => entry.tools ?? []);
	expect(history.busy).toBe(true);
	expect(history.turn).toMatchObject({ id: started.id, startedAt: started.startedAt });
	expect(restored).toHaveLength(1);
	expect(restored[0]).toMatchObject({
		name: "read_plan",
		status: "running",
		startedAt: running.startedAt,
	});
	expect(JSON.stringify(history)).not.toContain("Considering");

	await expect.poll(() => frames("chat:state", 2).some(item => !item.frame.busy), {
		timeout: 20_000,
	}).toBe(true);
	expect(frames("chat:tool", 2).some(item => item.frame.activity.status === "done")).toBe(true);
});

/** Record the task-draft requests a page sends, and any Chat sends alongside them. */
async function recordDrafts(page: Page) {
	let drafts: Implementation.Draft[] = [];
	let sends: Chat.Send[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind: string };
				if (frame.kind === "implementation:draft") {
					drafts.push(frame as unknown as Implementation.Draft);
				}
				if (frame.kind === "chat:send") sends.push(frame as unknown as Chat.Send);
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	return { drafts, sends };
}

test("opening Build asks the Planner for tasks once, without a Chat message, and offers a retry", async ({ join, page, seed }) => {
	await seed("# Build draft\nThe harp needs new strings.\n");
	let { drafts, sends } = await recordDrafts(page);
	let opened = await join("ana");
	let control = opened.getByRole("group", { name: "Document view" });
	let view = opened.getByRole("region", { name: "Build", exact: true });
	await control.getByRole("button", { name: "Build", exact: true }).click();
	await expect(view).toBeVisible();
	await expect.poll(() => drafts.length).toBe(1);
	expect(drafts[0]!.planRevision).toBeGreaterThanOrEqual(0);
	// The scripted Planner answers without tasks, so the turn ends with nothing to review.
	await expect(view.getByText("Chopin couldn’t break the plan into tasks.", { exact: true }))
		.toBeVisible();
	expect(sends).toHaveLength(0);
	let transcript = chatPane(opened);
	// The notice renders its @mention as a name.
	await expect(transcript).toContainText(/asked Chopin to break the plan into tasks\./);
	await expect(transcript).not.toContainText("Prepare an implementation graph");

	await control.getByRole("button", { name: "Document", exact: true }).click();
	await control.getByRole("button", { name: "Build", exact: true }).click();
	await expect(view).toBeVisible();
	await opened.waitForTimeout(500);
	expect(drafts).toHaveLength(1);
	await view.getByRole("button", { name: "Try again", exact: true }).click();
	await expect.poll(() => drafts.length).toBe(2);
	expect(drafts[1]!.planRevision).toBe(drafts[0]!.planRevision);
	expect(sends).toHaveLength(0);
});

test("a document edited while Build is open keeps its old tasks and waits to be asked", async ({ join, page, seed }) => {
	let graph: Graph = {
		versions: [{
			number: 1,
			revision: 1,
			planRevision: 0,
			state: "draft",
			definition: {
				tasks: [{
					id: "strings",
					title: "Restring the harp",
					context: "The harp is out of tune.",
					goal: "New strings.",
					acceptance: ["The strings are new.", "It is in tune."],
					dependsOn: [],
				}],
			},
		}],
	};
	await seed("# Build stale\n\nThe harp needs new strings.\n", { graph });
	let { drafts } = await recordDrafts(page);
	let opened = await join("ana");
	let view = opened.getByRole("region", { name: "Build", exact: true });
	await opened.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: "Build", exact: true }).click();
	await expect(view).toContainText("1 task");

	let other = await join("ben");
	await content(other).getByText("The harp needs new strings.").click();
	await other.keyboard.press("End");
	await other.keyboard.type(" Tune them too.");

	await expect(
		view.getByText("The document changed since these tasks were drafted.", { exact: true }),
	).toBeVisible();
	await expect(view.getByRole("button", { name: /^Restring the harp/ })).toBeVisible();
	await opened.waitForTimeout(500);
	expect(drafts).toHaveLength(0);
	await view.getByRole("button", { name: "Update tasks", exact: true }).click();
	await expect.poll(() => drafts.length).toBe(1);
});

test("Task graph inspects stale tasks without drafting until the person opens Build", async ({ join, page, seed }) => {
	await seed("# Graph review\n\nThe document changed after drafting.\n", {
		revision: 1,
		graph: {
			versions: [{
				number: 1,
				revision: 1,
				planRevision: 0,
				state: "draft",
				definition: {
					tasks: [{
						id: "review",
						title: "Review the document",
						context: "An earlier revision",
						goal: "Implement the reviewed document",
						acceptance: ["Works", "Verified"],
						dependsOn: [],
					}],
				},
			}],
		},
	});
	let { drafts } = await recordDrafts(page);
	let opened = await join("ana");
	await opened.getByRole("group", { name: "Document view", exact: true })
		.getByRole("button", { name: "Task graph", exact: true }).click();
	let view = opened.getByRole("region", { name: "Task graph", exact: true });
	await expect(view).toContainText("Out of date");
	expect(drafts).toHaveLength(0);
	await view.getByRole("button", { name: "Open Build", exact: true }).click();
	await expect.poll(() => drafts.length).toBe(1);
});
