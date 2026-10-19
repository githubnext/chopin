import { expect, test } from "bun:test";
import { checkPlannerReply, publishPlannerReplies } from "./reply-policy";

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

test("no text is published until the complete message has a safe verdict", async () => {
	let checking = Promise.withResolvers<void>();
	let checked = Promise.withResolvers<void>();
	let seen = "";
	let f = fixture([text("I updated ", "the document.")], async (request, options) => {
		seen = (request.state as { reply: string }).reply;
		checked.resolve();
		await checking.promise;
		return verdict(0)(request, options);
	});
	let running = f.run();
	await checked.promise;
	expect(f.published).toEqual([]);
	expect(seen).toBe("I updated the document.");
	checking.resolve();
	await running;
	expect(f.published).toEqual(text("I updated the document."));
});

test("tool activity passes through while a decision tool is waiting", async () => {
	let tool: Part = { type: "tool-input-start", id: "ask", toolName: "ask" };
	let f = fixture([[tool]]);
	await f.run();
	expect(f.published).toEqual([tool]);
	expect(f.prompts).toHaveLength(1);
});

test.each([0.11, 0.5, 1])(
	"repeated input requests or uncertainty (%s) get only one repair",
	async p => {
		let f = fixture([text("Tell me your preferred scope."), text("Which scope?")], verdict(p));
		await expect(f.run()).rejects.toThrow("could not move its questions into inline decisions");
		expect(f.published).toEqual([]);
		expect(f.prompts).toHaveLength(2);
		expect(f.prompts[1]).toContain("do not repeat completed operations");
	},
);

test.each([NaN, -1, 1.1])(
	"invalid classifier probability %s never publishes or retries",
	async p => {
		let f = fixture([text("Done.")], verdict(p));
		await expect(f.run()).rejects.toThrow("could not verify");
		expect(f.published).toEqual([]);
		expect(f.prompts).toHaveLength(1);
	},
);

test("missing or failed classifier cannot publish unchecked text", async () => {
	for (
		let decide of [undefined, async () => {
			throw new Error("private provider response");
		}]
	) {
		let f = fixture([text("What should happen next?")]);
		f.options.decide = decide;
		await expect(f.run()).rejects.toThrow("could not verify");
		expect(f.published).toEqual([]);
		expect(f.prompts).toHaveLength(1);
	}
});

test("a stop during verification discards the verdict and never repairs", async () => {
	let checking = Promise.withResolvers<void>();
	let resume = Promise.withResolvers<void>();
	let f = fixture([text("Done.")], async (request, options) => {
		checking.resolve();
		await resume.promise;
		return verdict(0)(request, options);
	});
	let running = f.run();
	await checking.promise;
	f.controller.abort();
	resume.resolve();
	await running;
	expect(f.published).toEqual([]);
	expect(f.prompts).toHaveLength(1);
});

test("oversized text is refused rather than checking a truncated prefix", async () => {
	for (let candidate of ["x".repeat(24_001), '"'.repeat(12_001)]) {
		let f = fixture([text(candidate)]);
		await expect(f.run()).rejects.toThrow("could not verify");
		expect(f.published).toEqual([]);
	}
});

test("an unterminated message is still checked before publication", async () => {
	let f = fixture([[{ type: "text-delta", id: "message", text: "Done." }]]);
	await f.run();
	expect(f.published).toEqual(text("Done."));
});

test("a stream error discards partial text without starting a repair", async () => {
	let failure: Part = { type: "error", error: new Error("Provider failed") };
	let f = fixture([[{ type: "text-delta", id: "message", text: "Which" }, failure]], verdict(1));
	await expect(f.run()).rejects.toThrow("Planner stream failed");
	expect(f.published).toEqual([]);
	expect(f.prompts).toHaveLength(1);
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

test("a stateless repair receives quoted focus, the withheld question and completed tool results", async () => {
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
	expect(f.published).toEqual([call, result, ...text("The child report remains provisional.")]);
});

test.each(["classifier", "oversize"])(
	"a %s failure aborts and drains its producer before reporting failure",
	async failure => {
		let aborted = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let settled = false;
		let f = fixture([], async () => {
			throw new Error("Classifier unavailable");
		});
		f.options.session.stream = async (_prompt: string, signal?: AbortSignal) => {
			signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
			return {
				fullStream: (async function*() {
					yield* text(failure === "oversize" ? "x".repeat(24_001) : "Done.");
					await aborted.promise;
					await release.promise;
					yield { type: "tool-input-start", id: "late", toolName: "edit_plan" };
					settled = true;
				})(),
			} as never;
		};
		let ended = false;
		let running = f.run().catch(error => {
			ended = true;
			return error;
		});
		await aborted.promise;
		expect(f.controller.signal.aborted).toBe(false);
		expect(ended).toBe(false);
		expect(settled).toBe(false);
		release.resolve();
		expect(await running).toBeInstanceOf(Error);
		expect((await running).message).toContain("could not verify");
		expect(settled).toBe(true);
		expect(f.published).toEqual([]);
	},
);
