import { describe, expect, test } from "bun:test";

import { identified, normalize } from "./schema";
import { MAX_PREVIEW } from "./limits";

const DIAGRAM = "```mermaid\nflowchart LR\n  A[write] --> B[(db)]\n```";
const IMAGE = `![Write-through: the cache is written too](/images/${"c".repeat(64)}.png)`;

function ask(options: unknown[]) {
	return { questions: [{ header: "Cache", question: "Which?", options, multiple: false }] };
}

/** A stored definition whose one option has these fields besides its id, label and description. */
function stored(option: Record<string, unknown>) {
	return {
		questions: [{
			id: "q",
			header: "H",
			question: "Q",
			multiple: false,
			options: [{ id: "o", label: "A", description: "", ...option }],
		}],
	};
}

describe("an option's own visual", () => {
	test("is kept beside its description, and an option without one has no field", () => {
		let [first, second] = normalize(ask([
			{ label: "Write-through", description: "Safe.", preview: `${DIAGRAM}\n\n${IMAGE}` },
			{ label: "Write-back", description: "Fast." },
		])).questions[0]!.options;
		expect(first).toMatchObject({ description: "Safe.", preview: `${DIAGRAM}\n\n${IMAGE}` });
		expect("preview" in second!).toBe(false);
	});

	test("an empty one is left out, and one past the bound is refused with the option named", () => {
		let [option] = normalize(ask([{ label: "A", description: "", preview: "  \n " }]))
			.questions[0]!.options;
		expect("preview" in option!).toBe(false);
		expect(() =>
			normalize(ask([{ label: "A", description: "", preview: "x".repeat(MAX_PREVIEW + 1) }]))
		).toThrow("Question 1 option 1 preview exceeds 16000 characters");
		expect(normalize(ask([{ label: "A", description: "", preview: "x".repeat(MAX_PREVIEW) }])))
			.toBeDefined();
	});

	test("must be text, and other unknown option fields are still refused", () => {
		expect(() => normalize(ask([{ label: "A", description: "", preview: 4 }])))
			.toThrow("preview must be text");
		expect(() => normalize(ask([{ label: "A", description: "", image: "x" }])))
			.toThrow("has invalid fields");
	});

	test("a host dialog keeps it verbatim, indentation included", () => {
		let preview = "  indented\n\n\n    more  ";
		let [option] = normalize(ask([{ label: "A", description: "", preview }]), { verbatim: true })
			.questions[0]!.options;
		expect(option!.preview).toBe(preview);
	});

	test("a stored definition may carry it, bounded, and still refuses any other field", () => {
		expect(identified(stored({ preview: DIAGRAM }))).toBeDefined();
		expect(identified(stored({}))).toBeDefined();
		expect(() => identified(stored({ preview: "x".repeat(MAX_PREVIEW + 1) })))
			.toThrow("option preview exceeds 16000 characters");
		expect(() => identified(stored({ preview: 3 }))).toThrow("must be text");
		expect(() => identified(stored({ image: "x" }))).toThrow("has invalid fields");
	});
});
