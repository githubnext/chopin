import { applyEvent } from "./events";
import { replay } from "./domain";
import { expect, test } from "bun:test";
import { ordinaryFrame, ordinaryInput } from "./policy-candidate-ordinary.test-fixtures";
import { runQuestion } from "./policy-candidate-question";

test.each([0.6, 0.599])("question threshold %s preserves proposal vs review", probability => {
	let input = ordinaryInput("question");
	input.first.new_question = { type: "noul", noul: probability };
	let { context, entry, role } = ordinaryFrame(input);
	expect(role.role).toBe("question");
	let result = runQuestion(context, entry, role);
	expect(result).toBeDefined();
	if (probability === 0.6) {
		expect(result?.proposed).toMatchObject({ type: "thread.opened", question: input.message.text });
		expect(entry.outcome.targetId).toBe(result?.proposed?.threadId);
	} else {
		expect(result?.proposed).toBeUndefined();
		expect(entry.outcome.status).toBe("review");
	}
	expect(context.events).toHaveLength(0);
});
test("cached direct-question skips without recomputing from changed first answers", () => {
	let { context, entry, role } = ordinaryFrame(ordinaryInput("question"));
	context.directQuestion = true;
	context.first.new_question = { type: "noul", noul: 0 };
	expect(runQuestion(context, entry, role)).toBeUndefined();
	expect(entry.outcome.gate).toBe("no useful role");
});
test.each([{ first: 0.9, again: 0.7 }, { first: 0.899, again: 0.7 }, { first: 0.9, again: 0.699 }])(
	"discarded-question bounds $first/$again",
	({ first, again }) => {
		let input = ordinaryInput("question");
		input.candidates[0]!.answers.thread = {
			type: "choice",
			choice: "provider",
			confidence: 1,
			probabilities: { provider: 1 },
		};
		input.state = applyEvent(input.state, {
			id: "discard-provider",
			type: "thread.discarded",
			threadId: "provider",
			observedThreadVersion: input.state.threads[0]!.version,
			origin: "human",
			actor: { kind: "member", handle: "Mina" },
			at: 1000,
		});
		expect(replay(input.state.events)).toEqual(input.state);
		input.first.new_question = { type: "noul", noul: first };
		input.candidates[0]!.answers.raises_again = { type: "noul", noul: again };
		let { context, entry, role } = ordinaryFrame(input);
		let result = runQuestion(context, entry, role);
		if (first === 0.9 && again === 0.7) expect(result?.proposed?.type).toBe("thread.opened");
		else {
			expect(result).toBeUndefined();
			expect(entry.outcome.gate).toBe("discarded question not raised again");
		}
	},
);
test.each(["base", "source"])("question %s failure retains target assignment", failure => {
	let { context, entry, role } = ordinaryFrame(ordinaryInput("question"));
	if (failure === "base") {
		context.working.threads.find = () => {
			throw new Error("base read");
		};
	} else {Object.defineProperty(entry.candidate, "quote", {
			get() {
				throw new Error("source read");
			},
		});}
	expect(() => runQuestion(context, entry, role)).toThrow(failure + " read");
	expect(entry.outcome.targetId).toMatch(/^thread:/);
	expect(context.events).toHaveLength(0);
});

test("a cached direct question progresses when an option group already exists", () => {
	let { context, entry, role } = ordinaryFrame(ordinaryInput("question"));
	context.directQuestion = true;
	context.candidateRun!.optionGroup = "provider";
	expect(runQuestion(context, entry, role)?.proposed?.type).toBe("thread.opened");
	expect(context.events).toHaveLength(0);
});
