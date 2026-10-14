import { expect, test } from "bun:test";
import { askPlan } from "./arguments";
import { input } from "./refine-fields";
import { input as reviseInput } from "./revise-fields";
import { documentTools } from "./tools";
import { createDirectTools } from "./scoped-revise-tool";
import { createRefineTools } from "./scoped-refine-tool";

function question(question: string, description?: string) {
	return {
		revision: 0,
		questions: [{
			header: "Sessions",
			question,
			...(description === undefined ? {} : { description }),
			multiple: false,
			options: [{ label: "PostgreSQL", description: "" }],
			blocks: [],
		}],
	};
}

test("ask validates concise primary questions and keeps optional full-card context", () => {
	expect(askPlan(question("x".repeat(100), "y".repeat(300))).questions[0]?.description)
		.toHaveLength(300);
	expect(() => askPlan(question("x".repeat(101)))).toThrow("exceeds 100 characters");
	expect(() => askPlan(question("Title?", "y".repeat(301))))
		.toThrow("description exceeds 300 characters");
});

test("refine and direct revision accept 100 character titles and refuse 101", () => {
	for (let parse of [input, reviseInput]) {
		expect(parse({ revision: 0, id: "decision", title: "x".repeat(100) }).title).toHaveLength(100);
		expect(() => parse({ revision: 0, id: "decision", title: "x".repeat(101) }))
			.toThrow("title must be 1–100 characters");
	}
});

test("Planner tool schemas advertise the same authoring limits", () => {
	let ask = (documentTools.ask.inputSchema as {
		jsonSchema: {
			properties: {
				questions: {
					items: {
						properties: { question: { maxLength: number }; description: { maxLength: number } };
						required: string[];
					};
				};
			};
		};
	}).jsonSchema;
	expect(ask.properties.questions.items.properties.question.maxLength).toBe(100);
	expect(ask.properties.questions.items.properties.description.maxLength).toBe(300);
	expect(ask.properties.questions.items.required).not.toContain("description");
	for (
		let tool of [createDirectTools().revise_open_decision, createRefineTools().refine_decision]
	) {
		let schema =
			(tool.inputSchema as { jsonSchema: { properties: { title: { maxLength: number } } } })
				.jsonSchema;
		expect(schema.properties.title.maxLength).toBe(100);
	}
});
