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
} from "./adapter";
import { registerFullPlanner } from "./full";
import { startStubModelServer } from "../pi/model-stub";
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
let stub = startStubModelServer((prompt, prior) =>
	prior
		? { kind: "text", text: "Answered." }
		: prompt === "question"
		? { kind: "tool", name: "ask_user_question", arguments: JSON.stringify(params) }
		: freeText[prompt]
		? { kind: "tool", name: "ask_user_question", arguments: JSON.stringify(freeText[prompt]) }
		: prompt === "cwd"
		? { kind: "tool", name: "bash", arguments: JSON.stringify({ command: "pwd" }) }
		: { kind: "text", text: "Ready." }
);
afterAll(stub.stop);

async function run(
	registered: boolean,
	prompt = "plain",
	{ host, checkout = true, worker = false }: {
		host?: HostInput;
		/** False runs the Planner in an empty directory, as a channel without a checkout does. */
		checkout?: boolean;
		/** Also run an unregistered worker session on the same harness while the Planner is open. */
		worker?: boolean;
	} = {},
) {
	let root = await mkdtemp(join(tmpdir(), "chopin-atomic-full-"));
	let agentDir = join(root, "agent");
	let cwd = join(root, checkout ? "checkout" : "empty");
	let previous = process.env.ATOMIC_CODING_AGENT_DIR;
	let received: QuestionParams[] = [];
	let harness = createAtomicAdapter({
		auth: "ai-gateway",
		model: "stub/model",
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
			let requests = [...stub.requests];
			if (!worker) return { cwd, received, requests, workerRequests: [] };
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

const FULL_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"ask_user_question",
	"workflow",
	"subagent",
	"intercom",
	"web_search",
	"operator_tool",
	"host_tool",
];

test("registered Planner sessions load operator resources and expose Atomic tools beside host tools", async () => {
	let result = await run(true);
	let request = result.requests[0]!;
	for (let name of FULL_TOOLS) expect(request.toolNames).toContain(name);
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
	for (let name of FULL_TOOLS) expect(result.requests[0]!.toolNames).toContain(name);
	expect(result.requests[0]!.system).toContain(result.cwd);
	expect(result.requests.at(-1)!.toolResults.join("\n")).toContain(result.cwd);
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

test("worker sessions stay isolated, even beside a full Planner session on the same harness", async () => {
	let alone = await run(false);
	expect(alone.requests[0]!.toolNames).toEqual(["host_tool"]);
	expect(alone.requests[0]!.system).toBe("CHOPIN-INSTRUCTIONS-MARKER");
	let beside = await run(true, "plain", { worker: true });
	expect(beside.requests[0]!.toolNames).toContain("bash");
	expect(beside.workerRequests).toHaveLength(1);
	expect(beside.workerRequests[0]!.toolNames).toEqual(["host_tool"]);
	expect(beside.workerRequests[0]!.system).toBe("CHOPIN-INSTRUCTIONS-MARKER");
});
