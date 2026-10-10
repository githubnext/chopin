import { authenticate, content, expect, roomPath, test } from "./room";
import type { ImplementationSnapshot } from "../packages/protocol/implementation";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedChildChannel } from "./database";
import { ROOT } from "./servers";
import { storedQuestion } from "../apps/server/src/testing/plan";
import type { Graph } from "../apps/server/src/tasks/graphs";

function preparedGraph(): Graph {
	return {
		versions: [{
			number: 1,
			revision: 1,
			planRevision: 0,
			state: "draft",
			definition: {
				tasks: [{
					id: "connect",
					title: "Connect the local agent",
					context: "An isolated tracer.",
					goal: "Read the approved graph and report a task blocker through MCP.",
					acceptance: ["The agent can read the graph.", "Its blocker appears in Chopin."],
					dependsOn: [],
				}, {
					id: "review",
					title: "Review the connection",
					context: "Wait for the connection.",
					goal: "Verify progress survives refresh.",
					acceptance: ["The progress persists.", "The dependency is visible."],
					dependsOn: ["connect"],
				}],
			},
		}],
	};
}

test("Build is a compact workspace view after Decisions", async ({ seed, join: enter }) => {
	await seed("# Build review\n\nThe document stays readable on a phone.\n");
	let page = await enter("ana", {
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});
	let navigation = page.getByRole("navigation", { name: "Workspace view" });
	let view = page.getByRole("region", { name: "Build", exact: true });
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(view).toBeHidden();
	let build = navigation.getByRole("button", { name: "Build", exact: true });
	await expect(build).toBeInViewport({ ratio: 1 });
	await expect(build).toBeEnabled();
	await expect(navigation.getByRole("button")).toHaveText([
		"Chat",
		"Document",
		"Decisions",
		"Build",
	]);
	await build.tap();
	await expect(build).toHaveAttribute("aria-pressed", "true");
	await expect(view).toBeVisible();
	await expect(content(page)).not.toBeVisible();
	await expect(view.getByText("No tasks yet.", { exact: true })).toBeVisible();
	await navigation.getByRole("button", { name: "Document", exact: true }).tap();
	await expect(view).toBeHidden();
	await expect(content(page).locator(":scope > p").first()).toBeInViewport({ ratio: 1 });
});

test("Build waits for document content", async ({ join: enter }) => {
	let page = await enter("ana");
	let build = page.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: "Build", exact: true });
	await expect(build).toBeDisabled();
	await expect(build).toHaveAccessibleDescription("Write the document before building it");
	await build.click({ force: true });
	await expect(page.getByRole("region", { name: "Build", exact: true })).toBeHidden();
});

test("Build shares the document pane beside Chat and a task link reopens it after reload", async ({ seed, join: enter }) => {
	await seed("# Build review\n\nReview these tasks before running them.\n", {
		graph: preparedGraph(),
	});
	let page = await enter("ana");
	let controls = page.getByRole("group", { name: "Document view", exact: true });
	let view = page.getByRole("region", { name: "Build", exact: true });
	await expect(controls.getByRole("button")).toHaveText([
		"Document",
		"Decisions",
		"Task graph",
		"Build",
	]);
	await controls.getByRole("button", { name: "Build", exact: true }).click();
	await expect(view).toContainText("Connect the local agent");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(content(page)).not.toBeVisible();
	await expect(page.getByRole("complementary", { name: "Chat", exact: true })).toBeVisible();
	await controls.getByRole("button", { name: "Decisions", exact: true }).click();
	await expect(view).toBeHidden();
	await controls.getByRole("button", { name: "Document", exact: true }).click();
	await page.evaluate(() => {
		location.hash = "task-review";
	});
	await expect(controls.getByRole("button", { name: "Build", exact: true }))
		.toHaveAttribute("aria-pressed", "true");
	await expect(view.getByText("Verify progress survives refresh.", { exact: true }))
		.toBeInViewport();
	await page.reload();
	await expect(view.getByText("Verify progress survives refresh.", { exact: true }))
		.toBeInViewport();
});

async function connector(baseURL: string, command: string[]) {
	let root = await mkdtemp(join(tmpdir(), "chopin-implementation-checkout-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-implementation-state-"));
	let git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
	git("init", "-b", "main");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.test");
	git("remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(root, "sample.txt"), "committed source");
	git("add", ".");
	git("commit", "-m", "fixture");
	await writeFile(join(root, "sample.txt"), "uncommitted local edit");
	let child = spawn("bun", [
		join(ROOT, "apps/connector/src/main.ts"),
		"connect",
		root,
		"--",
		...command,
	], {
		cwd: ROOT,
		env: { ...process.env, CHOPIN_URL: baseURL, CHOPIN_CONNECTOR_STATE_DIR: state },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	let pairing = new Promise<string>((resolve, reject) => {
		let timer = setTimeout(() => reject(new Error(`Pairing timed out: ${output}`)), 15_000);
		child.stderr.on("data", chunk => {
			output += String(chunk);
			let match = output.match(/http:\/\/[^\s]+\/connect\?pairing=[\w-]+/);
			if (match) {
				clearTimeout(timer);
				resolve(match[0]);
			}
		});
		child.once("error", reject);
		child.once("exit", code => {
			clearTimeout(timer);
			reject(new Error(`Connector exited ${code}: ${output}`));
		});
	});
	return {
		pairing,
		output: () => output,
		localEdit: () => readFile(join(root, "sample.txt"), "utf8"),
		close: async () => {
			child.kill("SIGINT");
			await new Promise<void>(resolve => {
				if (child.exitCode !== null) return resolve();
				let timer = setTimeout(() => {
					child.kill("SIGKILL");
					resolve();
				}, 5000);
				child.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		},
	};
}

for (let mode of ["block", "complete", "startup-failure", "live"] as const) {
	test(`the paired ACP connector implements a browser plan (${mode})`, async ({ seed, join: enter, room, baseURL }) => {
		test.skip(
			mode === "live" && !process.env.CHOPIN_TEST_ACP_COMMAND,
			"Opt-in ACP credentials and model usage",
		);
		test.setTimeout(mode === "live" ? 180_000 : 60_000);
		let graph = preparedGraph();
		if (mode === "live") {
			graph.versions[0].definition.tasks[0].context =
				"Connectivity tracer only: start this task through MCP, then block it with reason exactly Choose the next tracer and stop. Do not edit files, run checks or create PRs. The human must choose further work.";
		}
		await seed("# Local implementation tracer\n\nValidate the local agent connection.\n", {
			graph,
		});
		let local = await connector(
			baseURL!,
			mode === "live"
				? JSON.parse(process.env.CHOPIN_TEST_ACP_COMMAND!)
				: [
					"bun",
					join(ROOT, "apps/connector/src/testing/fake-implementer.ts"),
					...(mode === "complete" ? ["--complete", "--http"] : []),
					...(mode === "startup-failure" ? ["--fail-start"] : []),
				],
		);
		try {
			let page = await enter("ana");
			await page.goto(await local.pairing);
			await page.getByRole("combobox", { name: "Document", exact: true }).selectOption(room);
			await page.getByRole("button", { name: "Connect", exact: true }).click();
			await page.getByRole("link", { name: "Open document", exact: true }).click();
			let view = page.getByRole("region", { name: "Build", exact: true });
			let openBuild = () =>
				page.getByRole("group", { name: "Document view" })
					.getByRole("button", { name: "Build", exact: true }).click();
			await expect(view).toBeHidden();
			await openBuild();
			await expect(view).toBeVisible();
			await expect(view).toContainText("2 tasks");
			await expect(view.getByRole("combobox")).toHaveCount(0);
			let build = view.getByRole("button", { name: "Build on my laptop", exact: true });
			await expect(build).toBeEnabled();
			await build.click();
			await expect.poll(async () => {
				let snapshot = await (await page.request.get(`/api/channels/${room}/implementation`))
					.json();
				return snapshot.build?.state;
			}, { timeout: mode === "live" ? 150_000 : 30_000 }).toMatch(/^(failed|stopped)$/);
			let snapshot = await (await page.request.get(`/api/channels/${room}/implementation`)).json();
			if (mode === "startup-failure") {
				expect(snapshot.build.state).toBe("failed");
				expect(snapshot.lifecycle.execution.state).toBe("idle");
				await expect(view).toContainText("The build stopped before it started.");
				let first = snapshot.build.id;
				await view.getByRole("button", { name: "Try again", exact: true }).click();
				await expect.poll(async () => {
					let next = await (await page.request.get(`/api/channels/${room}/implementation`)).json();
					return next.build.id !== first && next.build.retryOf === first
						&& next.build.state === "failed";
				}).toBe(true);
				await page.reload();
				await expect(view).toBeHidden();
				await expect(content(page)).toHaveAttribute("contenteditable", "true");
				return;
			}
			expect(snapshot.build.state, local.output()).toBe("stopped");
			expect(snapshot.build.session).toBeTruthy();
			await expect(view).not.toContainText(snapshot.build.session);
			let blocked = view.getByRole("button", { name: /^Connect the local agent/ });
			let dependent = view.getByRole("button", { name: /^Review the connection/ });
			if (mode === "complete") {
				await expect(view).toContainText("Built · 2 pull requests");
				await expect(view.getByRole("link", { name: /^Pull request #\d+/ })).toHaveCount(2);
				await expect(blocked).toHaveAttribute("aria-expanded", "false");
			} else {
				await expect(view).toContainText("The build stopped.");
				await expect(blocked).toHaveAttribute("aria-expanded", "true");
				await expect(view.getByText(/^Blocked: Choose the next tracer/)).toBeVisible();
				// Build replaces the document area, so the locked editor is hidden here.
				await expect(page.getByRole("textbox", { name: "editable markdown", includeHidden: true }))
					.toHaveAttribute("contenteditable", "false");
			}
			await dependent.click();
			await expect(dependent).toHaveAttribute("aria-expanded", "true");
			await expect(view.getByText("After Connect the local agent", { exact: true })).toBeVisible();
			expect(await local.localEdit()).toBe("uncommitted local edit");
			await page.reload();
			await expect(view).toBeHidden();
			await expect(content(page)).toHaveAttribute(
				"contenteditable",
				mode === "complete" ? "true" : "false",
			);
			await openBuild();
			await expect(view).toContainText(
				mode === "complete" ? "Built · 2 pull requests" : "Blocked: Choose the next tracer",
			);
			if (
				process.env.CHOPIN_LAUNCHER_SCREENSHOT
				&& mode === (process.env.CHOPIN_TEST_ACP_COMMAND ? "live" : "block")
			) {
				await view.screenshot({ path: process.env.CHOPIN_LAUNCHER_SCREENSHOT });
			}
			if (mode === "block") {
				await view.getByRole("button", { name: "Return to planning", exact: true }).click();
				await view.getByRole("textbox", { name: "What needs to change?" }).fill(
					"Choose the next tracer before continuing.",
				);
				await view.getByRole("button", { name: "Return to planning", exact: true }).click();
				await expect(view).toContainText("No tasks yet.");
				await page.getByRole("group", { name: "Document view" })
					.getByRole("button", { name: "Document", exact: true }).click();
				await expect(content(page)).toHaveAttribute("contenteditable", "true");
			}
		} finally {
			await local.close();
		}
	});
}

function buildView(page: import("@playwright/test").Page) {
	return page.getByRole("region", { name: "Build", exact: true });
}

async function openBuildView(page: import("@playwright/test").Page) {
	await page.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: "Build", exact: true }).click();
	await expect(buildView(page)).toBeVisible();
}

test("a #task link opens Build on that task, and rows toggle from the keyboard", async ({ seed, join: enter, room }) => {
	await seed("# Linked task\n\nThe second task is the one to read.\n", { graph: preparedGraph() });
	let page = await enter("ana");
	await page.goto(`${roomPath(room)}#task-review`);
	let view = buildView(page);
	await expect(view).toBeVisible();
	let linked = view.getByRole("button", { name: /^Review the connection/ });
	let other = view.getByRole("button", { name: /^Connect the local agent/ });
	await expect(linked).toHaveAttribute("aria-expanded", "true");
	await expect(other).toHaveAttribute("aria-expanded", "false");
	await expect(view.getByText("Verify progress survives refresh.", { exact: true }))
		.toBeInViewport();
	await expect(view.getByText("After Connect the local agent", { exact: true })).toBeVisible();
	await expect(view.getByRole("list", { name: "Tasks" }).locator(":scope > li")).toHaveCount(2);

	await other.focus();
	await page.keyboard.press("Enter");
	await expect(other).toHaveAttribute("aria-expanded", "true");
	await expect(view.getByText("The agent can read the graph.", { exact: true })).toBeVisible();
	await page.keyboard.press("Space");
	await expect(other).toHaveAttribute("aria-expanded", "false");
	let panel = await other.getAttribute("aria-controls");
	expect(panel).toBeTruthy();
	// The fold collapses to nothing rather than unmounting, so its height is the behavior.
	let fold = page.locator(`[id="${panel}"]`);
	await expect.poll(() => fold.evaluate(element => element.getBoundingClientRect().height))
		.toBe(0);
});

test("Build without a running local agent says how to start one", async ({ seed, join: enter }) => {
	await seed("# Offline build\n\nNo local agent is connected.\n", { graph: preparedGraph() });
	let page = await enter("ana");
	await openBuildView(page);
	let view = buildView(page);
	await expect(view).toContainText("2 tasks");
	await expect(view.getByText("Start your local agent to build:")).toHaveCount(0);
	await view.getByRole("button", { name: "Build on my laptop", exact: true }).click();
	await expect(view.getByText("Start your local agent to build:", { exact: true })).toBeVisible();
	await expect(view.locator("code")).toContainText("bun run connector connect");
	await expect(view.getByRole("alert")).toHaveCount(0);
	await expect(view.getByRole("button", { name: "Build on my laptop", exact: true })).toBeEnabled();
});

test("Build names unanswered decisions as a way to Decisions", async ({ seed, join: enter }) => {
	let widget = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
	let question = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
	let option = "01K0N4W3B7P27CBAEC7A8C8WEA";
	let definition = {
		questions: [{
			id: question,
			header: "Rollout",
			question: "How should we deploy?",
			multiple: false,
			options: [{ id: option, label: "Canary", description: "" }],
		}],
	};
	await seed(
		`# Blocked build\n\nA decision is open.\n\n<Questionnaire id="${widget}" by="ana">
<Question id="${question}" header="Rollout" prompt="How should we deploy?" multiple="false">
<Option id="${option}" label="Canary" />
</Question>
</Questionnaire>\n`,
		{
			revision: 1,
			graph: preparedGraph(),
			questions: [{
				id: widget,
				definition,
				status: "open",
				origin: "planner",
				history: [],
				optionOrigins: {},
				editors: [],
			}],
			openQuestions: [{
				definition,
				id: widget,
				model: storedQuestion(definition),
				revision: 0,
				widget,
			}],
		},
	);
	let page = await enter("ana");
	await openBuildView(page);
	let view = buildView(page);
	let answer = view.getByRole("button", { name: "Answer 1 decision first", exact: true });
	await expect(answer).toBeVisible();
	await expect(view.getByRole("button", { name: "Build on my laptop" })).toHaveCount(0);
	await answer.click();
	await expect(view).toBeHidden();
	await expect(
		page.getByRole("group", { name: "Document view" })
			.getByRole("button", { name: /^Decisions/ }),
	).toHaveAttribute("aria-pressed", "true");
});

test("a child document has no Build view", async ({ seed, join: enter, room, baseURL }) => {
	await seed("# Parent\n\nThe parent can be built.\n", { graph: preparedGraph() });
	let child = await seedChildChannel(
		Number(new URL(baseURL!).port),
		room,
		crypto.randomUUID(),
		"Child notes",
		"# Child notes\n\nA child is never built.\n",
	);
	let page = await enter("ana");
	let control = page.getByRole("group", { name: "Document view" });
	await expect(control.getByRole("button", { name: "Build", exact: true })).toBeVisible();
	await page.goto(child.path);
	await expect(content(page)).toContainText("A child is never built.");
	await expect(control.getByRole("button", { name: /^Decisions/ })).toBeVisible();
	await expect(control.getByRole("button", { name: "Build", exact: true })).toHaveCount(0);
	await expect(buildView(page)).toHaveCount(0);
});

test("a build in progress shows who started it and offers no action", async ({ seed, join: enter, room, baseURL }) => {
	await seed("# Running build\n\nThe agent never answers.\n", { graph: preparedGraph() });
	// An agent that never answers keeps the build starting until this test closes it.
	let local = await connector(baseURL!, ["bun", "-e", "setInterval(() => {}, 1 << 30)"]);
	try {
		let page = await enter("ana");
		await page.goto(await local.pairing);
		await page.getByRole("combobox", { name: "Document", exact: true }).selectOption(room);
		await page.getByRole("button", { name: "Connect", exact: true }).click();
		await page.getByRole("link", { name: "Open document", exact: true }).click();
		await openBuildView(page);
		let view = buildView(page);
		await view.getByRole("button", { name: "Build on my laptop", exact: true }).click();
		await expect(view.getByText(/^Building · started by you/)).toBeVisible();
		await expect(
			view.getByRole("button", { name: /Build on my laptop|Try again|Return to planning/ }),
		)
			.toHaveCount(0);
		await expect(view.getByRole("list", { name: "Tasks" }).locator(":scope > li")).toHaveCount(2);
		let snapshot = await (await page.request.get(`/api/channels/${room}/implementation`)).json();
		expect(["queued", "starting", "running"]).toContain(snapshot.build.state);
	} finally {
		await local.close();
	}
});

test(
	"Task graph follows availability and live status without losing inspection or zoom",
	async ({ seed, join: enter, page, room }, testInfo) => {
		let graph = preparedGraph();
		graph.versions[0].definition.tasks.push({
			...graph.versions[0].definition.tasks[0],
			id: "parallel",
			title: "Independent task",
		});
		await seed("# Graph review\n\nReview this document.\n", { graph });
		let announce: ((hasGraph: boolean) => void) | undefined;
		let drafts = 0;
		await page.routeWebSocket("**/ws?**", route => {
			let server = route.connectToServer();
			let revision = 0;
			route.onMessage(message => {
				if (typeof message === "string" && JSON.parse(message).kind === "implementation:draft") {
					drafts++;
				}
				server.send(message);
			});
			server.onMessage(message => {
				if (typeof message !== "string") return route.send(message);
				let frame = JSON.parse(message);
				if (frame.kind === "plan:open") {
					revision = frame.implementation.revision;
					frame.implementation.hasGraph = false;
					announce = hasGraph =>
						route.send(JSON.stringify({
							kind: "plan:implementation",
							ts: 0,
							revision: ++revision,
							locked: false,
							hasGraph,
						}));
				}
				route.send(JSON.stringify(frame));
			});
		});
		let state: ImplementationSnapshot | undefined;
		let failRead = false;
		await page.route(`**/api/channels/${room}/implementation`, async route => {
			if (failRead) return route.fulfill({ status: 503, json: { error: "Connection failed" } });
			state ??= await (await route.fetch()).json();
			await route.fulfill({ json: state });
		});
		await enter("ana");
		await page.setViewportSize({ width: 390, height: 844 });
		let navigation = page.getByRole("navigation", { name: "Workspace view" });
		let tab = navigation.getByRole("button", { name: "Task graph", exact: true });
		await expect(tab).toHaveCount(0);
		announce!(true);
		await expect(tab).toBeVisible();
		await expect(navigation.getByRole("button", { name: "Document", exact: true })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await tab.click();
		let view = page.getByRole("region", { name: "Task graph", exact: true });
		let first = view.getByRole("button", { name: "Connect the local agent, Queued", exact: true });
		await first.focus();
		await page.keyboard.press("Enter");
		let details = view.getByRole("complementary", { name: "Diagram details" });
		await expect(details).toContainText("The agent can read the graph.");
		await view.getByRole("button", { name: "Zoom in diagram", exact: true }).click();
		await expect(view.getByLabel("Diagram zoom", { exact: true })).toHaveText("115%");
		state!.workspaces = [{
			id: "busy-workspace",
			label: "Local checkout",
			available: false,
			checkout: { repository: "octo-org/score", branch: "main", commit: "a".repeat(40) },
		}];
		state!.revision++;
		announce!(true);
		await expect(view.getByText("Your connected workspaces are busy.", { exact: true }))
			.toBeVisible();
		await expect(view.getByRole("button", { name: "Build on my laptop", exact: true }))
			.toBeDisabled();
		state!.workspaces[0].available = true;
		state!.revision++;
		announce!(true);
		await expect(view.getByRole("button", { name: "Build on my laptop", exact: true }))
			.toBeEnabled();
		state!.revision++;
		state!.graph!.state = "locked";
		state!.lifecycle = {
			execution: { state: "active" },
			history: [],
			activity: { events: [], tasks: [{ id: "connect", state: "in_progress" }] },
		};
		announce!(true);
		await expect(view).toContainText("Implementing");
		await expect(
			view.getByRole("button", { name: "Connect the local agent, In progress", exact: true }),
		).toHaveAttribute("aria-pressed", "true");
		await expect(details).toContainText("The agent can read the graph.");
		await expect(view.getByLabel("Diagram zoom", { exact: true })).toHaveText("115%");
		state!.revision++;
		state!.lifecycle.activity!.tasks[0] = {
			id: "connect",
			state: "blocked",
			blocker: "Choose the runtime",
		};
		announce!(true);
		await expect(details).toContainText("Blocked: Choose the runtime");
		await expect(view).toContainText("0 of 3 tasks complete · 1 blocked");
		await page.mouse.move(0, 0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			390,
		);
		await view.locator("[data-build-view-scroll]").evaluate(element => element.scrollTop = 0);
		await view.screenshot({ path: testInfo.outputPath("task-graph-mobile.png") });
		await page.setViewportSize({ width: 1440, height: 1000 });
		await view.locator("[data-build-view-scroll]").evaluate(element => element.scrollTop = 0);
		await view.screenshot({ path: testInfo.outputPath("task-graph-desktop.png") });
		failRead = true;
		announce!(true);
		await expect(view.getByRole("alert")).toContainText("Connection failed");
		await expect(details).toContainText("Blocked: Choose the runtime");
		failRead = false;
		state!.revision++;
		state!.planRevision++;
		await view.getByRole("button", { name: "Retry", exact: true }).click();
		await expect(view).toContainText("Out of date");
		await expect(view.getByRole("alert")).toHaveCount(0);
		expect(drafts).toBe(0);
		announce!(false);
		await expect(page.getByRole("button", { name: "Task graph", exact: true })).toHaveCount(0);
		await expect(content(page)).toBeVisible();
	},
);

for (let mode of ["block", "complete", "startup-failure"] as const) {
	test(`Task graph hands off to the local connector and restores its outcome (${mode})`, async ({ seed, join: enter, room, baseURL }) => {
		test.setTimeout(60_000);
		await seed("# Graph implementation\n\nImplement this document.\n", { graph: preparedGraph() });
		let local = await connector(baseURL!, [
			"bun",
			join(ROOT, "apps/connector/src/testing/fake-implementer.ts"),
			...(mode === "complete" ? ["--complete", "--http"] : []),
			...(mode === "startup-failure" ? ["--fail-start"] : []),
		]);
		try {
			let page = await enter("ana");
			await page.goto(await local.pairing);
			await page.getByRole("combobox", { name: "Document", exact: true }).selectOption(room);
			await page.getByRole("button", { name: "Connect", exact: true }).click();
			await page.getByRole("link", { name: "Open document", exact: true }).click();
			let open = () =>
				page.getByRole("group", { name: "Document view", exact: true })
					.getByRole("button", { name: "Task graph", exact: true }).click();
			await open();
			let view = page.getByRole("region", { name: "Task graph", exact: true });
			await expect(view.getByRole("combobox", { name: "Local workspace" })).toBeVisible();
			await view.getByRole("button", { name: "Connect the local agent, Queued", exact: true })
				.click();
			let launches = 0;
			page.on("request", request => {
				if (
					request.method() === "POST" && request.url().endsWith(`/channels/${room}/implementation`)
				) launches++;
			});
			await view.getByRole("button", { name: "Build on my laptop", exact: true }).evaluate(
				element => {
					(element as HTMLButtonElement).click();
					(element as HTMLButtonElement).click();
				},
			);
			let expected = mode === "complete"
				? "Verified"
				: mode === "block"
				? "Implementation stopped"
				: "Startup failed";
			await expect(view).toContainText(expected, { timeout: 30_000 });
			expect(launches).toBe(1);
			let details = view.getByRole("complementary", { name: "Diagram details" });
			if (mode === "complete") {
				await expect(view).toContainText("2 of 2 tasks complete");
				await expect(details.getByRole("link", { name: "Pull request #101 · open", exact: true }))
					.toBeVisible();
				await view.getByText("Verification passed", { exact: true }).click();
				await expect(view).toContainText("Protocol fixture verified");
			} else if (mode === "block") {
				await expect(details).toContainText("Blocked: Choose the next tracer");
			}
			await page.reload();
			await open();
			await expect(view).toContainText(expected);
			if (mode === "block") {
				await view.getByRole("button", { name: "Return to planning", exact: true }).click();
				await view.getByRole("textbox", { name: "What needs to change?" }).fill(
					"Choose the next tracer.",
				);
				await view.getByRole("button", { name: "Return to planning", exact: true }).click();
				await expect(view).toContainText("Returned for changes");
			} else if (mode === "startup-failure") {
				await view.getByRole("button", { name: "Try again", exact: true }).click();
				await expect.poll(() => launches).toBe(2);
			}
			expect(await local.localEdit()).toBe("uncommitted local edit");
		} finally {
			await local.close();
		}
	});
}

test("a read-only collaborator can inspect Task graph", async ({ seed, page, room, baseURL }) => {
	await seed("# Shared graph\n\nEveryone can review.\n", { graph: preparedGraph() });
	await authenticate(page, `score-reader-${room.slice(0, 8)}`, baseURL!);
	await page.goto(roomPath(room));
	await page.getByRole("group", { name: "Document view", exact: true })
		.getByRole("button", { name: "Task graph", exact: true }).click();
	let view = page.getByRole("region", { name: "Task graph", exact: true });
	await view.getByRole("button", { name: "Review the connection, Queued", exact: true }).click();
	await expect(view).toContainText("Waiting for: Connect the local agent");
	await expect(view.getByRole("button", { name: "Build on my laptop", exact: true })).toHaveCount(
		0,
	);
});
