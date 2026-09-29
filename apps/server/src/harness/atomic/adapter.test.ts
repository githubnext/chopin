import { expect, test } from "bun:test";

import {
	ATOMIC_DEFAULT_SYSTEM_PROMPT,
	ATOMIC_RESULT_INSTRUCTION,
	ATOMIC_RESULT_TOOL_NAME,
	atomicTurnExtension,
	createAtomicAdapter,
	hostLeak,
	resolveModel,
	turnSystemPrompt,
} from "./adapter";

import type { ExtensionAPI } from "@bastani/atomic";
import type { AtomicAuthMode, TurnPolicy } from "./adapter";

type Handler = (event: Record<string, unknown>) => unknown;

function fakeExtensionApi(policy: TurnPolicy) {
	let tools: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
	let handlers = new Map<string, Handler>();
	let active: string[] = [];
	let api = {
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			tools.push(tool);
		},
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		setActiveTools(names: string[]) {
			active = [...names];
		},
	};
	atomicTurnExtension(policy)(api as unknown as ExtensionAPI);
	return {
		tools,
		get active() {
			return active;
		},
		start: (systemPrompt?: string) =>
			handlers.get("before_agent_start")!({ type: "before_agent_start", systemPrompt }),
		call: (toolName: string) => handlers.get("tool_call")!({ type: "tool_call", toolName }),
	};
}

test("registers one result tool that terminates the turn and records its arguments", async () => {
	let policy: TurnPolicy = { hostNames: [], structured: true, systemPrompt: "System." };
	let atomic = fakeExtensionApi(policy);
	expect(atomic.tools.map(tool => tool.name)).toEqual([ATOMIC_RESULT_TOOL_NAME]);
	let result = await atomic.tools[0]!.execute("call-1", { answer: "yes" });
	expect(result).toMatchObject({ details: { answer: "yes" }, terminate: true });
	expect(policy.result).toEqual({ value: { answer: "yes" } });
});

test("applies a worker turn's tools and exact system prompt when the agent starts", () => {
	let policy: TurnPolicy = { hostNames: ["first_host"], structured: true, systemPrompt: "Plan." };
	let atomic = fakeExtensionApi(policy);
	expect(atomic.start()).toEqual({ systemPrompt: "Plan." });
	expect(atomic.active).toEqual(["first_host", ATOMIC_RESULT_TOOL_NAME]);

	policy.structured = false;
	policy.systemPrompt = `Plan.\n\nuser: ${ATOMIC_RESULT_INSTRUCTION}`;
	expect(atomic.start()).toEqual({ systemPrompt: policy.systemPrompt });
	expect(atomic.active).toEqual(["first_host"]);
});

test("blocks, for a worker, the result tool off structured turns and anything outside the turn", () => {
	let policy: TurnPolicy = { hostNames: ["first_host"], structured: false, systemPrompt: "S." };
	let atomic = fakeExtensionApi(policy);
	expect(atomic.call(ATOMIC_RESULT_TOOL_NAME)).toMatchObject({ block: true });
	expect(atomic.call("bash")).toMatchObject({ block: true });
	expect(atomic.call("first_host")).toBeUndefined();
	policy.structured = true;
	expect(atomic.call(ATOMIC_RESULT_TOOL_NAME)).toBeUndefined();
});

test("a Planner turn keeps Atomic's tools and prompt but still refuses the result tool on plain turns", () => {
	let policy: TurnPolicy = {
		full: true,
		hostNames: ["first_host"],
		structured: false,
		systemPrompt: "Plan.",
	};
	let atomic = fakeExtensionApi(policy);
	expect(atomic.start("Atomic.")).toEqual({ systemPrompt: "Atomic.\n\nPlan." });
	expect(atomic.active).toEqual([]);
	expect(atomic.call("bash")).toBeUndefined();
	expect(atomic.call("first_host")).toBeUndefined();
	expect(atomic.call(ATOMIC_RESULT_TOOL_NAME)).toMatchObject({ block: true });
	policy.structured = true;
	expect(atomic.call(ATOMIC_RESULT_TOOL_NAME)).toBeUndefined();
});

test("builds the system prompt from instructions and the structured response format", () => {
	expect(turnSystemPrompt(undefined, undefined)).toBe(ATOMIC_DEFAULT_SYSTEM_PROMPT);
	expect(turnSystemPrompt("", { type: "text" })).toBe(ATOMIC_DEFAULT_SYSTEM_PROMPT);
	expect(turnSystemPrompt("Summarize.", undefined)).toBe("Summarize.");
	let schema = { type: "object", properties: { answer: { type: "string" } } };
	let prompt = turnSystemPrompt("Summarize.", {
		type: "json",
		schema,
		description: "One answer.",
	});
	expect(prompt).toStartWith("Summarize.\n\n");
	expect(prompt).toContain(ATOMIC_RESULT_INSTRUCTION);
	expect(prompt).toContain("One answer.");
	expect(prompt).toContain(JSON.stringify(schema));
	expect(turnSystemPrompt(undefined, { type: "json" })).toStartWith(ATOMIC_RESULT_INSTRUCTION);
});

test("resolves provider/model exactly and never substitutes a default", () => {
	let known = new Map([
		["stub/stub-model", { provider: "stub", id: "stub-model" }],
		["anthropic/claude", { provider: "anthropic", id: "claude" }],
		["vercel-ai-gateway/anthropic/claude", {
			provider: "vercel-ai-gateway",
			id: "anthropic/claude",
		}],
	]);
	let runtime = {
		getModel: (provider: string, id: string) => known.get(`${provider}/${id}`) as never,
	};
	let auto = { auth: "auto" as AtomicAuthMode };
	let gateway = { auth: "ai-gateway" as AtomicAuthMode, providers: { stub: {} as never } };

	expect(resolveModel(runtime, auto, "anthropic/claude")).toMatchObject({ id: "claude" });
	expect(resolveModel(runtime, gateway, "vercel-ai-gateway/anthropic/claude"))
		.toMatchObject({ id: "anthropic/claude" });
	expect(resolveModel(runtime, gateway, "stub/stub-model")).toMatchObject({ id: "stub-model" });
	expect(() => resolveModel(runtime, auto, undefined)).toThrow("needs a model");
	for (let name of ["gpt-6-luna", "/claude", "stub/other", "anthropic/"]) {
		expect(() => resolveModel(runtime, auto, name))
			.toThrow(`Atomic does not recognize model ${name}`);
	}
	expect(() => resolveModel(runtime, gateway, "anthropic/claude"))
		.toThrow("HARNESS_AUTH ai-gateway allows only vercel-ai-gateway models, not anthropic/claude");
});

test("reports every way a built worker session exceeds the turn", () => {
	function session(options: {
		tools?: string[];
		agentsFiles?: number;
		skills?: number;
		prompts?: number;
		append?: string[];
		systemPrompt?: string;
	}) {
		return {
			getAllTools: () =>
				(options.tools ?? ["first_host", ATOMIC_RESULT_TOOL_NAME]).map(name => ({ name })),
			resourceLoader: {
				getAgentsFiles: () => ({ agentsFiles: Array(options.agentsFiles ?? 0) }),
				getSkills: () => ({ skills: Array(options.skills ?? 0) }),
				getPrompts: () => ({ prompts: Array(options.prompts ?? 0) }),
				getAppendSystemPrompt: () => options.append ?? [],
				getSystemPrompt: () => options.systemPrompt ?? ATOMIC_DEFAULT_SYSTEM_PROMPT,
			},
		} as never;
	}
	expect(hostLeak(session({}), 1, ["first_host"])).toBeUndefined();
	expect(hostLeak(session({}), 6, ["first_host"])).toBe("6 extensions");
	expect(hostLeak(session({ tools: ["first_host", ATOMIC_RESULT_TOOL_NAME, "bash"] }), 1, [
		"first_host",
	])).toBe(`tools first_host, ${ATOMIC_RESULT_TOOL_NAME}, bash`);
	expect(hostLeak(
		session({ agentsFiles: 1, skills: 2, prompts: 1, append: ["x"], systemPrompt: "Host" }),
		1,
		["first_host"],
	)).toBe(
		"context files; skills; prompt templates; appended system prompts; a host system prompt",
	);
});

test("declares no built-ins and refuses an undefined auth mode", () => {
	let harness = createAtomicAdapter({ auth: "ai-gateway" });
	expect(harness.harnessId).toBe("atomic");
	expect(harness.builtinTools).toEqual({});
	expect(harness.supportsBuiltinToolFiltering).toBe(true);
	expect(() => createAtomicAdapter({ auth: "direct" as AtomicAuthMode }))
		.toThrow("HARNESS_AUTH direct is not a supported atomic authentication mode");
	expect(() => createAtomicAdapter({ auth: undefined as unknown as AtomicAuthMode }))
		.toThrow("is not a supported atomic authentication mode");
});
