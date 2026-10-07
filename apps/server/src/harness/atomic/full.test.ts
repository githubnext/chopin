import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";
import { jsonSchema, tool } from "ai";
import {
	ATOMIC_DEFAULT_SYSTEM_PROMPT,
	ATOMIC_RESULT_TOOL_NAME,
	createAtomicAdapter,
	FULL_PLANNER_TOOLS,
} from "./adapter";
import {
	classifyRuns,
	type FullPlanner,
	pauseOwnedRuns,
	registerFullPlanner,
	resumeOwnedRuns,
	runCards,
	untilUnpaused,
} from "./full";
import { startStubModelServer } from "../pi/model-stub";
import * as Plan from "../../plan/service";
import * as Store from "../../questions/store";
import { hostInputRoom } from "../../testing/decisions";
import type { HostInput, QuestionParams, SessionWorkflows } from "@bastani/atomic";

let params: QuestionParams = {
	questions: [{
		header: "Choice",
		question: "Which option?",
		options: [
			{ label: "First", description: "One" },
			{ label: "Second", description: "Two" },
		],
	}],
};
let freeText: Record<string, QuestionParams> = {
	multiple: {
		questions: [{
			header: "Scope",
			question: "Which areas?",
			multiSelect: true,
			options: [
				{ label: "Server", description: "Back end" },
				{ label: "Web", description: "Front end" },
			],
		}],
	},
	preview: {
		questions: [{
			header: "Layout",
			question: "Which layout?",
			options: [
				{ label: "Rows", description: "Stacked", preview: "row\nrow" },
				{ label: "Columns", description: "Side by side", preview: "col | col" },
			],
		}],
	},
};
let stub = startStubModelServer((prompt, prior) =>
	prior
		? { kind: "text", text: "Answered." }
		: prompt === "question"
		? { kind: "tool", name: "ask_user_question", arguments: JSON.stringify(params) }
		: freeText[prompt]
		? { kind: "tool", name: "ask_user_question", arguments: JSON.stringify(freeText[prompt]) }
		: prompt === "cwd"
		? { kind: "tool", name: "read", arguments: JSON.stringify({ path: "where.txt" }) }
		: prompt === "workflows"
		? { kind: "tool", name: "workflow", arguments: JSON.stringify({ action: "list" }) }
		: prompt === "launch"
		? {
			kind: "tool",
			name: "workflow",
			arguments: JSON.stringify({ action: "run", workflow: "asking-workflow", inputs: {} }),
		}
		: { kind: "text", text: "Ready." }
);
afterAll(stub.stop);

async function run(
	registered: boolean,
	prompt = "plain",
	{
		host,
		checkout = true,
		worker = false,
		projectPackage = false,
		operatorPackage = false,
		askingWorkflow = false,
		afterTurn,
	}: {
		host?: HostInput;
		/** False runs the Planner in an empty directory, as a channel without a checkout does. */
		checkout?: boolean;
		/** Also run an unregistered worker session on the same harness while the Planner is open. */
		worker?: boolean;
		/** Install a local package through the checkout's `.atomic/settings.json`. */
		projectPackage?: boolean;
		/** Load a local package through the operator's extension paths, as `HARNESS_EXTENSIONS` does. */
		operatorPackage?: boolean;
		/** Load a workflow whose stage calls ask_user_question, through the operator's extension paths. */
		askingWorkflow?: boolean;
		/** Runs once the Planner's turn has ended, while its session and workflow runs are still live. */
		afterTurn?: () => Promise<void>;
	} = {},
) {
	let root = await mkdtemp(join(tmpdir(), "chopin-atomic-full-"));
	let agentDir = join(root, "agent");
	let cwd = join(root, checkout ? "checkout" : "empty");
	let previous = process.env.ATOMIC_CODING_AGENT_DIR;
	let received: QuestionParams[] = [];
	let operatorPackageDir = join(root, "operator-package");
	let harness = createAtomicAdapter({
		auth: "ai-gateway",
		model: "stub/model",
		extensions: operatorPackage || askingWorkflow ? [operatorPackageDir] : undefined,
		providers: {
			stub: {
				baseUrl: stub.baseUrl,
				apiKey: "stub",
				api: "openai-completions",
				models: [{
					id: "model",
					name: "Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 4096,
				}],
			},
		},
	});
	let sandbox = await createJustBashNetworkSandboxSession();
	let release: (() => void) | undefined;
	try {
		for (
			let path of [
				cwd,
				join(agentDir, "skills", "marker"),
				join(agentDir, "extensions"),
				join(agentDir, "prompts"),
			]
		) await mkdir(path, { recursive: true });
		await writeFile(join(cwd, "where.txt"), cwd);
		await writeFile(join(agentDir, "AGENTS.md"), "OPERATOR-CONTEXT-MARKER");
		await writeFile(
			join(agentDir, "skills", "marker", "SKILL.md"),
			"---\nname: marker\ndescription: OPERATOR-SKILL-MARKER\n---\nTest skill.\n",
		);
		await writeFile(join(agentDir, "prompts", "marker.md"), "OPERATOR-PROMPT-MARKER");
		await writeFile(
			join(agentDir, "extensions", "marker.ts"),
			`export default api => api.registerTool({name: "operator_tool", label: "Operator", description: "Marker", parameters: {type:"object"}, async execute() { return {content:[{type:"text",text:"marker"}], details:{}}; }});`,
		);
		if (checkout) {
			let git = Bun.spawn(["git", "-C", cwd, "init", "--quiet"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(await git.exited).toBe(0);
		}
		if (projectPackage) {
			let pkg = join(root, "project-package");
			await mkdir(join(pkg, "skills", "project-marker"), { recursive: true });
			await writeFile(
				join(pkg, "package.json"),
				JSON.stringify({
					name: "project-package",
					type: "module",
					atomic: { extensions: ["./extension.ts"], skills: ["./skills"] },
				}),
			);
			await writeFile(
				join(pkg, "extension.ts"),
				`export default api => api.registerTool({name: "project_tool", label: "Project", description: "Marker", parameters: {type:"object"}, async execute() { return {content:[{type:"text",text:"project"}], details:{}}; }});`,
			);
			await writeFile(
				join(pkg, "skills", "project-marker", "SKILL.md"),
				"---\nname: project-marker\ndescription: PROJECT-SKILL-MARKER\n---\nProject skill.\n",
			);
			await mkdir(join(cwd, ".atomic"), { recursive: true });
			await writeFile(join(cwd, ".atomic", "settings.json"), JSON.stringify({ packages: [pkg] }));
		}
		if (askingWorkflow) {
			await mkdir(operatorPackageDir, { recursive: true });
			await writeFile(
				join(operatorPackageDir, "package.json"),
				JSON.stringify({
					name: "asking-package",
					type: "module",
					atomic: { workflows: ["./workflow.ts"] },
				}),
			);
			await writeFile(
				join(operatorPackageDir, "workflow.ts"),
				`import { workflow } from "@bastani/atomic/workflows";
export default workflow({
	name: "asking-workflow",
	description: "A stage that asks the user a question",
	inputs: {},
	outputs: {},
	run: async ctx => {
		await ctx.task("grill-me-1", { prompt: "question" });
		return {};
	},
});
`,
			);
		}
		if (operatorPackage) {
			await mkdir(join(operatorPackageDir, "skills", "operator-package-marker"), {
				recursive: true,
			});
			await writeFile(
				join(operatorPackageDir, "package.json"),
				JSON.stringify({
					name: "operator-package",
					type: "module",
					atomic: {
						extensions: ["./extension.ts"],
						skills: ["./skills"],
						workflows: ["./workflow.ts"],
					},
				}),
			);
			await writeFile(
				join(operatorPackageDir, "extension.ts"),
				`export default api => api.registerTool({name: "operator_package_tool", label: "Operator package", description: "Marker", parameters: {type:"object"}, async execute() { return {content:[{type:"text",text:"operator package"}], details:{}}; }});`,
			);
			await writeFile(
				join(operatorPackageDir, "skills", "operator-package-marker", "SKILL.md"),
				"---\nname: operator-package-marker\ndescription: OPERATOR-PACKAGE-SKILL-MARKER\n---\nOperator package skill.\n",
			);
			await writeFile(
				join(operatorPackageDir, "workflow.ts"),
				`import { workflow } from "@bastani/atomic/workflows";
export default workflow({
	name: "operator-package-workflow",
	description: "OPERATOR-PACKAGE-WORKFLOW-MARKER",
	inputs: {},
	outputs: {},
	run: async () => ({}),
});
`,
			);
		}
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
		let humanInput: HostInput = host ?? {
			confirm: async () => false,
			select: async () => undefined,
			input: async () => undefined,
			editor: async () => undefined,
			questionnaire: async (value, options) => {
				received.push(value);
				expect(options.requestId).toBeString();
				return {
					answers: [{
						questionIndex: 0,
						question: value.questions[0]!.question,
						kind: "option",
						answer: "Second",
					}],
					cancelled: false,
				};
			},
		};
		let sessionId = crypto.randomUUID();
		if (registered) release = registerFullPlanner(sessionId, { cwd, humanInput });
		let agent = new HarnessAgent({
			harness,
			instructions: "CHOPIN-INSTRUCTIONS-MARKER",
			permissionMode: "allow-reads",
			tools: {
				host_tool: tool({
					inputSchema: jsonSchema({ type: "object" }),
					execute: async () => "host",
				}),
			},
			activeTools: ["host_tool"],
		});
		let session = await agent.createSession({ sessionId, sandboxSession: sandbox });
		stub.requests.length = 0;
		try {
			let result = await agent.stream({ session, prompt });
			await result.consumeStream();
			await result.text;
			await afterTurn?.();
			let requests = [...stub.requests];
			if (!worker) {
				let files = {
					operator: await Bun.file(join(agentDir, "settings.json")).exists(),
					project: projectPackage
						? await Bun.file(join(cwd, ".atomic", "settings.json")).text()
						: undefined,
				};
				return { cwd, received, requests, workerRequests: [], files };
			}
			let workerSession = await agent.createSession({ sandboxSession: sandbox });
			try {
				stub.requests.length = 0;
				let output = await agent.stream({ session: workerSession, prompt: "plain" });
				await output.consumeStream();
				return { cwd, received, requests, workerRequests: [...stub.requests] };
			} finally {
				await workerSession.destroy();
			}
		} finally {
			await session.destroy();
		}
	} finally {
		release?.();
		await harness.shutdown();
		await sandbox.destroy();
		if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
}

const PLANNER_TOOLS = [
	"read",
	"find",
	"search",
	"ask_user_question",
	"workflow",
	"intercom",
	"web_search",
	"host_tool",
];
const WITHHELD_TOOLS = ["bash", "edit", "write", "todo", "subagent", "operator_tool"];

function expectPlannerTools(toolNames: string[]): void {
	for (let name of PLANNER_TOOLS) expect(toolNames).toContain(name);
	for (let name of WITHHELD_TOOLS) expect(toolNames).not.toContain(name);
	for (let name of toolNames) expect([...FULL_PLANNER_TOOLS, "host_tool"]).toContain(name);
}

test("registered Planner sessions load operator resources and offer only read-only Atomic tools beside host tools", async () => {
	let result = await run(true);
	let request = result.requests[0]!;
	expectPlannerTools(request.toolNames);
	expect(request.toolNames).not.toContain(ATOMIC_RESULT_TOOL_NAME);
	for (
		let marker of [
			"OPERATOR-CONTEXT-MARKER",
			"OPERATOR-SKILL-MARKER",
			"CHOPIN-INSTRUCTIONS-MARKER",
			result.cwd,
		]
	) expect(request.system).toContain(marker);
	expect(request.system).not.toBe(ATOMIC_DEFAULT_SYSTEM_PROMPT);
});

test("Planner sessions use their checkout cwd and route ask_user_question through HostInput", async () => {
	let cwd = await run(true, "cwd");
	expect(cwd.requests.at(-1)!.toolResults.join("\n")).toContain(cwd.cwd);
	let question = await run(true, "question");
	expect(question.received).toEqual([params]);
	expect(question.requests.at(-1)!.toolResults.join("\n")).toContain("Second");
	let prompt = await run(true, "/marker");
	expect(prompt.requests[0]!.prompt).toBe("OPERATOR-PROMPT-MARKER");
});

test("a Planner session without a checkout is just as full in its empty working directory", async () => {
	let result = await run(true, "cwd", { checkout: false });
	expectPlannerTools(result.requests[0]!.toolNames);
	expect(result.requests[0]!.system).toContain(result.cwd);
	expect(result.requests.at(-1)!.toolResults.join("\n")).toContain(result.cwd);
});

test("a checkout's project settings add its packages without writing either settings file", async () => {
	let result = await run(true, "plain", { projectPackage: true });
	let request = result.requests[0]!;
	expect(request.toolNames).not.toContain("project_tool");
	expect(request.system).toContain("PROJECT-SKILL-MARKER");
	expectPlannerTools(request.toolNames);
	expect(result.files!.operator).toBe(false);
	expect(JSON.parse(result.files!.project!).packages).toHaveLength(1);
	let plain = await run(true);
	expect(plain.requests[0]!.system).not.toContain("PROJECT-SKILL-MARKER");
});

/** The first workflow tool call starts Atomic's durable backend, which falls back slowly without Postgres. */
const WORKFLOW_TOOL_TIMEOUT_MS = 30_000;

test(
	"operator extension paths add a package's skills and workflows to Planner sessions only, but not its tools to the Planner's turns",
	async () => {
		let result = await run(true, "workflows", { operatorPackage: true, worker: true });
		let request = result.requests[0]!;
		expect(request.toolNames).not.toContain("operator_package_tool");
		expect(request.system).toContain("OPERATOR-PACKAGE-SKILL-MARKER");
		expect(result.requests.at(-1)!.toolResults.join("\n")).toContain("operator-package-workflow");
		expect(result.workerRequests[0]!.toolNames).not.toContain("operator_package_tool");
	},
	WORKFLOW_TOOL_TIMEOUT_MS,
);

test("without operator extension paths, Planner sessions have none of that package", async () => {
	let plain = await run(true, "workflows");
	expect(plain.requests[0]!.toolNames).not.toContain("operator_package_tool");
	expect(plain.requests.at(-1)!.toolResults.join("\n")).not.toContain("operator-package-workflow");
}, WORKFLOW_TOOL_TIMEOUT_MS);

test("free-text Decisions answers to multi-select and preview questions reach the model", async () => {
	let room = await hostInputRoom();
	try {
		for (let prompt of ["multiple", "preview"]) {
			let turn = run(true, prompt, { host: room.input });
			let [card] = await room.cards(1);
			await room.answer(card!.id, `  typed ${prompt}\n`);
			let output = (await turn).requests.at(-1)!.toolResults.join("\n");
			expect(output).toContain(`  typed ${prompt}\n`);
			expect(output).not.toContain("InvalidHostInput");
		}
	} finally {
		await room.close();
	}
});

test(
	"a workflow stage keeps its own tools, and its ask_user_question reaches Decisions and its answer returns to the stage",
	async () => {
		let room = await hostInputRoom();
		// Atomic gives workflow stages a canned session under a test runtime.
		let environment = process.env.NODE_ENV;
		delete process.env.NODE_ENV;
		try {
			let seen: string[] = [];
			await run(true, "launch", {
				host: room.input,
				askingWorkflow: true,
				afterTurn: async () => {
					// The stage starts after Atomic's workflow backend does.
					let open = Store.outstanding(room.plan.questions);
					for (let deadline = Date.now() + 30_000; !open.length && Date.now() < deadline;) {
						await Bun.sleep(100);
						open = Store.outstanding(room.plan.questions);
					}
					let [card] = open;
					seen.push(card!.definition.questions[0].question);
					seen.push(Plan.source(room.plan));
					await room.answer(card!.id, [1]);
					// The stage receives the answer and its model replies.
					let deadline = Date.now() + 15_000;
					while (
						Date.now() < deadline
						&& !stub.requests.some(request =>
							request.toolResults.some(text => text.includes("Second"))
						)
					) await new Promise(resolve => setTimeout(resolve, 100));
				},
			});
			expect(seen[0]).toContain("Which option?");
			expect(seen[1]).toContain("<Questionnaire");
			expect(
				stub.requests.some(request => request.toolResults.some(text => text.includes("Second"))),
			)
				.toBe(true);
			let stage = stub.requests.find(request =>
				request.toolResults.some(text => text.includes("Second"))
			)!;
			expect(stage.toolNames).toContain("bash");
			expect(stage.toolNames).toContain("write");
		} finally {
			if (environment !== undefined) process.env.NODE_ENV = environment;
			await room.close();
		}
	},
	60_000,
);

test("worker sessions stay isolated, even beside a full Planner session on the same harness", async () => {
	let alone = await run(false);
	expect(alone.requests[0]!.toolNames).toEqual(["host_tool"]);
	expect(alone.requests[0]!.system).toBe("CHOPIN-INSTRUCTIONS-MARKER");
	let beside = await run(true, "plain", { worker: true });
	expect(beside.requests[0]!.toolNames).toContain("read");
	expect(beside.workerRequests).toHaveLength(1);
	expect(beside.workerRequests[0]!.toolNames).toEqual(["host_tool"]);
	expect(beside.workerRequests[0]!.system).toBe("CHOPIN-INSTRUCTIONS-MARKER");
});

test("paused roots are paused, roots whose run ended are neither, and every other root is live", () => {
	let root = (rootRunId: string, state: "working" | "idle" | "blocked", reason: string) =>
		({
			rootRunId,
			ownerSessionId: "session",
			state,
			reason,
			activeExecutionCount: 0,
			actionableBlockCount: 0,
			needsAttention: false,
		}) as Parameters<typeof classifyRuns>[0] extends Iterable<infer T> ? T : never;
	expect(classifyRuns([
		root("drafting", "working", "executing"),
		root("asking", "blocked", "awaiting_input"),
		root("between-steps", "idle", "quiescent"),
		root("held", "idle", "paused"),
		root("done", "idle", "quiescent"),
	], new Set(["done"]))).toEqual({
		active: ["drafting", "asking", "between-steps"],
		paused: ["held"],
	});
	expect(classifyRuns([])).toEqual({ active: [], paused: [] });
});

test("run cards fold lifecycle events into ordered stages, Decisions waits, and paused or finished status", async () => {
	let { foldLifecycle, runCards } = await import("./full");
	let cards = new Map();
	let event = (target: object, at: number) =>
		({
			type: "workflow_lifecycle",
			eventId: `e${at}`,
			cursor: { epoch: "e", revision: at },
			runId: "run-1",
			rootRunId: "run-1",
			ownerSessionId: "session",
			occurredAt: at * 1000,
			observedAt: at * 1000,
			delivery: "live",
			target,
		}) as never;
	foldLifecycle(
		cards,
		event({ kind: "run", runId: "run-1", status: "running" }, 100),
		"plan-review",
	);
	foldLifecycle(
		cards,
		event(
			{ kind: "stage", runId: "run-1", stageId: "a", stageName: "draft-1", status: "running" },
			101,
		),
	);
	foldLifecycle(
		cards,
		event({ kind: "prompt", runId: "run-1", stageId: "a", promptId: "p1", status: "opened" }, 160),
	);
	foldLifecycle(
		cards,
		event({
			kind: "stage",
			runId: "run-1",
			stageId: "a",
			stageName: "draft-1",
			status: "awaiting_input",
		}, 160),
	);
	let [waiting] = runCards(cards, { active: ["run-1"], paused: [] });
	expect(waiting).toMatchObject({
		id: "run-1",
		name: "plan-review",
		status: "waiting",
		waiting: 1,
		started: 100,
		stages: [{ id: "run-1:a", name: "draft-1", status: "awaiting_input", started: 101 }],
	});
	expect(runCards(cards, { active: [], paused: ["run-1"] })[0]!.status).toBe("paused");
	foldLifecycle(
		cards,
		event(
			{ kind: "prompt", runId: "run-1", stageId: "a", promptId: "p1", status: "answered" },
			200,
		),
	);
	foldLifecycle(
		cards,
		event({
			kind: "stage",
			runId: "run-1",
			stageId: "a",
			stageName: "draft-1",
			status: "completed",
		}, 300),
	);
	foldLifecycle(
		cards,
		event({
			kind: "stage",
			runId: "run-1",
			stageId: "b",
			stageName: "reviewer-a-1",
			status: "running",
		}, 301),
	);
	let [running] = runCards(cards, { active: ["run-1"], paused: [] });
	expect(running!.status).toBe("running");
	expect(running!.waiting).toBe(0);
	expect(running!.stages.map(stage => [stage.name, stage.status, stage.ended])).toEqual([
		["draft-1", "completed", 300],
		["reviewer-a-1", "running", undefined],
	]);
	foldLifecycle(cards, event({ kind: "run", runId: "run-1", status: "completed" }, 900));
	expect(runCards(cards, { active: [], paused: [] })[0]).toMatchObject({
		status: "finished",
		ended: 900,
	});
});

test("Stop and Resume use the session's run control, and a partial pause is reported", async () => {
	let calls: unknown[] = [];
	let outcome = { action: "pause", runId: "--all", status: "paused", message: "Paused 1 run(s)." };
	let workflows = {
		pause: async (target: unknown) => {
			calls.push(["pause", target]);
			return outcome;
		},
		listRuns: async (filter: unknown) => {
			calls.push(["listRuns", filter]);
			return [{ runId: "run-1" }, { runId: "run-2" }];
		},
		resume: async (runId: string) => {
			calls.push(["resume", runId]);
			return { action: "resume", runId, status: "running", message: "" };
		},
	} as unknown as SessionWorkflows;
	await pauseOwnedRuns(workflows);
	await resumeOwnedRuns(workflows);
	expect(calls).toEqual([
		["pause", { all: true }],
		["listRuns", { status: "paused" }],
		["resume", "run-1"],
		["resume", "run-2"],
	]);
	outcome = {
		...outcome,
		status: "partial",
		failedRuns: [{ runId: "run-2", reason: "pause_failed", message: "busy" }],
	} as typeof outcome;
	await expect(pauseOwnedRuns(workflows)).rejects.toThrow("run-2: busy");
});

test("an answer to a paused run's question is held until the run resumes, including child runs", async () => {
	let planner: FullPlanner = {
		cwd: "/",
		humanInput: {} as HostInput,
		runs: { active: [], paused: ["root"], cards: [] },
		rootOf: runId => runId === "child" ? "root" : runId,
	};
	let released: string[] = [];
	let controller = new AbortController();
	let held = untilUnpaused(planner, "child", controller.signal).then(() => released.push("child"));
	await untilUnpaused(planner, "other", controller.signal).then(() => released.push("other"));
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(released).toEqual(["other"]);
	planner.runs = { active: ["root"], paused: [], cards: [] };
	for (let wake of planner.waiters ?? []) wake();
	await held;
	expect(released).toEqual(["other", "child"]);

	planner.runs = { active: [], paused: ["root"], cards: [] };
	let aborted = new AbortController();
	let pending = untilUnpaused(planner, "root", aborted.signal);
	aborted.abort();
	await pending;
	expect(planner.waiters?.size ?? 0).toBe(0);
});

test("a run whose stage waits on a question counts as waiting even without prompt events", () => {
	let cards = new Map([["root", {
		id: "root",
		name: "plan-review",
		status: "running" as const,
		started: 0,
		updated: 0,
		stages: [{ id: "root:s", name: "draft-1", status: "awaiting_input" as const }],
		waiting: 0,
		stageIndex: new Map(),
		prompts: new Set<string>(),
	}]]);
	expect(runCards(cards, { active: ["root"], paused: [] })[0]).toMatchObject({
		status: "waiting",
		waiting: 1,
	});
});

test("a new run clears ended cards, keeps live ones, and lists only the twelve most recent stages", async () => {
	let { foldLifecycle } = await import("./full");
	let cards = new Map();
	let event = (rootRunId: string, target: object, at: number) =>
		({
			type: "workflow_lifecycle",
			eventId: `${rootRunId}-${at}`,
			cursor: { epoch: "e", revision: at },
			runId: rootRunId,
			rootRunId,
			ownerSessionId: "session",
			occurredAt: at * 1000,
			observedAt: at * 1000,
			delivery: "live",
			target,
		}) as never;
	foldLifecycle(
		cards,
		event("done", { kind: "run", runId: "done", status: "running" }, 1),
		"first",
	);
	foldLifecycle(cards, event("done", { kind: "run", runId: "done", status: "completed" }, 2));
	foldLifecycle(
		cards,
		event("live", { kind: "run", runId: "live", status: "running" }, 3),
		"second",
	);
	expect([...cards.keys()]).toEqual(["live"]);
	foldLifecycle(
		cards,
		event("other", { kind: "run", runId: "other", status: "running" }, 4),
		"third",
	);
	expect([...cards.keys()]).toEqual(["live", "other"]);

	for (let index = 0; index < 15; index++) {
		foldLifecycle(
			cards,
			event("live", {
				kind: "stage",
				runId: "live",
				stageId: `s${index}`,
				stageName: `stage-${index}`,
				status: "completed",
			}, 10 + index),
		);
	}
	let [card] = runCards(cards, { active: ["live", "other"], paused: [] });
	expect(card?.stages).toHaveLength(12);
	expect(card?.stages[0]?.name).toBe("stage-3");
	expect(card?.earlierStages).toBe(3);
});

test("ctx.tool steps appear among the stages, marked as tool steps", async () => {
	let { foldLifecycle } = await import("./full");
	let cards = new Map();
	let event = (target: object, at: number) =>
		({
			type: "workflow_lifecycle",
			eventId: `t${at}`,
			cursor: { epoch: "e", revision: at },
			runId: "run-1",
			rootRunId: "run-1",
			ownerSessionId: "session",
			occurredAt: at * 1000,
			observedAt: at * 1000,
			delivery: "live",
			target,
		}) as never;
	foldLifecycle(cards, event({ kind: "run", runId: "run-1", status: "running" }, 1), "demo");
	let tool = (toolNodeId: string, toolName: string, status: string, at: number) =>
		foldLifecycle(cards, event({ kind: "tool", runId: "run-1", toolNodeId, toolName, status }, at));
	tool("t1", "prepare", "running", 2);
	tool("t1", "prepare", "cached", 5);
	tool("t2", "work", "running", 6);
	tool("t3", "finish", "cancelled", 7);
	let [card] = runCards(cards, { active: ["run-1"], paused: [] });
	expect(card?.stages).toEqual([
		{ id: "run-1:t1", name: "prepare", kind: "tool", status: "completed", started: 2, ended: 5 },
		{ id: "run-1:t2", name: "work", kind: "tool", status: "running", started: 6 },
		{ id: "run-1:t3", name: "finish", kind: "tool", status: "skipped", ended: 7 },
	]);
});
