import { expect, test } from "bun:test";

import { PI_RESULT_TOOL_NAME, wrapSession } from "./adapter";

import type {
	HarnessV1PromptTurnOptions,
	HarnessV1Session,
	HarnessV1StreamPart,
} from "@ai-sdk/harness";

const RESPONSE_FORMAT = { type: "json" as const, schema: { type: "object" } };

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

test("refuses a host tool named with the reserved result-tool name", async () => {
	let session = wrapSession(fakeSession(() => {}));
	let turn = baseTurn({
		tools: [{ name: PI_RESULT_TOOL_NAME, description: "collision" }],
	});
	await expect(session.doPromptTurn(turn)).rejects.toThrow("is reserved for structured output");
});

test("rejects done when the turn ends without a result", async () => {
	let session = wrapSession(fakeSession(turn => {
		turn.emit({
			type: "finish",
			finishReason: { unified: "stop", raw: undefined },
			totalUsage: {} as never,
		});
	}));
	let control = await session.doPromptTurn(baseTurn());
	await expect(control.done).rejects.toThrow("ended without a structured result");
});

test("runs a host tool call alongside the suppressed result tool and derives the reply", async () => {
	let emitted: HarnessV1StreamPart[] = [];
	let session = wrapSession(fakeSession(turn => {
		expect(turn.tools.map(spec => spec.name)).toEqual(["first_host", PI_RESULT_TOOL_NAME]);
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
			result: "ok",
		});
		turn.emit({
			type: "finish-step",
			finishReason: { unified: "tool-calls", raw: undefined },
			usage: {} as never,
		});
		turn.emit({
			type: "finish",
			finishReason: { unified: "stop", raw: undefined },
			totalUsage: {} as never,
		});
	}));
	let turn = baseTurn({
		tools: [{ name: "first_host", description: "host tool" }],
		emit: part => emitted.push(part),
	});
	let control = await session.doPromptTurn(turn);
	await control.submitToolResult({ toolCallId: "call-1", output: "ok" });
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

test("never leaks the reserved tool name for a plain text turn", async () => {
	let emitted: HarnessV1StreamPart[] = [];
	let session = wrapSession(fakeSession(turn => {
		expect(turn.responseFormat).toBeUndefined();
		expect(turn.tools.map(spec => spec.name)).toEqual([PI_RESULT_TOOL_NAME]);
	}));
	let control = await session.doPromptTurn(baseTurn({ emit: part => emitted.push(part) }));
	await expect(control.done).rejects.toThrow("ended without a structured result");
	expect(emitted).toEqual([]);
});

test("passes a plain-text turn straight through with no wrapping", async () => {
	let received: HarnessV1PromptTurnOptions | undefined;
	let session = wrapSession(fakeSession(turn => {
		received = turn;
		turn.emit({ type: "text-start", id: "a" });
		turn.emit({ type: "text-delta", id: "a", delta: "hello" });
		turn.emit({ type: "text-end", id: "a" });
		turn.emit({
			type: "finish",
			finishReason: { unified: "stop", raw: undefined },
			totalUsage: {} as never,
		});
	}));
	let emitted: HarnessV1StreamPart[] = [];
	let turn = baseTurn({ responseFormat: undefined, emit: part => emitted.push(part) });
	await session.doPromptTurn(turn);
	expect(received).toBe(turn);
	expect(emitted.map(part => part.type)).toEqual([
		"text-start",
		"text-delta",
		"text-end",
		"finish",
	]);
});
