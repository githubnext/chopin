import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";
import { jsonSchema, tool } from "ai";
import { SessionManager } from "@bastani/atomic";
import {
	ATOMIC_DEFAULT_SYSTEM_PROMPT,
	ATOMIC_RESULT_TOOL_NAME,
	createAtomicAdapter,
	entrySnapshots,
	FULL_PLANNER_TOOLS,
	operatorPlannerTools,
} from "./adapter";
import { type FullPlanner, registerFullPlanner } from "./full";
import { startStubModelServer } from "./model-stub";
import { hostInputRoom } from "../../testing/decisions";
import type { HostInput, QuestionParams } from "@bastani/atomic";

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
/** A forked subagent receives its launcher's conversation, project context and skills. */
let FORKED_LAUNCH = { agent: "worker", task: "Summarize the document.", context: "fork" };
let stub = startStubModelServer((prompt, prior) =>
	prior
		? { kind: "text", text: "Answered." }
		: prompt === "question"
		? { kind: "tool", name: "ask_user_question", arguments: JSON.stringify(params) }
		: freeText[prompt]
		? { kind: "tool", name: "ask_user_question", arguments: JSON.stringify(freeText[prompt]) }
		: prompt === "cwd"
		? { kind: "tool", name: "read", arguments: JSON.stringify({ path: "where.txt" }) }
		: prompt === "intercom"
		? { kind: "tool", name: "intercom", arguments: JSON.stringify({ action: "list" }) }
		: prompt === "intercom-script"
		? {
			kind: "tool",
			name: "codemode",
			arguments: JSON.stringify({ code: 'return await tools.intercom({ action: "list" });' }),
		}
		: prompt === "subagent"
		? { kind: "tool", name: "subagent", arguments: JSON.stringify(FORKED_LAUNCH) }
		: prompt === "subagent-script"
		? {
			kind: "tool",
			name: "codemode",
			arguments: JSON.stringify({
				code: `return await tools.subagent(${JSON.stringify(FORKED_LAUNCH)});`,
			}),
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
		operatorSettings,
		afterTurn,
		during,
		events,
		sessionEntries,
		branchLeafId,
		saved,
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
		/** The operator's Atomic `settings.json`, as the host CLI would have written it. */
		operatorSettings?: Record<string, unknown>;
		/** Runs once the Planner's turn has ended, while its session is still live. */
		afterTurn?: () => Promise<void>;
		/** Runs while the turn is under way, with the session the turn runs in. */
		during?: (session: Awaited<ReturnType<HarnessAgent["createSession"]>>) => Promise<void>;
		/** Collects, in order, the tool reports the adapter makes and the stream parts a tool yields. */
		events?: string[];
		/** Serialized Atomic entries the Planner's session starts from, as a fork or a thread restores them. */
		sessionEntries?: unknown[];
		/** The entry the Planner's session branches from before its turn. */
		branchLeafId?: string | null;
		/** Collects every snapshot of its entries the Planner's session saves. */
		saved?: Array<{ entries: unknown[]; leafId: string | null }>;
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
		extensions: operatorPackage ? [operatorPackageDir] : undefined,
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
			`export default api => {
	api.registerTool({name: "operator_tool", label: "Operator", description: "Marker", parameters: {type:"object"}, async execute() { return {content:[{type:"text",text:"marker"}], details:{}}; }});
	api.on("session_start", (_event, ctx) => {
		globalThis.chopinTestPlannerContext = { mode: ctx.mode, hasUI: ctx.hasUI };
	});
	let nudged = false;
	api.on("agent_end", () => {
		let how = process.env.CHOPIN_TEST_SELF_STARTED_TURN;
		if (!how || nudged) return;
		nudged = true;
		setTimeout(() => how === "queued"
			? api.sendUserMessage("SELF-STARTED", { deliverAs: "followUp" })
			: api.sendMessage({ customType: "self-started", content: "SELF-STARTED", display: true }, { triggerTurn: true }), 20);
	});
};`,
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
			// A checkout naming its own tool for the Planner's turns, which only the operator's settings may do.
			await writeFile(
				join(cwd, ".atomic", "settings.json"),
				JSON.stringify({ packages: [pkg], chopin: { plannerTools: ["project_tool"] } }),
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
					atomic: { extensions: ["./extension.ts"], skills: ["./skills"] },
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
		}
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
		if (operatorSettings) {
			await writeFile(join(agentDir, "settings.json"), JSON.stringify(operatorSettings));
		}
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
		let planner: FullPlanner = {
			cwd,
			humanInput,
			toolReport: events && ((_id, _output, state) => events.push(`report:${state}`)),
			...(sessionEntries ? { sessionEntries } : {}),
			...(branchLeafId !== undefined ? { branchLeafId } : {}),
			...(saved ? { onSessionEntries: (entries, leafId) => saved.push({ entries, leafId }) } : {}),
		};
		if (registered) release = registerFullPlanner(sessionId, planner);
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
			let meanwhile = during?.(session);
			let parts: { type: string; toolName?: string; dynamic?: boolean; preliminary?: boolean }[] =
				[];
			for await (let part of result.fullStream) {
				parts.push(part as (typeof parts)[number]);
				if (part.type === "tool-result" && part.dynamic) {
					events?.push(part.preliminary ? "part:partial" : "part:final");
				}
			}
			await result.text;
			await meanwhile;
			await afterTurn?.();
			let requests = [...stub.requests];
			if (!worker) {
				let files = {
					operator: await Bun.file(join(agentDir, "settings.json")).exists(),
					project: projectPackage
						? await Bun.file(join(cwd, ".atomic", "settings.json")).text()
						: undefined,
				};
				return {
					cwd,
					received,
					requests,
					workerRequests: [],
					files,
					parts,
					offered: planner.activeTools,
				};
			}
			let workerSession = await agent.createSession({ sandboxSession: sandbox });
			try {
				stub.requests.length = 0;
				let output = await agent.stream({ session: workerSession, prompt: "plain" });
				await output.consumeStream();
				return {
					cwd,
					received,
					requests,
					workerRequests: [...stub.requests],
					parts,
					offered: planner.activeTools,
				};
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
	"web_search",
	"codemode",
	"host_tool",
];
const WITHHELD_TOOLS = ["bash", "edit", "write", "todo", "subagent", "intercom", "operator_tool"];

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

test("a Planner reaches no session through Atomic's intercom, from a script or named by the operator", async () => {
	let cases: Array<[string, string, Record<string, unknown> | undefined]> = [
		["called directly", "intercom", undefined],
		["called from codemode", "intercom-script", undefined],
		["named in plannerTools", "intercom", { chopin: { plannerTools: ["intercom"] } }],
	];
	for (let [label, prompt, operatorSettings] of cases) {
		let result = await run(true, prompt, operatorSettings ? { operatorSettings } : {});
		expect(result.requests[0]!.toolNames, label).not.toContain("intercom");
		expect(result.offered, label).not.toContain("intercom");
		let refusal = result.requests.at(-1)!.toolResults.join("\n");
		expect(refusal, label).toContain("intercom");
		expect(refusal, label).toMatch(/not found|not available|does not exist/);
	}
});

test("a Planner's Atomic session has no terminal, so Atomic's Intercom never makes it reachable before it is used", async () => {
	// Atomic 0.10 has an interactive terminal session join Intercom a few seconds after it starts,
	// so other sessions can list and message it; any other session joins only when it uses Intercom,
	// which a Planner's turns never may.
	let context = globalThis as { chopinTestPlannerContext?: { mode: string; hasUI: boolean } };
	delete context.chopinTestPlannerContext;
	await run(true);
	expect(context.chopinTestPlannerContext).toBeDefined();
	expect(context.chopinTestPlannerContext!.mode).not.toBe("tui");
	expect(context.chopinTestPlannerContext!.hasUI).toBe(false);
});

test("a Planner forks no agent through Atomic's subagent tool, called directly or from a codemode script", async () => {
	for (let prompt of ["subagent", "subagent-script"]) {
		let result = await run(true, prompt);
		expect(result.requests[0]!.toolNames, prompt).not.toContain("subagent");
		expect(result.offered, prompt).not.toContain("subagent");
		let refusal = result.requests.at(-1)!.toolResults.join("\n");
		expect(refusal, prompt).toContain("subagent");
		expect(refusal, prompt).toMatch(/not found|not available|does not exist/);
	}
});

test("a full Planner streams an Atomic builtin live and reports its tools as the turn's active set", async () => {
	let result = await run(true, "cwd");
	let builtin = result.parts.find(part => part.type === "tool-call" && part.dynamic)?.toolName;
	expect(builtin).toBeDefined();
	let own = result.parts.filter(part => part.toolName === builtin);
	let types = own.map(part => part.type);
	expect(types.slice(0, 2)).toEqual(["tool-input-start", "tool-call"]);
	expect(types.at(-1)).toBe("tool-result");
	expect(own.at(-1)?.preliminary).not.toBe(true);
	expect(result.offered).toContain(builtin);
	expect(result.offered).toContain("host_tool");
});

test("a full Planner reports an Atomic builtin's end before the harness yields its result", async () => {
	let events: string[] = [];
	await run(true, "cwd", { events });
	expect(events).toContain("report:done");
	expect(events.indexOf("report:done")).toBeLessThan(events.indexOf("part:final"));
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

test("a Planner turn takes a person's message while it runs, and the model reads it as its next input", async () => {
	let asked = Promise.withResolvers<void>();
	let released = Promise.withResolvers<void>();
	let host: HostInput = {
		confirm: async () => false,
		select: async () => undefined,
		input: async () => undefined,
		editor: async () => undefined,
		questionnaire: async value => {
			asked.resolve();
			await released.promise;
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
	let result = await run(true, "question", {
		host,
		during: async session => {
			// The turn is inside its tool call: the message waits for the step's end, not for the turn's.
			await asked.promise;
			await session.experimental_steerTurn("@bo: Also say what the rollout costs.");
			released.resolve();
		},
	});
	expect(result.requests).toHaveLength(2);
	expect(result.requests[1]!.hasPriorToolResult).toBe(true);
	expect(result.requests[1]!.prompt).toBe("@bo: Also say what the rollout costs.");
});

test("a Planner session without a checkout is just as full in its empty working directory", async () => {
	let result = await run(true, "cwd", { checkout: false });
	expectPlannerTools(result.requests[0]!.toolNames);
	expect(result.requests[0]!.system).toContain(result.cwd);
	expect(result.requests.at(-1)!.toolResults.join("\n")).toContain(result.cwd);
});

test("the operator's chopin.plannerTools adds a read-only tool an extension registers to the Planner's own turns", async () => {
	let result = await run(true, "plain", {
		operatorSettings: { chopin: { plannerTools: ["operator_tool"] } },
	});
	let names = result.requests[0]!.toolNames;
	expect(names).toContain("operator_tool");
	for (let name of WITHHELD_TOOLS.filter(name => name !== "operator_tool")) {
		expect(names).not.toContain(name);
	}
	for (let name of names) {
		expect([...FULL_PLANNER_TOOLS, "operator_tool", "host_tool"]).toContain(name);
	}
});

test("chopin.plannerTools takes only a list of names, and never a tool that writes, runs commands or starts agents", () => {
	expect([...operatorPlannerTools({})]).toEqual([]);
	expect([...operatorPlannerTools({ chopin: { plannerTools: ["code_search_extra"] } })]).toEqual([
		"code_search_extra",
	]);
	for (let bad of ["bash", "edit", "write", "kill", "subagent", "todo"]) {
		expect(() => operatorPlannerTools({ chopin: { plannerTools: ["read", bad] } })).toThrow(bad);
	}
	for (let malformed of ["bash", [""], [1], { name: "x" }]) {
		expect(() => operatorPlannerTools({ chopin: { plannerTools: malformed } })).toThrow(
			"list of tool names",
		);
	}
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

test("operator extension paths add a package's skills to Planner sessions only, but not its tools to the Planner's turns", async () => {
	let result = await run(true, "plain", { operatorPackage: true, worker: true });
	let request = result.requests[0]!;
	expect(request.toolNames).not.toContain("operator_package_tool");
	expect(request.system).toContain("OPERATOR-PACKAGE-SKILL-MARKER");
	expect(result.workerRequests[0]!.toolNames).not.toContain("operator_package_tool");
	expect(result.workerRequests[0]!.system).not.toContain("OPERATOR-PACKAGE-SKILL-MARKER");
});

test("without operator extension paths, Planner sessions have none of that package", async () => {
	let plain = await run(true);
	expect(plain.requests[0]!.toolNames).not.toContain("operator_package_tool");
	expect(plain.requests[0]!.system).not.toContain("OPERATOR-PACKAGE-SKILL-MARKER");
});

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

// Atomic starts a turn for its own notices, and since 0.9.41 for a message queued on an idle session.
test.each(["notice", "queued"])(
	"a turn Atomic starts by itself (%s) between the Planner's turns is stopped before it reaches the model",
	async how => {
		process.env.CHOPIN_TEST_SELF_STARTED_TURN = how;
		try {
			let result = await run(true, "plain", {
				afterTurn: () => new Promise(resolve => setTimeout(resolve, 500)),
			});
			expect(result.requests).toHaveLength(1);
		} finally {
			delete process.env.CHOPIN_TEST_SELF_STARTED_TURN;
		}
	},
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

/** A session with a turn before a compaction and one after it, as Atomic saves it. */
async function compactedSession(): Promise<{ entries: unknown[]; ids: string[] }> {
	let manager = SessionManager.inMemory("/");
	let ids: string[] = [];
	let usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let turn = async (text: string) => {
		ids.push(await manager.appendMessage({ role: "user", content: text, timestamp: Date.now() }));
		ids.push(
			await manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `${text} answered` }],
				api: "openai-completions",
				provider: "stub",
				model: "model",
				usage,
				stopReason: "stop",
				timestamp: Date.now(),
			} as never),
		);
	};
	await turn("before");
	await manager.appendCompaction("Context cleared.", null, 100, {
		strategy: "verbatim-lines",
		promptVersion: 7,
		parameters: { query: "before" },
		stats: {
			linesBefore: 2,
			linesDeleted: 2,
			linesKept: 0,
			rangeCount: 0,
			tokensBefore: 100,
			tokensAfter: 1,
			percentReduction: 99,
		},
		form: "cleared",
	});
	ids.push(manager.getLeafId()!);
	await turn("after");
	expect(manager.hasFullHistory()).toBe(false);
	await manager.loadFullHistory();
	return { entries: [manager.getHeader(), ...manager.getEntries()], ids };
}

function entryIds(entries: unknown[]): string[] {
	return entries.slice(1).map(entry => (entry as { id: string }).id);
}

test("snapshots of a session's entries keep every entry after a compaction, and none replaces a fuller one", async () => {
	let saved: number[] = [];
	let save = entrySnapshots(entries => saved.push(entries.length - 1));
	let { entries } = await compactedSession();
	let manager = await SessionManager.inMemory("/", undefined, entries as never);
	// Atomic opens a saved session at its current context window.
	expect(manager.hasFullHistory()).toBe(false);
	let pending = save(manager);
	// Asked for while the whole history loads, this one waits behind it rather than saving the window.
	let next = save(manager);
	await Promise.all([pending, next]);
	expect(saved).toEqual([entries.length - 1, entries.length - 1]);
	await manager.appendMessage({ role: "user", content: "later", timestamp: Date.now() });
	await save(manager);
	expect(saved.at(-1)).toBe(entries.length);
	expect(saved).toEqual([...saved].sort((a, b) => a - b));
});

test("a Planner restored from a compacted session can branch from before the compaction and saves every entry", async () => {
	let { entries, ids } = await compactedSession();
	let saved: Array<{ entries: unknown[]; leafId: string | null }> = [];
	// The first turn's answer, from before the compaction.
	let branch = ids[1]!;
	let result = await run(true, "plain", { sessionEntries: entries, branchLeafId: branch, saved });
	expect(result.requests).toHaveLength(1);
	let last = saved.at(-1)!;
	let kept = entryIds(last.entries);
	for (let id of ids) expect(kept).toContain(id);
	let added = last.entries.slice(entries.length) as Array<{ parentId: string | null }>;
	expect(added.length).toBeGreaterThan(0);
	expect(added[0]!.parentId).toBe(branch);
	for (let snapshot of saved) {
		expect(entryIds(snapshot.entries)).toEqual(kept.slice(0, snapshot.entries.length - 1));
	}
});
