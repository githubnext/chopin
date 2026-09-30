import { expect, test } from "bun:test";
import { $createTextNode, $getRoot, $isParagraphNode } from "lexical";

import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import { openPlan } from "../testing/plan";
import { proseInput } from "./prose-job";
import { CARD, OPTION, QUESTION } from "./prose-job.test-fixtures";

test("proseInput reads the exact edited prose anchor beside an old identical paragraph", async () => {
	let context = await openPlan("Same.\n\nSame.\n");
	try {
		let { plan } = context;
		plan.records.set(
			CARD,
			Questions.normalizeRecord({
				id: CARD,
				definition: {
					questions: [{
						id: QUESTION,
						header: "Authentication",
						question: "Which approach?",
						multiple: false,
						options: [{ id: OPTION, label: "Chosen option", description: "" }],
					}],
				},
				status: "answered",
				origin: "conversation",
				threadId: "thread-a",
				owner: "mina",
				decidedAt: 1_758_645_000,
				choices: [OPTION],
				answers: { [QUESTION]: "Chosen option" },
				prose: [room.anchorAt(plan.document, 1, room.digests(plan.document)[1]!)],
			}),
		);
		plan.conversationPlan.threads = [{
			id: "thread-a",
			questionnaireId: CARD,
			question: "Which approach?",
			questionAuthoring: "quoted",
			status: "decided",
			questionSources: [],
			contributions: [
				{ kind: "reason", text: "Chosen reason", targetId: OPTION, sources: [] },
				{ kind: "reason", text: "Unrelated reason", targetId: "other-option", sources: [] },
			],
			stances: [],
			stanceHistory: [],
			decisionHistory: [],
			candidates: [],
			version: 1,
		}] as never;
		plan.document.editor.update(() => {
			let paragraph = $getRoot().getChildren()[1];
			if (!$isParagraphNode(paragraph)) throw new Error("second paragraph is missing");
			paragraph.append($createTextNode(" Edited."));
		}, { discrete: true });
		await room.settle();
		expect(proseInput(plan, CARD)).toMatchObject({
			id: CARD,
			chosen: ["Chosen option"],
			reasons: ["Chosen reason"],
			existing: "Same. Edited.",
		});
	} finally {
		await Service.close(context.plan);
	}
});
