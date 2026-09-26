import { expect, test } from "bun:test";

import {
	PI_RESULT_INSTRUCTION,
	PI_RESULT_TOOL_NAME,
	piResultToolExtension,
	wrapSession,
} from "./adapter";

import type {
	HarnessV1PromptTurnOptions,
	HarnessV1Session,
	HarnessV1StreamPart,
} from "@ai-sdk/harness";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RESPONSE_FORMAT = {
	type: "json" as const,
	schema: { type: "object", properties: { answer: { type: "string" } } },
};

function fakeSession(
	script: (turn: HarnessV1PromptTurnOptions) => void,
): HarnessV1Session {
	return {
		sessionId: "fake",
		isResume: false,
		async doPromptTurn(turn) {
			script(turn);
			return {
				async submitToolResult() {},
				done: Promise.resolve(),
			};
		},
		async doContinueTurn(turn) {
			return this.doPromptTurn(turn as HarnessV1PromptTurnOptions);
		},
		async doCompact() {},
		async doDetach() {
			throw new Error("not used");
		},
		async doStop() {
			throw new Error("not used");
		},
		async doSuspendTurn() {
			throw new Error("not used");
		},
		async doDestroy() {},
	};
}

function baseTurn(overrides: Partial<HarnessV1PromptTurnOptions> = {}): HarnessV1PromptTurnOptions {
	return {
		prompt: "hi",
		skills: [],
		tools: [],
		responseFormat: RESPONSE_FORMAT,
		emit: () => {},
		...overrides,
	};
}

const FINISH: HarnessV1StreamPart = {
	type: "finish",
	finishReason: { unified: "stop", raw: undefined },
	totalUsage: {} as never,
};

test("refuses a host tool named with the reserved result-tool name", async () => {
	let session = wrapSession(fakeSession(() => {}));
	let turn = baseTurn({
		tools: [{ name: PI_RESULT_TOOL_NAME, description: "collision" }],
	});
	await expect(session.doPromptTurn(turn)).rejects.toThrow("is reserved for structured output");
});

test("rejects done when the turn ends without a result", async () => {
	let session = wrapSession(fakeSession(turn => turn.emit(FINISH)));
	let control = await session.doPromptTurn(baseTurn());
	await expect(control.done).rejects.toThrow("ended without a structured result");
});

test("asks for the result tool in the instructions without adding a host tool", async () => {
	let received: HarnessV1PromptTurnOptions | undefined;
	let session = wrapSession(fakeSession(turn => {
		received = turn;
	}));
	let control = await session.doPromptTurn(baseTurn({
		instructions: "Summarize the document.",
		tools: [{ name: "first_host", description: "host tool" }],
	}));
	await expect(control.done).rejects.toThrow("ended without a structured result");
	expect(received?.responseFormat).toBeUndefined();
	expect(received?.tools.map(spec => spec.name)).toEqual(["first_host"]);
	expect(received?.instructions).toStartWith("Summarize the document.\n\n");
	expect(received?.instructions).toContain(PI_RESULT_INSTRUCTION);
	expect(received?.instructions).toContain(JSON.stringify(RESPONSE_FORMAT.schema));
});

test("keeps the result tool out of the stream and derives the reply from its input", async () => {
	let emitted: HarnessV1StreamPart[] = [];
	let session = wrapSession(fakeSession(turn => {
		turn.emit({ type: "tool-call", toolCallId: "call-1", toolName: "first_host", input: "{}" });
		turn.emit({ type: "tool-result", toolCallId: "call-1", toolName: "first_host", result: "ok" });
		turn.emit({ type: "tool-input-start", id: "stream-1", toolName: PI_RESULT_TOOL_NAME });
		turn.emit({ type: "tool-input-delta", id: "stream-1", delta: '{"answer"' });
		turn.emit({ type: "tool-input-end", id: "stream-1" });
		turn.emit({
			type: "tool-call",
			toolCallId: "call-2",
			toolName: PI_RESULT_TOOL_NAME,
			input: '{"answer":"yes"}',
		});
		turn.emit({
			type: "tool-result",
			toolCallId: "call-2",
			toolName: PI_RESULT_TOOL_NAME,
			result: "Result received.",
		});
		turn.emit({
			type: "finish-step",
			finishReason: { unified: "tool-calls", raw: undefined },
			usage: {} as never,
		});
		turn.emit(FINISH);
	}));
	let control = await session.doPromptTurn(baseTurn({
		tools: [{ name: "first_host", description: "host tool" }],
		emit: part => emitted.push(part),
	}));
	await control.done;

	expect(emitted.filter(part => "toolName" in part && part.toolName === PI_RESULT_TOOL_NAME))
		.toEqual([]);
	expect(emitted.filter(part => "id" in part && part.id === "stream-1")).toEqual([]);
	expect(emitted.map(part => part.type)).toEqual([
		"tool-call",
		"tool-result",
		"text-start",
		"text-delta",
		"text-end",
		"finish-step",
		"finish",
	]);
	let delta = emitted.find(part => part.type === "text-delta");
	expect(delta && "delta" in delta ? JSON.parse(delta.delta) : undefined).toEqual({
		answer: "yes",
	});
});

test("rejects done when the structured result is not valid JSON", async () => {
	let session = wrapSession(fakeSession(turn => {
		turn.emit({ type: "tool-call", toolCallId: "c", toolName: PI_RESULT_TOOL_NAME, input: "{" });
		turn.emit(FINISH);
	}));
	let control = await session.doPromptTurn(baseTurn());
	await expect(control.done).rejects.toThrow("invalid structured result");
});

test("passes a plain-text turn through and drops only refused result-tool parts", async () => {
	let received: HarnessV1PromptTurnOptions | undefined;
	let session = wrapSession(fakeSession(turn => {
		received = turn;
		turn.emit({ type: "tool-call", toolCallId: "r", toolName: PI_RESULT_TOOL_NAME, input: "{}" });
		turn.emit({
			type: "tool-result",
			toolCallId: "r",
			toolName: PI_RESULT_TOOL_NAME,
			result: "blocked",
			isError: true,
		});
		turn.emit({ type: "text-start", id: "a" });
		turn.emit({ type: "text-delta", id: "a", delta: "hello" });
		turn.emit({ type: "text-end", id: "a" });
		turn.emit(FINISH);
	}));
	let emitted: HarnessV1StreamPart[] = [];
	let turn = baseTurn({
		instructions: "Answer the question.",
		responseFormat: undefined,
		emit: part => emitted.push(part),
	});
	let control = await session.doPromptTurn(turn);
	await control.done;
	expect(received?.instructions).toBe("Answer the question.");
	expect(received?.tools).toBe(turn.tools);
	expect(emitted.map(part => part.type)).toEqual([
		"text-start",
		"text-delta",
		"text-end",
		"finish",
	]);
});

type Handler = (event: Record<string, unknown>) => unknown;

function fakeExtensionApi() {
	let tools: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
	let handlers = new Map<string, Handler>();
	let active = ["first_host"];
	let api = {
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			tools.push(tool);
			active.push(tool.name);
		},
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) {
			active = [...names];
		},
	};
	piResultToolExtension(api as unknown as ExtensionAPI);
	return {
		tools,
		get active() {
			return active;
		},
		start: (systemPrompt: string) =>
			handlers.get("before_agent_start")!({ type: "before_agent_start", systemPrompt }),
		call: (toolName: string) => handlers.get("tool_call")!({ type: "tool_call", toolName }),
	};
}

test("registers one result tool that terminates the turn with its arguments", async () => {
	let pi = fakeExtensionApi();
	expect(pi.tools.map(tool => tool.name)).toEqual([PI_RESULT_TOOL_NAME]);
	let result = await pi.tools[0]!.execute("call-1", { answer: "yes" });
	expect(result).toMatchObject({ details: { answer: "yes" }, terminate: true });
});

test("offers the result tool only on turns that ask for a structured result", () => {
	let pi = fakeExtensionApi();
	pi.start(`System.\n\n${PI_RESULT_INSTRUCTION}`);
	expect(pi.active).toEqual(["first_host", PI_RESULT_TOOL_NAME]);
	expect(pi.call(PI_RESULT_TOOL_NAME)).toBeUndefined();

	pi.start("System.\n\nAnswer the question.");
	expect(pi.active).toEqual(["first_host"]);
	expect(pi.call(PI_RESULT_TOOL_NAME)).toMatchObject({ block: true });
	expect(pi.call("first_host")).toBeUndefined();
});

test("blocks the result tool before any turn has declared a structured result", () => {
	let pi = fakeExtensionApi();
	expect(pi.call(PI_RESULT_TOOL_NAME)).toMatchObject({ block: true });
});
