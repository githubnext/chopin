import { expect, test } from "bun:test";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import { openPlan } from "../testing/plan";
import { proseInput, prosePrompt } from "./prose-job";
import { CARD, OPTION, QUESTION } from "./prose-job.test-fixtures";

test("repeated saved choice after a failed prose job never reuses the prior rationale", async () => {
	let prior = "Sentry grouped exceptions and preserved stack traces.";
	let context = await openPlan(`${prior}\n\nFollow-up.\n`);
	try {
		let { plan } = context;
		let newOption = "01K0N4W3B7P27CBAEC7A8C8WEB";
		plan.records.set(
			CARD,
			Questions.normalizeRecord({
				id: CARD,
				definition: {
					questions: [{
						id: QUESTION,
						header: "Monitoring",
						question: "Which monitoring approach?",
						multiple: false,
						options: [
							{ id: OPTION, label: "Sentry", description: "" },
							{ id: newOption, label: "OpenTelemetry with Grafana", description: "" },
						],
					}],
				},
				status: "answered",
				origin: "conversation",
				threadId: "thread-a",
				owner: "mina",
				decidedAt: 1_758_645_000,
				choices: [newOption],
				history: [{ choices: [OPTION], owner: "mina", at: 1_758_644_000 }],
				prose: [room.anchorAt(plan.document, 0, room.digests(plan.document)[0]!)],
			}),
		);
		plan.conversationPlan.threads = [{
			id: "thread-a",
			questionnaireId: CARD,
			question: "Which monitoring approach?",
			questionAuthoring: "quoted",
			status: "decided",
			questionSources: [],
			contributions: [
				{
					kind: "reason",
					text: "Exception grouping and stack traces",
					targetId: OPTION,
					sources: [],
				},
				{ kind: "reason", text: "Grafana is already available", targetId: newOption, sources: [] },
				{
					kind: "reason",
					text: "Keep operational ownership clear",
					targetId: "thread-a",
					sources: [],
				},
			],
			stances: [],
			stanceHistory: [],
			decisionHistory: [],
			candidates: [],
			version: 1,
		}] as never;
		let input = proseInput(plan, CARD);
		expect(input.chosen).toEqual(["OpenTelemetry with Grafana"]);
		expect(input.reasons).toEqual([
			"Grafana is already available",
			"Keep operational ownership clear",
		]);
		let prompt = prosePrompt(input);
		expect(prompt).toContain("Grafana is already available");
		expect(prompt).toContain("Keep operational ownership clear");
		expect(prompt).not.toContain("Exception grouping");
		expect(prompt).not.toContain("stack traces");
		// B's prose job can fail, leaving A's anchored paragraph through a second B save.
		let saved = plan.records.get(CARD)!;
		plan.records.set(CARD, {
			...saved,
			history: [...saved.history, { choices: [newOption], owner: "mina", at: 1_758_645_000 }],
		});
		let repeated = prosePrompt(proseInput(plan, CARD));
		expect(repeated).not.toContain(prior);
	} finally {
		await Service.close(context.plan);
	}
});

test("same choice IDs and changed legacy text answers never use old prose as evidence", async () => {
	let context = await openPlan("Existing rationale.\n");
	try {
		let { plan } = context;
		let second = "01K0N4W3B7P27CBAEC7A8C8WEB";
		let base = {
			id: CARD,
			definition: {
				questions: [{
					id: QUESTION,
					header: "Monitoring",
					question: "Which monitoring approach?",
					multiple: true,
					options: [
						{ id: OPTION, label: "Sentry", description: "" },
						{ id: second, label: "Grafana", description: "" },
					],
				}],
			},
			status: "answered",
			origin: "conversation",
			threadId: "thread-a",
			owner: "mina",
			decidedAt: 1_758_645_000,
			prose: [room.anchorAt(plan.document, 0, room.digests(plan.document)[0]!)],
		};
		plan.records.set(
			CARD,
			Questions.normalizeRecord({
				...base,
				choices: [OPTION, second],
				history: [{ choices: [second, OPTION], owner: "mina", at: 1_758_644_000 }],
			}),
		);
		let sameChoice = prosePrompt(proseInput(plan, CARD));
		expect(sameChoice).toContain("Sentry; Grafana");
		expect(sameChoice).not.toContain("Existing rationale.");
		plan.records.set(
			CARD,
			Questions.normalizeRecord({
				...base,
				choices: [],
				answers: { [QUESTION]: "OpenTelemetry" },
				history: [{
					choices: [],
					answers: { [QUESTION]: "Sentry" },
					owner: "mina",
					at: 1_758_644_000,
				}],
			}),
		);
		let changedText = prosePrompt(proseInput(plan, CARD));
		expect(changedText).toContain("Chosen: OpenTelemetry");
		expect(changedText).not.toContain("Existing rationale.");
	} finally {
		await Service.close(context.plan);
	}
});
