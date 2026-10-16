import { describe, expect, test } from "bun:test";
import { identified, normalize } from "./schema";

function input(question = "Where should we store sessions?", description?: string) {
	return {
		questions: [{
			header: "Sessions",
			question,
			multiple: false,
			options: [{ label: "PostgreSQL", description: "" }],
			...(description === undefined ? {} : { description }),
		}],
	};
}

describe("concise authored questions", () => {
	test("accepts the 100 character question and 140 character description boundaries", () => {
		let value = normalize(input("x".repeat(100), "y".repeat(140)));
		expect(value.questions[0]?.question).toHaveLength(100);
		expect(value.questions[0]?.description).toHaveLength(140);
	});

	test("rejects longer new questions and descriptions without truncation", () => {
		expect(() => normalize(input("x".repeat(101)))).toThrow("exceeds 100 characters");
		expect(() => normalize(input("Question?", "y".repeat(141))))
			.toThrow("description exceeds 140 characters");
	});

	test("leaves the optional description absent and trims authored context", () => {
		expect(normalize(input()).questions[0]).not.toHaveProperty("description");
		expect(normalize(input("Question?", "  Context.  ")).questions[0]?.description)
			.toBe("Context.");
	});

	test("restores legacy primary questions exactly, with the former 1000 character bound", () => {
		let definition = normalize(input());
		let legacy = { questions: [{ ...definition.questions[0]!, question: "x".repeat(1000) }] };
		expect(identified(legacy)).toBe(legacy);
		expect(legacy.questions[0]?.question).toHaveLength(1000);
		expect(() =>
			identified({ questions: [{ ...legacy.questions[0]!, question: "x".repeat(1001) }] })
		)
			.toThrow("exceeds 1000 characters");
	});

	test("validates optional stored descriptions and still rejects unknown fields", () => {
		let definition = normalize(input());
		expect(() =>
			identified({ questions: [{ ...definition.questions[0]!, description: "x".repeat(301) }] })
		)
			.toThrow("description exceeds 300 characters");
		expect(() => normalize({ questions: [{ ...input().questions[0]!, context: "Ignored?" }] }))
			.toThrow("invalid fields");
	});

	test("preserves raw host-dialog text beyond authored field bounds", () => {
		let question = "  " + "x".repeat(101);
		let description = "  " + "y".repeat(301);
		let value = normalize(input(question, description), { verbatim: true });
		expect(value.questions[0]?.question).toBe(question);
		expect(value.questions[0]?.description).toBe(description);
		expect(identified(value)).toBe(value);
	});
});
