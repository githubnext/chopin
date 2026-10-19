import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { create, decision, markKey, normalize } from "../index";
import { markName } from "./criteria";
import { QuestionView } from "./question-view";

function definition(criteria?: Array<{ label: string }>) {
	return decision(normalize({
		questions: [{
			header: "Storage",
			question: "Where does progress live?",
			multiple: false,
			options: [{ label: "Account", description: "" }, { label: "Browser", description: "" }],
			...(criteria ? { criteria } : {}),
		}],
	}));
}

function view(
	value: ReturnType<typeof definition>,
	props: Partial<Parameters<typeof QuestionView>[0]> = {},
) {
	let drafts = create(value).view() as never;
	return renderToStaticMarkup(
		<QuestionView bare definition={value} drafts={drafts} status="open" {...props} />,
	);
}

describe("criteria in the question view", () => {
	it("names a cell by option, criterion and mark", () => {
		expect(markName("Account", "New device", "partly")).toBe("Account, New device: partly");
		expect(markName("Account", "New device", null)).toBe("Account, New device: not set");
	});

	it("shows no matrix and no way to start one when there are no criteria", () => {
		let html = view(definition(), {
			onAddCriterion: async () => ({ ok: true }),
			onMark: () => {},
		});
		expect(html).not.toContain("crit-");
		expect(html).not.toContain("Add a criterion");
	});

	it("draws a column per criterion with a button per cell and a plus to append", () => {
		let value = definition([{ label: "New device" }, { label: "Easy reset" }]);
		let [option] = value.questions[0]!.options;
		let drafts = create(value).view() as never as Record<string, { marks?: object }>;
		drafts.q0!.marks = { [markKey(option!.id, "c0")]: "partly" };
		let html = view(value, {
			drafts: drafts as never,
			onAddCriterion: async () => ({ ok: true }),
			onMark: () => {},
		});
		expect(html).toContain("New device");
		expect(html).toContain("Account, New device: partly");
		expect(html).toContain("Browser, Easy reset: not set");
		expect(html).toContain('aria-label="Add a criterion"');
	});

	it("shows marks without a switch or a plus when nothing can be changed", () => {
		let html = view(definition([{ label: "New device" }]));
		expect(html).toContain('role="img"');
		expect(html).toContain("Account, New device: not set");
		expect(html).not.toContain("<button aria-expanded");
		expect(html).not.toContain("Add a criterion");
	});

	it("keeps no plus at the five-criterion limit", () => {
		let value = definition(["a", "b", "c", "d", "e"].map(label => ({ label })));
		let html = view(value, { onAddCriterion: async () => ({ ok: true }), onMark: () => {} });
		expect(html).not.toContain("Add a criterion");
	});
});
