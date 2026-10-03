import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPromptScriptedHarness } from "../../../../e2e/harness/scripted-planner";
import type { HarnessV1StreamPart } from "@ai-sdk/harness";

type Call = Extract<HarnessV1StreamPart, { type: "tool-call" }>;
const HEADING = "[Background job: heading]\nDraft the title.";
const REFINE = '[Background job: refine]\nDecision card card-a: "Which approach?"';
const SCRIPT = [{ tool: "refine_decision", args: { revision: "$revision", id: "$target" } }];

async function contract(
	script: unknown = SCRIPT,
	observe: Parameters<typeof createPromptScriptedHarness>[1] = {},
) {
	let dir = await mkdtemp(join(tmpdir(), "prompt-scripted-contract-"));
	for (let kind of ["heading", "refine", "suggest", "prose"]) {
		await writeFile(join(dir, `${kind}.json`), JSON.stringify(script));
	}
	let driver = createPromptScriptedHarness(dir, observe);
	let session = await driver.fake.doStart({ sessionId: "prompt-contract" } as never);
	let parts: HarnessV1StreamPart[] = [];
	let queue: Call[] = [];
	let waiting: Array<(call: Call) => void> = [];
	return {
		dir,
		driver,
		session,
		parts,
		run(prompt: unknown, signal?: AbortSignal) {
			return session.doPromptTurn({
				prompt,
				tools: [],
				abortSignal: signal,
				emit(part: HarnessV1StreamPart) {
					parts.push(part);
					if (part.type !== "tool-call") return;
					let listener = waiting.shift();
					if (listener) listener(part);
					else queue.push(part);
				},
			} as never);
		},
		next() {
			let call = queue.shift();
			if (call) return Promise.resolve(call);
			let next = Promise.withResolvers<Call>();
			waiting.push(next.resolve);
			return next.promise;
		},
		async [Symbol.asyncDispose]() {
			await driver.fake.shutdown();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

test.each([
	"",
	"ordinary message",
	"\n" + HEADING,
	"[Background job: unknown]",
	HEADING + "\n[Background job: refine]",
	HEADING + '\nDecision card card-a: "Question?"',
	"[Background job: refine]",
	REFINE + '\nDecision card card-b: "Other?"',
	"[Background job: suggest]\nDecision card id: card-a",
	"[Background job: prose]\nDecision card id: " + "x".repeat(201),
	{ role: "user", content: [{ type: "image", image: "invalid" }] },
])("rejects invalid or ambiguous prompt context %# before any model tool call", async prompt => {
	await using h = await contract();
	let turn = await h.run(prompt);
	await turn.done;
	expect(h.driver.calls).toEqual([]);
	expect(h.parts.filter(part => part.type === "error")).toHaveLength(1);
	expect(h.parts.filter(part => part.type === "finish-step")).toHaveLength(1);
});

test.each([
	[HEADING, "document"],
	[REFINE, "card-a"],
	['[Background job: suggest]\nDecision card card-b: "Question?"', "card-b"],
	["[Background job: prose]\nDecision card id: card-c", "card-c"],
])(
	"reads returned revision and derives only the exact prompt target %#",
	async (prompt, target) => {
		await using h = await contract();
		let turn = await h.run({ role: "user", content: [{ type: "text", text: prompt }] });
		let read = await h.next();
		expect(read.toolName).toBe("read_plan");
		expect(JSON.parse(read.input)).toEqual({});
		await turn.submitToolResult({ toolCallId: read.toolCallId, output: '{"revision":7}' });
		let call = await h.next();
		expect(JSON.parse(call.input)).toEqual({ revision: 7, id: target });
		await turn.submitToolResult({ toolCallId: call.toolCallId, output: "{}" });
		await turn.done;
		expect(h.driver.calls.map(call => call.toolName)).toEqual(["read_plan", "refine_decision"]);
		expect(h.driver.results).toHaveLength(2);
		expect(h.driver.tools).toEqual([[]]);
		expect(h.parts.filter(part => part.type === "error")).toEqual([]);
	},
);

test.each([
	{ output: "bad JSON" },
	{ output: "null" },
	{ output: "[]" },
	{ output: "{}" },
	{ output: '{"revision":-1}' },
	{ output: '{"revision":1.5}' },
	{ output: '{"revision":"7"}' },
	{ output: '{"revision":9007199254740992}' },
	{ output: '{"revision":7}', isError: true },
	{ output: { revision: 7 } },
])("refuses invalid read_plan result %# before the dependent scripted call", async result => {
	await using h = await contract();
	let turn = await h.run(REFINE);
	let read = await h.next();
	await turn.submitToolResult({ toolCallId: read.toolCallId, ...result });
	await turn.done;
	expect(h.driver.calls.map(call => call.toolName)).toEqual(["read_plan"]);
	expect(h.parts.filter(part => part.type === "error")).toHaveLength(1);
});

test("sequential original calls each use a new returned revision without tool prefiltering", async () => {
	await using h = await contract([
		...SCRIPT,
		{ tool: "edit_plan", args: { revision: "$revision", nested: ["$target", "$revision"] } },
	]);
	let turn = await h.run(REFINE);
	for (let revision of [2, 9]) {
		let read = await h.next();
		expect(read.toolName).toBe("read_plan");
		await turn.submitToolResult({
			toolCallId: read.toolCallId,
			output: JSON.stringify({ revision }),
		});
		let call = await h.next();
		expect(JSON.parse(call.input).revision).toBe(revision);
		if (revision === 9) expect(JSON.parse(call.input).nested).toEqual(["card-a", 9]);
		await turn.submitToolResult({ toolCallId: call.toolCallId, output: "{}" });
	}
	await turn.done;
	expect(h.driver.calls.map(call => call.toolName)).toEqual([
		"read_plan",
		"refine_decision",
		"read_plan",
		"edit_plan",
	]);
	expect(h.driver.results).toHaveLength(4);
});

test("an empty original script finishes without an added read or dependent call", async () => {
	await using h = await contract([]);
	let turn = await h.run(HEADING);
	await turn.done;
	expect(h.driver.calls).toEqual([]);
	expect(h.driver.results).toEqual([]);
	expect(h.parts.filter(part => part.type === "finish-step")).toHaveLength(1);
});

test("local stop releases a held worker without aborting the caller", async () => {
	await using h = await contract();
	await writeFile(join(h.dir, "heading.hold"), "hold");
	let controller = new AbortController();
	let escape: ReturnType<typeof setTimeout> | undefined;
	try {
		let turn = await h.run(HEADING, controller.signal);
		await h.driver.entered;
		escape = setTimeout(() => controller.abort(), 500);
		await h.session.doStop();
		await turn.done;
		expect(controller.signal.aborted).toBe(false);
		expect(h.driver.calls).toEqual([]);
		expect(h.driver.results).toEqual([]);
	} finally {
		clearTimeout(escape);
		controller.abort();
	}
});

test("shutdown and done drain the admitted result observer before idempotent destruction", async () => {
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let finished = false;
	await using h = await contract(SCRIPT, {
		onResult: async () => {
			entered.resolve();
			await release.promise;
			finished = true;
		},
	});
	let turn = await h.run(REFINE);
	let read = await h.next();
	let submitted = turn.submitToolResult({ toolCallId: read.toolCallId, output: '{"revision":3}' });
	await entered.promise;
	let drained = false;
	let done = false;
	void turn.done.then(() => {
		done = true;
	});
	let shutdown = h.driver.fake.shutdown().then(() => {
		drained = true;
	});
	try {
		await Bun.sleep(10);
		expect(finished).toBe(false);
		expect(done).toBe(false);
		expect(drained).toBe(false);
		expect(h.driver.destroyed()).toBe(0);
	} finally {
		release.resolve();
		await submitted;
		await shutdown;
	}
	await turn.done;
	expect(finished).toBe(true);
	expect(done).toBe(true);
	expect(drained).toBe(true);
	expect(h.driver.destroyed()).toBe(1);
	expect(h.driver.calls.map(call => call.toolName)).toEqual(["read_plan"]);
	expect(h.parts.filter(part => part.type === "tool-result")).toEqual([]);
	await h.session.doDestroy();
	await h.driver.fake.shutdown();
	expect(h.driver.destroyed()).toBe(1);
	await expect(h.driver.fake.doStart({ sessionId: "late" } as never)).rejects.toThrow("shut down");
});

test("an admitted observer failure surfaces on the model stream and blocks dependent calls", async () => {
	await using h = await contract(SCRIPT, {
		onResult: () => {
			throw new Error("observer failed");
		},
	});
	let turn = await h.run(REFINE);
	let read = await h.next();
	await turn.submitToolResult({ toolCallId: read.toolCallId, output: '{"revision":3}' });
	await turn.done;
	let errors = h.parts.filter(part => part.type === "error");
	expect(errors).toHaveLength(1);
	expect(String(errors[0]!.error)).toContain("observer failed");
	expect(h.driver.calls.map(call => call.toolName)).toEqual(["read_plan"]);
});
