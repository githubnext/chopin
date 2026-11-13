import { expect, test } from "bun:test";
import { expectPlain } from "../testing/plain-words";
import { ToolBoundaryError } from "../harness/remote/link";
import { checkPlannerReply, PlannerReplyError, publishPlannerReplies } from "./reply-policy";

import type { Decide } from "../conversation-plan/decisions";
import type { TextStreamPart, ToolSet } from "ai";

type Part = TextStreamPart<ToolSet>;

function verdict(noul: number): Decide {
	return async () => ({
		model: "test/classifier",
		answers: { input: { type: "noul", noul } },
		usage: { input_tokens: 0, output_tokens: 0 },
		latencyMs: 0,
	});
}

let absent: Decide = async () => ({
	model: "test/classifier",
	answers: {},
	usage: { input_tokens: 0, output_tokens: 0 },
	latencyMs: 0,
});

function fixture(turns: Part[][], decide: Decide | undefined = verdict(0)) {
	let controller = new AbortController();
	let published: Part[] = [];
	let prompts: string[] = [];
	let options = {
		session: {
			async stream(prompt: string) {
				prompts.push(prompt);
				return {
					fullStream: (async function*() {
						yield* turns.shift() ?? [];
					})(),
				} as never;
			},
		},
		prompt: "Draft the document.",
		signal: controller.signal,
		decide: decide as Decide | undefined,
		capturedDecisions: undefined as (() => number) | undefined,
		keptDecisions: undefined as (() => number) | undefined,
		repair: undefined as boolean | undefined,
		quiet: undefined as ((quiet: boolean) => void) | undefined,
		publish: (part: Part) => published.push(part),
	};
	return { options, published, prompts, controller, run: () => publishPlannerReplies(options) };
}

function text(...chunks: string[]): Part[] {
	return [
		{ type: "text-start", id: "message" },
		...chunks.map(text => ({ type: "text-delta" as const, id: "message", text })),
		{ type: "text-end", id: "message" },
	];
}

/** A stream that yields `first`, then waits for `release` before it yields `rest`. */
function held(first: Part[], rest: Part[]) {
	let release = Promise.withResolvers<void>();
	return {
		release: () => release.resolve(),
		stream: async () =>
			({
				fullStream: (async function*() {
					yield* first;
					await release.promise;
					yield* rest;
				})(),
			}) as never,
	};
}

test("text reaches Chat as the model writes it, before the message or the turn ends", async () => {
	let f = fixture([]);
	let model = held(
		[{ type: "text-start", id: "message" }, {
			type: "text-delta",
			id: "message",
			text: "I updated ",
		}],
		[{ type: "text-delta", id: "message", text: "the document." }, {
			type: "text-end",
			id: "message",
		}],
	);
	f.options.session.stream = model.stream;
	let running = f.run();
	await Bun.sleep(0);
	expect(f.published).toEqual(text("I updated ").slice(0, 2));
	model.release();
	await running;
	expect(f.published).toEqual(text("I updated ", "the document."));
});

test("a finished message is checked while what follows it streams, and the check holds nothing back", async () => {
	let checking = Promise.withResolvers<void>();
	let checked = Promise.withResolvers<void>();
	let seen = "";
	let tool: Part = { type: "tool-input-start", id: "edit", toolName: "edit_plan" };
	let f = fixture([[...text("I updated ", "the document."), tool]], async (request, options) => {
		seen = (request.state as { reply: string }).reply;
		checked.resolve();
		await checking.promise;
		return verdict(0)(request, options);
	});
	let running = f.run();
	await checked.promise;
	await Bun.sleep(0);
	expect(seen).toBe("I updated the document.");
	expect(f.published).toEqual([...text("I updated ", "the document."), tool]);
	let ended = false;
	void running.then(() => ended = true);
	await Bun.sleep(0);
	expect(ended).toBe(false);
	checking.resolve();
	await running;
	expect(f.prompts).toHaveLength(1);
});

test("once the reply's words are all out, the turn is quiet while its check runs", async () => {
	let checking = Promise.withResolvers<void>();
	let checked = Promise.withResolvers<void>();
	let f = fixture([text("I updated the document.")], async (request, options) => {
		checked.resolve();
		await checking.promise;
		return verdict(0)(request, options);
	});
	let quiet: boolean[] = [];
	let published = 0;
	f.options.quiet = value => {
		quiet.push(value);
		published = f.published.length;
	};
	let running = f.run();
	await checked.promise;
	await Bun.sleep(0);
	// Quiet only after the last of the words, while the check still runs.
	expect(quiet).toEqual([true]);
	expect(published).toBe(text("I updated the document.").length);
	checking.resolve();
	await running;
	expect(quiet).toEqual([true]);
});

test("a repair step the check starts is work again, and its end is quiet", async () => {
	let f = fixture(
		[text("Which scope?"), text("I put the scope question beside the goal.")],
		async (request, options) => verdict(said(f).length === 1 ? 1 : 0)(request, options),
	);
	f.options.capturedDecisions = () => 1;
	let quiet: Array<[boolean, number]> = [];
	f.options.quiet = value => quiet.push([value, f.prompts.length]);
	await f.run();
	// Quiet after the first reply, work again before the repair's prompt, quiet after it.
	expect(quiet).toEqual([[true, 1], [false, 1], [true, 2]]);
});

test("tool activity passes through while a decision tool is waiting", async () => {
	let tool: Part = { type: "tool-input-start", id: "ask", toolName: "ask" };
	let f = fixture([[tool]]);
	await f.run();
	expect(f.published).toEqual([tool]);
	expect(f.prompts).toHaveLength(1);
});

test.each([0.11, 0.5, 1])(
	"a reply that asks for input (%s) stays shown and gets one repair step that moves its questions into decisions",
	async p => {
		let f = fixture([text("Tell me your preferred scope."), text("Which scope?")], verdict(p));
		expect(await rejection(f.run())).toContain(
			"could not move its questions into inline decisions",
		);
		expect(f.published).toEqual([
			...text("Tell me your preferred scope."),
			...text("Which scope?"),
		]);
		expect(f.prompts).toHaveLength(2);
		expect(f.prompts[1]).toContain("open_decisions");
		expect(f.prompts[1]).toContain("do not repeat completed operations");
		expect(f.prompts[1]).toContain("Tell me your preferred scope.");
	},
);

/** What a failed reply says in Chat, which a person reads. */
async function rejection(run: Promise<unknown>): Promise<string> {
	let message = await run.then(() => "", error => (error as Error).message);
	expectPlain(message, "a failed reply");
	return message;
}

function said(f: ReturnType<typeof fixture>): string[] {
	return f.published.filter(part => part.type === "text-delta").map(part => part.text);
}

test("decisions the repair saved get a factual server summary after both replies", async () => {
	let f = fixture([
		text("Four decisions remain open as cards for the team."),
		text("These are team design choices awaiting Save."),
	], verdict(0.19));
	f.options.capturedDecisions = () => 4;
	await f.run();
	expect(f.prompts).toHaveLength(2);
	expect(said(f)).toEqual([
		"Four decisions remain open as cards for the team.",
		"These are team design choices awaiting Save.",
		"Added 4 inline decisions to the document.",
	]);
	expectPlain(said(f).at(-1)!, "a summary Chat shows");
});

test("decisions the Planner repeated give a factual summary without claiming they were added", async () => {
	let f = fixture([text("The cards are open."), text("Please answer them.")], verdict(0.19));
	f.options.keptDecisions = () => 2;
	await f.run();
	expect(said(f).at(-1)).toBe("2 inline decisions are already in the document.");
	expectPlain(said(f).at(-1)!, "a summary Chat shows");
});

test("a repair that answers without asking ends the turn with its own words", async () => {
	let checked = 0;
	let f = fixture(
		[text("Which scope?"), text("I put the scope question beside the goal.")],
		async (request, options) => verdict(checked++ === 0 ? 1 : 0)(request, options),
	);
	f.options.capturedDecisions = () => 1;
	await f.run();
	expect(said(f)).toEqual(["Which scope?", "I put the scope question beside the goal."]);
});

test.each([0, -1, NaN, 1.5])(
	"a repeated-decision count of %s cannot mask a rejected turn, and the failure keeps the session",
	async count => {
		let f = fixture([text("Which scope?"), text("Tell me the scope.")], verdict(1));
		f.options.keptDecisions = () => count;
		let failure = await f.run().catch(error => error);
		expect(failure).toBeInstanceOf(PlannerReplyError);
		expect(failure.message).toContain("could not move its questions");
	},
);

test.each([0, -1, NaN, 1.5])("a capture count of %s cannot mask a rejected turn", async count => {
	let f = fixture([text("Which scope?"), text("Tell me the scope.")], verdict(1));
	f.options.capturedDecisions = () => count;
	expect(await rejection(f.run())).toContain("could not move its questions");
});

test("a check that fails leaves the streamed reply standing, says nothing to the person, and only logs", async () => {
	let warnings: unknown[][] = [];
	let warn = console.warn;
	console.warn = (...args: unknown[]) => warnings.push(args);
	try {
		for (
			let decide of [undefined, absent, verdict(NaN), verdict(-1), verdict(1.1), async () => {
				throw new Error("provider unavailable");
			}]
		) {
			let f = fixture([text("What should happen next?")]);
			f.options.decide = decide as Decide | undefined;
			await f.run();
			expect(f.published).toEqual(text("What should happen next?"));
			expect(f.prompts).toHaveLength(1);
		}
	} finally {
		console.warn = warn;
	}
	expect(warnings).toHaveLength(6);
	for (let [line] of warnings) expect(String(line)).toContain("was not checked");
});

test("a check that runs out of time leaves the reply standing", async () => {
	let warn = console.warn;
	console.warn = () => {};
	try {
		let f = fixture([text("Done.")], async (_request, options) => {
			throw new Error(`timed out after ${options?.timeoutMs} ms`);
		});
		await f.run();
		expect(f.published).toEqual(text("Done."));
	} finally {
		console.warn = warn;
	}
});

test("oversized text streams whole and is left unchecked rather than checking a truncated prefix", async () => {
	let warn = console.warn;
	console.warn = () => {};
	try {
		for (let candidate of ["x".repeat(24_001), '"'.repeat(12_001)]) {
			let checked = false;
			let f = fixture([text(candidate)], async (request, options) => {
				checked = true;
				return verdict(0)(request, options);
			});
			await f.run();
			expect(checked).toBe(false);
			expect(f.published).toEqual(text(candidate));
		}
	} finally {
		console.warn = warn;
	}
});

test("a stream failure after capture cannot become a success summary", async () => {
	let f = fixture([[{ type: "error", error: new Error("Provider failed") }]]);
	f.options.capturedDecisions = () => 4;
	expect(await rejection(f.run())).toContain("Provider failed");
	expect(f.published).toEqual([]);
});

test("a stop before the capture summary prevents its publication", async () => {
	let f = fixture([text("Which scope?"), text("Tell me the scope.")], verdict(1));
	f.options.capturedDecisions = () => {
		f.controller.abort();
		return 4;
	};
	await f.run();
	expect(said(f)).toEqual(["Which scope?", "Tell me the scope."]);
});

test("a stop during the check discards its verdict and never repairs", async () => {
	let checking = Promise.withResolvers<void>();
	let resume = Promise.withResolvers<void>();
	let f = fixture([text("Which scope?")], async (request, options) => {
		checking.resolve();
		await resume.promise;
		return verdict(1)(request, options);
	});
	let running = f.run();
	await checking.promise;
	f.controller.abort();
	resume.resolve();
	await running;
	expect(f.published).toEqual(text("Which scope?"));
	expect(f.prompts).toHaveLength(1);
});

test("an unterminated message streams and is still checked", async () => {
	let checked = "";
	let f = fixture(
		[[{ type: "text-delta", id: "message", text: "Which scope?" }]],
		async (request, options) => {
			checked = (request.state as { reply: string }).reply;
			return verdict(0)(request, options);
		},
	);
	await f.run();
	expect(f.published).toEqual([{ type: "text-delta", id: "message", text: "Which scope?" }]);
	expect(checked).toBe("Which scope?");
});

test("a stream error keeps what streamed, fails the turn with that error and starts no repair", async () => {
	let failure: Part = { type: "error", error: new Error("Provider failed") };
	let f = fixture([[{ type: "text-delta", id: "message", text: "Which" }, failure]], verdict(1));
	expect(await rejection(f.run())).toContain("Provider failed");
	expect(f.published).toEqual([{ type: "text-delta", id: "message", text: "Which" }]);
	expect(f.prompts).toHaveLength(1);
});

test("a reader's session without tools keeps a reply that asks, and only logs it", async () => {
	let warnings: unknown[][] = [];
	let warn = console.warn;
	console.warn = (...args: unknown[]) => warnings.push(args);
	try {
		let f = fixture([text("Which scope?")], verdict(1));
		f.options.repair = false;
		await f.run();
		expect(f.published).toEqual(text("Which scope?"));
		expect(f.prompts).toHaveLength(1);
	} finally {
		console.warn = warn;
	}
	expect(warnings).toHaveLength(1);
});

test("standalone admission rejects absent answers and only allows confident safe verdicts", async () => {
	let signal = new AbortController().signal;
	expect(await checkPlannerReply("Done.", verdict(0.1), signal)).toBe(true);
	expect(await checkPlannerReply("Confirm the scope.", verdict(0.11), signal)).toBe(false);
	await expect(checkPlannerReply("Done.", absent, signal)).rejects.toThrow("could not verify");
});

test("the repair tool transcript stays bounded and marks omitted details", async () => {
	let checked = 0;
	let calls: Part[] = Array.from({ length: 20 }, (_, index) => ({
		type: "tool-call",
		toolCallId: `read-${index}`,
		toolName: "read_file",
		input: { path: "x".repeat(5_000) },
	}));
	let f = fixture([
		[...calls, ...text("Which audience?")],
		text("The document remains provisional."),
	], async (request, options) => verdict(checked++ === 0 ? 1 : 0)(request, options));
	await f.run();
	let repair = f.prompts[1]!;
	let context = JSON.parse(repair.slice(repair.indexOf("\n\n") + 2));
	expect(context.tool_transcript.join("").length).toBeLessThanOrEqual(16_000);
	expect(context.tool_transcript_truncated).toBe(true);
});

test("a stateless repair receives quoted focus, the question that asked and completed tool results", async () => {
	let call: Part = {
		type: "tool-call",
		toolCallId: "edit-1",
		toolName: "edit_child",
		input: { child: "child-42", revision: 3, operations: [] },
	};
	let result: Part = {
		type: "tool-result",
		toolCallId: "edit-1",
		toolName: "edit_child",
		input: call.input,
		output: { ok: true, revision: 4 },
	};
	let checked = 0;
	let f = fixture([
		[call, result, ...text("Which audience should the report address?")],
		text("The child report remains provisional."),
	], async (request, options) => verdict(checked++ === 0 ? 1 : 0)(request, options));
	f.options.prompt =
		"Focused child id child-42: Audience research\n\nana: Draft an audience report.";
	await f.run();
	let repair = f.prompts[1]!;
	expect(repair).toContain(JSON.stringify(f.options.prompt));
	expect(repair).toContain("Which audience should the report address?");
	expect(repair).toContain("edit_child");
	expect(repair).toContain("edit-1");
	expect(repair).toContain('\\"revision\\":4');
	expect(repair).toContain("quoted context");
	expect(repair).toContain("read_plan");
	expect(repair).toContain("do not repeat completed operations");
	expect(f.published).toEqual([
		call,
		result,
		...text("Which audience should the report address?"),
		...text("The child report remains provisional."),
	]);
});

test("a stream error from the tool boundary ends the turn as that error, so it is told as a tool failure and not a failed reply", async () => {
	let boundary = new ToolBoundaryError("Chopin's tool boundary failure: bash");
	let f = fixture([[{ type: "text-delta", id: "message", text: "Which" }, {
		type: "error",
		error: boundary,
	}]], verdict(1));
	let failure = await f.run().then(() => undefined, error => error);
	expect(failure).toBe(boundary);
	expect(f.published).toEqual([{ type: "text-delta", id: "message", text: "Which" }]);
	expect(f.prompts).toHaveLength(1);
});
