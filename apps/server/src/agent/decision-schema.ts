import { jsonSchema } from "ai";

let ask = {
	type: "object",
	properties: {
		revision: {
			type: "integer",
			minimum: 0,
			description: "The revision returned by the `read_plan` this ask relates to.",
		},
		questions: {
			type: "array",
			minItems: 1,
			maxItems: 10,
			items: {
				type: "object",
				properties: {
					header: { type: "string", minLength: 1, maxLength: 80 },
					question: {
						type: "string",
						minLength: 1,
						maxLength: 100,
						description: "A concise question that stands alone in compact summaries.",
					},
					description: {
						type: "string",
						maxLength: 140,
						description: "Optional supporting context shown only in the full decision card.",
					},
					response: { type: "string", enum: ["text"] },
					options: {
						type: "array",
						minItems: 0,
						maxItems: 20,
						items: {
							type: "object",
							properties: {
								label: { type: "string", minLength: 1, maxLength: 60 },
								description: { type: "string", maxLength: 160 },
							},
							required: ["label", "description"],
							additionalProperties: false,
						},
					},
					multiple: { type: "boolean" },
					blocks: {
						type: "array",
						items: {
							type: "object",
							properties: {
								index: { type: "integer", minimum: 0 },
								digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
							},
							required: ["index", "digest"],
							additionalProperties: false,
						},
					},
				},
				required: ["header", "question", "options", "multiple", "blocks"],
				additionalProperties: false,
			},
		},
	},
	required: ["revision", "questions"],
	additionalProperties: false,
} satisfies Parameters<typeof jsonSchema>[0];

let criteria = {
	type: "array",
	minItems: 1,
	maxItems: 5,
	description: "Optional columns the options are judged against, such as "
		+ '"No new storage" or "Easy reset". People mark each option yes, '
		+ "partly or no per criterion; you do not. Choice questions only.",
	items: {
		type: "object",
		properties: { label: { type: "string", minLength: 1, maxLength: 40 } },
		required: ["label"],
		additionalProperties: false,
	},
} as const;

// Only ask offers criteria; open_decisions captures a decision without a matrix.
export let ASK_PLAN_SCHEMA = jsonSchema({
	...ask,
	properties: {
		...ask.properties,
		questions: {
			...ask.properties.questions,
			items: {
				...ask.properties.questions.items,
				properties: { ...ask.properties.questions.items.properties, criteria },
			},
		},
	},
});

let question = ask.properties.questions.items;
export let OPEN_DECISIONS_SCHEMA = jsonSchema({
	...ask,
	properties: {
		...ask.properties,
		questions: {
			...ask.properties.questions,
			items: {
				...question,
				properties: {
					...question.properties,
					key: { type: "string", pattern: "^[A-Za-z0-9_-]{8,64}$" },
					blocks: { ...question.properties.blocks, minItems: 1 },
				},
				required: [...question.required, "key"],
			},
		},
	},
});
