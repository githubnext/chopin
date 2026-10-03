import { afterEach, describe, expect, test } from "bun:test";
import { $createParagraphNode, $getRoot } from "lexical";

import * as room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import { normalizeRecord } from "./service";
import { proseOperation, validateProse } from "./write-prose";

const CARD = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";
const WIDGET = `<Questionnaire id="${CARD}" status="decided" thread="t1">
<Question id="${QUESTION}" header="Auth" prompt="Which authentication approach?" multiple="false">
<Option id="${OPTION}" label="GitHub Apps" />
<Answer value="GitHub Apps" choices="${OPTION}" />
</Question>
</Questionnaire>
`;

let opened: Service.Plan[] = [];
afterEach(async () => {
	for (let plan of opened) await Service.close(plan);
	opened = [];
});

async function decided(source = `Context.\n\n${WIDGET}`, fields: {
	status?: "answered" | "open";
	origin?: "conversation" | "planner";
	proseAt?: number;
	orphaned?: boolean;
} = {}) {
	let { plan } = await openPlan(source);
	opened.push(plan);
	let hashes = room.digests(plan.document);
	let prose = fields.proseAt !== undefined
		? [room.anchorAt(plan.document, fields.proseAt, hashes[fields.proseAt]!)]
		: fields.orphaned
		? [{ ...room.anchorAt(plan.document, 0, hashes[0]!), orphaned: true }]
		: undefined;
	plan.records.set(
		CARD,
		normalizeRecord({
			id: CARD,
			definition: {
				questions: [{
					id: QUESTION,
					header: "Auth",
					question: "Which authentication approach?",
					multiple: false,
					options: [{ id: OPTION, label: "GitHub Apps", description: "" }],
				}],
			},
			status: fields.status ?? "answered",
			origin: fields.origin ?? "conversation",
			threadId: "t1",
			owner: "mina",
			decidedAt: 1_758_645_000,
			choices: [OPTION],
			...(prose ? { prose } : {}),
		}),
	);
	return plan;
}

describe("validateProse", () => {
	test("accepts one ordinary paragraph with inline formatting", () => {
		expect(validateProse("  We chose **GitHub Apps** with `org` access.  ")).toEqual({
			ok: true,
			text: "We chose **GitHub Apps** with `org` access.",
		});
	});

	test("refuses empty, oversized, multiblock, and non-prose constructs", () => {
		for (
			let value of [
				"",
				"x".repeat(601),
				"One.\n\nTwo.",
				"# Heading",
				"- List",
				"<Callout>Hi</Callout>",
				"Text <Badge />",
				"![image](x)",
			]
		) {
			expect(validateProse(value).ok).toBe(false);
		}
	});
});

describe("proseOperation", () => {
	test("inserts before the first decision in canonical coordinates", async () => {
		let plan = await decided(WIDGET);
		expect(room.questionnaireIndex(plan.document, CARD)).toBe(0);
		expect(proseOperation(plan, CARD, "We chose GitHub Apps.")).toEqual({
			ok: true,
			mode: "insert",
			index: 0,
			steps: [
				[{ op: "insert", index: 0, source: "We chose GitHub Apps.\n" }],
				[{ op: "move", index: 0, to: 1 }],
			],
		});
	});

	test("ignores leading and inter-card caret paragraphs when addressing cards", async () => {
		let plan = await decided();
		plan.document.editor.update(() => {
			let children = $getRoot().getChildren();
			children[0]!.insertBefore($createParagraphNode());
			children.at(-1)!.insertBefore($createParagraphNode());
		}, { discrete: true });
		await room.settle();
		expect(room.digests(plan.document)).toHaveLength(2);
		expect(room.questionnaireIndex(plan.document, CARD)).toBe(1);
		expect(proseOperation(plan, CARD, "Decision prose.")).toEqual({
			ok: true,
			mode: "insert",
			index: 1,
			steps: [[{ op: "insert", index: 0, source: "Decision prose.\n" }]],
		});
	});

	test("replaces only the paragraph named by a live anchor beside identical text", async () => {
		let plan = await decided(`Same.\n\nSame.\n\n${WIDGET}`, { proseAt: 1 });
		expect(proseOperation(plan, CARD, "New prose.")).toEqual({
			ok: true,
			mode: "replace",
			index: 1,
			steps: [[{ op: "replace", index: 1, source: "New prose.\n" }]],
		});
	});

	test("inserts when prose is orphaned, but refuses an unresolved live anchor", async () => {
		let orphan = await decided(undefined, { orphaned: true });
		expect(proseOperation(orphan, CARD, "New prose.")).toMatchObject({
			ok: true,
			mode: "insert",
		});
		let live = await decided(`Old prose.\n\n${WIDGET}`, { proseAt: 0 });
		live.records.get(CARD)!.prose![0]!.epoch = "different-epoch";
		expect(proseOperation(live, CARD, "New prose.").ok).toBe(false);
	});

	test("refuses open and Planner-owned cards", async () => {
		let open = await decided(undefined, { status: "open" });
		let planner = await decided(undefined, { origin: "planner" });
		expect(proseOperation(open, CARD, "Text.").ok).toBe(false);
		expect(proseOperation(planner, CARD, "Text.").ok).toBe(false);
	});
});
