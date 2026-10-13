import { content, expect, roomPath, test } from "./room";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failedBuild } from "./build-seed";
import { seedChildChannel, testChannelPath } from "./database";
import { ROOT } from "./servers";
import { storedQuestion } from "../apps/server/src/testing/plan";
import type { Graph } from "../apps/server/src/tasks/graphs";

/** A connection serves every document in its repository, so each pairing test is its own person. */
function person() {
	return `ana-${crypto.randomUUID().slice(0, 8)}`;
}

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
	let graph = preparedGraph();
	await seed("# Build review\n\nThe document stays readable on a phone.\n", {
		graph,
		builds: [failedBuild(graph)],
	});
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
	await expect(build).toHaveAttribute("aria-current", "page");
	await expect(view).toBeVisible();
	await expect(content(page)).not.toBeVisible();
	await expect(view.getByText(/^Build stopped/)).toBeVisible();
	await navigation.getByRole("button", { name: "Document", exact: true }).tap();
	await expect(view).toBeHidden();
	await expect(content(page).locator(":scope > p").first()).toBeInViewport({ ratio: 1 });
});

test("Build stays off until the plan is built, and Build plan says why it waits", async ({ join: enter }) => {
	let page = await enter("ana");
	let build = page.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: "Build", exact: true });
	await expect(build).toBeDisabled();
	await expect(build).toHaveAccessibleDescription("Build the plan to see its tasks");
	await build.click({ force: true });
	await expect(page.getByRole("region", { name: "Build", exact: true })).toBeHidden();
	let plan = page.getByRole("button", { name: "Build plan", exact: true });
	await expect(plan).toBeVisible();
	await expect(plan).toHaveAttribute("aria-disabled", "true");
	await expect(plan).toHaveAccessibleDescription("Write the document first");
});

test("opening the Build tab never asks for tasks", async ({ seed, join: enter, page }) => {
	await seed("# Unbuilt\n\nThe tasks are not drafted yet.\n");
	let sent: string[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") sent.push(JSON.parse(message).kind);
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	let opened = await enter("ana");
	let build = opened.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: "Build", exact: true });
	await build.click({ force: true });
	await build.focus();
	await opened.keyboard.press("Enter");
	await expect(opened.getByRole("region", { name: "Build", exact: true })).toBeHidden();
	// An edit's frame follows any the tab sent, so once it arrives the absence is settled.
	let before = sent.length;
	await content(opened).click();
	await opened.keyboard.press("End");
	await opened.keyboard.type(" Edited.");
	await expect.poll(() => sent.slice(before).includes("plan:update")).toBe(true);
	expect(sent).not.toContain("implementation:draft");
});

test("Build shares the document pane beside Chat and a task link reopens it after reload", async ({ seed, join: enter }) => {
	let graph = preparedGraph();
	await seed("# Build review\n\nReview these tasks before running them.\n", {
		graph,
		builds: [failedBuild(graph)],
	});
	let page = await enter("ana");
	let controls = page.getByRole("group", { name: "Document view", exact: true });
	let view = page.getByRole("region", { name: "Build", exact: true });
	await expect(controls.getByRole("button")).toHaveText(["Document", "Decisions", "Build"]);
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
		let read = (chunk: Buffer) => {
			output += String(chunk);
			let match = output.match(/http:\/\/[^\s]+\/connect\?pairing=[\w-]+/);
			if (match) {
				clearTimeout(timer);
				resolve(match[0]);
			}
		};
		// Pairing instructions are on stdout; failures and agent output on stderr.
		child.stdout.on("data", read);
		child.stderr.on("data", read);
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
			let page = await enter(person());
			await page.goto(await local.pairing);
			await page.getByRole("button", { name: "Connect", exact: true }).click();
			await expect(page.getByRole("status")).toContainText("Connected.");
			await page.goto(testChannelPath(room));
			let view = page.getByRole("region", { name: "Build", exact: true });
			let openBuild = () =>
				page.getByRole("group", { name: "Document view" })
					.getByRole("button", { name: /^Build/ }).click();
			await expect(view).toBeHidden();
			let build = page.getByRole("button", { name: "Build plan", exact: true });
			await expect(build).not.toHaveAttribute("aria-disabled", "true");
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
				await expect(page.getByRole("button", { name: /^Build stopped/ })).toBeVisible();
				await openBuild();
				await expect(view).toContainText("Build stopped");
				let first = snapshot.build.id;
				await page.getByRole("button", { name: "Retry", exact: true }).click();
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
			await expect(
				page.getByRole("button", { name: mode === "complete" ? /^Built/ : /^Build stopped/ }),
			)
				.toBeVisible();
			await openBuild();
			await expect(view).not.toContainText(snapshot.build.session);
			let blocked = view.getByRole("button", { name: /^Connect the local agent/ });
			let dependent = view.getByRole("button", { name: /^Review the connection/ });
			if (mode === "complete") {
				await expect(view).toContainText("Built · 2 pull requests");
				await expect(view.getByRole("link", { name: /^Pull request #\d+/ })).toHaveCount(2);
				await expect(blocked).toHaveAttribute("aria-expanded", "false");
			} else {
				await expect(view).toContainText("Build stopped");
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
				await expect(view).toContainText("Returned for changes. Build plan builds it again.");
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

/** Whatever build shows ends 12px before the rule, and the first face starts 12px after it. */
async function expectClearOfPeople(build: import("@playwright/test").Locator) {
	let people = build.page().getByRole("group", { name: /^People here/ });
	let face = people.locator(":scope > [data-tooltip]").first();
	await expect(build).toBeVisible();
	await expect(face).toBeVisible();
	let control = (await build.boundingBox())!;
	let group = (await people.boundingBox())!;
	let first = (await face.boundingBox())!;
	let end = control.x + control.width;
	expect(group.x - end).toBeGreaterThanOrEqual(12);
	expect(first.x - end).toBeGreaterThanOrEqual(24);
	expect(await people.evaluate(element => getComputedStyle(element).borderInlineStartWidth))
		.not.toBe("0px");
}

for (let state of ["Build plan", "Build stopped"] as const) {
	test(`${state} keeps clear of the people here at full and narrow widths`, async ({ seed, join: enter }) => {
		let graph = preparedGraph();
		await seed("# Build gap\n\nBuild sits apart from the people here.\n", {
			graph,
			builds: state === "Build stopped" ? [failedBuild(graph)] : undefined,
		});
		let page = await enter("ana", { viewport: { width: 1440, height: 900 } });
		// A collaborator's view, with two people here.
		let other = await enter("bea", { viewport: { width: 1440, height: 900 } });
		for (let viewer of [page, other]) {
			// The rightmost build control: Build plan, or the capsule's Retry.
			let build = state === "Build plan"
				? viewer.getByRole("button", { name: "Build plan", exact: true })
				: viewer.getByRole("button", { name: "Retry", exact: true });
			await expect(
				viewer.getByRole("group", { name: /^People here/ }).locator(":scope > [data-tooltip]"),
			)
				.toHaveCount(2);
			for (let width of [1440, 1100]) {
				await viewer.setViewportSize({ width, height: 900 });
				await expectClearOfPeople(build);
			}
		}
	});
}

test("a #task link opens Build on that task, and rows toggle from the keyboard", async ({ seed, join: enter, room }) => {
	let graph = preparedGraph();
	await seed("# Linked task\n\nThe second task is the one to read.\n", {
		graph,
		builds: [failedBuild(graph)],
	});
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
	let page = await enter(person());
	await page.getByRole("button", { name: "Build plan", exact: true }).click();
	let capsule = page.getByRole("button", { name: /^Start your local agent/ });
	await expect(capsule).toHaveAccessibleDescription(
		"Your local agent isn’t connected. Open Build for the command that starts it.",
	);
	await expect(page.getByRole("button", { name: /^Build stopped/ })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
	await capsule.click();
	let view = buildView(page);
	let note = view.getByText(
		"Your local agent isn’t connected. Run this in your project folder, then press Retry again.",
		{ exact: true },
	);
	await expect(note).toBeVisible();
	await expect(view.locator("code")).toContainText(
		"/connector.js -o ~/.chopin/connector.js && CHOPIN_URL=",
	);
	await view.getByRole("button", { name: "Copy", exact: true }).click();
	await expect(view.getByRole("button", { name: /^(Copied|Select to copy)$/ })).toBeVisible();
	await expect(view.getByRole("link", { name: "Trouble connecting?", exact: true }))
		.toHaveAttribute("href", /docs\/local-experiments\.md#trouble-connecting$/);
	await expect(view.getByRole("alert")).toHaveCount(0);
});

test("Build plan waits for unanswered decisions and says so", async ({ seed, join: enter }) => {
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
	let plan = page.getByRole("button", { name: "Build plan", exact: true });
	await expect(plan).toHaveAttribute("aria-disabled", "true");
	await expect(plan).toHaveAccessibleDescription("Answer 1 open decision first");
	await plan.click({ force: true });
	await expect(page.getByRole("button", { name: /^Breaking into tasks/ })).toHaveCount(0);
	await expect(
		page.getByRole("group", { name: "Document view" })
			.getByRole("button", { name: "Build", exact: true }),
	).toBeDisabled();
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
	// The views belong to the root; the child card has none of its own.
	let card = page.getByRole("region", { name: /^Child document:/ });
	await expect(card.getByRole("textbox", { name: "editable markdown" })).toContainText(
		"A child is never built.",
	);
	await expect(card.getByRole("group", { name: "Document view" })).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Build", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Build plan", exact: true })).toHaveCount(0);
	await expect(buildView(page)).toHaveCount(0);
});

test("a build in progress shows who started it and offers no action", async ({ seed, join: enter, room, baseURL }) => {
	await seed("# Running build\n\nThe agent never answers.\n", { graph: preparedGraph() });
	// An agent that never answers keeps the build starting until this test closes it.
	let local = await connector(baseURL!, ["bun", "-e", "setInterval(() => {}, 1 << 30)"]);
	try {
		let page = await enter(person());
		await page.goto(await local.pairing);
		await page.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(page.getByRole("status")).toContainText("Connected.");
		await page.goto(testChannelPath(room));
		await page.getByRole("button", { name: "Build plan", exact: true }).click();
		let capsule = page.getByRole("button", { name: /^Building · 0 of 2/ });
		await expect(capsule).toBeVisible();
		await expectClearOfPeople(capsule);
		// The capsule and the Build tab light each other, and the capsule opens Build.
		let tab = page.getByRole("group", { name: "Document view" })
			.getByRole("button", { name: "Build", exact: true });
		await capsule.hover();
		await expect(tab).toHaveAttribute("data-hot", "true");
		await tab.hover();
		await expect(capsule).toHaveAttribute("data-hot", "true");
		await capsule.click();
		let view = buildView(page);
		await expect(view).toBeVisible();
		// The capsule stays while its own view is open.
		await expect(capsule).toBeVisible();
		await expect(view.getByText(/^Building · 0 of 2 · started by you/)).toBeVisible();
		await expect(view.getByRole("button", { name: /Retry|Return to planning/ })).toHaveCount(0);
		await expect(view.getByRole("list", { name: "Tasks" }).locator(":scope > li")).toHaveCount(2);
		let snapshot = await (await page.request.get(`/api/channels/${room}/implementation`)).json();
		expect(["queued", "starting", "running"]).toContain(snapshot.build.state);
	} finally {
		await local.close();
	}
});

test("on a phone, tapping Build or an inert Build plan says why, briefly", async ({ seed, join: enter }) => {
	await seed("# Phone build\n\nNot built yet.\n");
	let page = await enter("ana", {
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	let tab = page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Build/ });
	// aria-disabled, not disabled, so it stays tappable: touch has no tooltip; the tap explains.
	await expect(tab).toHaveAttribute("aria-disabled", "true");
	await expect(tab).not.toHaveAttribute("disabled");
	let reason = await tab.evaluate(element =>
		document.getElementById(element.getAttribute("aria-describedby")!)!.textContent!
	);
	expect(reason.length).toBeGreaterThan(0);
	let hint = page.getByRole("status").filter({ hasText: reason });
	await tab.tap({ force: true });
	await expect(hint).toBeVisible();
	await expect(page.getByRole("region", { name: "Build", exact: true })).toBeHidden();
	await expect(hint).toHaveCount(0, { timeout: 6_000 });
	let plan = page.getByRole("button", { name: "Build plan", exact: true });
	if (await plan.getAttribute("aria-disabled") === "true") {
		await plan.tap({ force: true });
		await expect(hint).toBeVisible();
	}
});

test("edits after a build read as changes to build, and Build sends them to the agent", async ({ seed, join: enter, room, baseURL }) => {
	test.setTimeout(60_000);
	await seed("# Built tracer\n\nValidate the local agent connection.\n", {
		graph: preparedGraph(),
	});
	let local = await connector(baseURL!, [
		"bun",
		join(ROOT, "apps/connector/src/testing/fake-implementer.ts"),
		"--complete",
		"--http",
	]);
	try {
		let page = await enter(person());
		await page.goto(await local.pairing);
		await page.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(page.getByRole("status")).toContainText("Connected.");
		await page.goto(testChannelPath(room));
		await page.getByRole("button", { name: "Build plan", exact: true }).click();
		let built = page.getByRole("button", { name: "Built", exact: true });
		await expect(built).toBeVisible({ timeout: 30_000 });
		await expectClearOfPeople(built);
		// Beside a built document's capsule there is no Build; only the tab has that name.
		await expect(page.getByRole("button", { name: "Build", exact: true })).toHaveCount(1);

		await content(page).getByText("Validate the local agent connection.").click();
		await page.keyboard.press("End");
		await page.keyboard.type(" Then report back.");
		let stale = page.getByRole("button", { name: "1 change to build", exact: true });
		await expect(stale).toBeVisible();
		await expect(stale).toHaveAccessibleDescription("Edits since the last build");
		await expectClearOfPeople(
			page.getByRole("button", { name: "Build", exact: true }).and(
				page.locator(":not([role='group'] *)"),
			),
		);
		let tab = page.getByRole("group", { name: "Document view" })
			.getByRole("button", { name: "Build", exact: true });
		await expect(tab).toBeEnabled();
		// The capsule's own Build, not the tab, sends the changes.
		await page.getByRole("button", { name: "Build", exact: true })
			.and(page.locator(":not([role='group'] *)"))
			.click();
		await expect.poll(async () => {
			let snapshot = await (await page.request.get(`/api/channels/${room}/implementation`)).json();
			return snapshot.live?.rebuild?.kind;
		}).toBe("rebuild");
		// The fixture lands the rebuild, so it reaches Built, never Build failed.
		await expect(built).toBeVisible({ timeout: 30_000 });
		await expect(page.getByRole("button", { name: "Build failed", exact: true })).toHaveCount(0);
		await expect.poll(async () => {
			let snapshot = await (await page.request.get(`/api/channels/${room}/implementation`)).json();
			return [snapshot.live?.rebuild?.state, snapshot.live?.commits?.length];
		}).toEqual(["stopped", 1]);
	} finally {
		await local.close();
	}
});
