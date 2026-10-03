import { expect, test } from "bun:test";
import * as Plan from "../plan/service";
import * as Room from "../plan/room";
import * as Questions from "../questions/service";
import { openPlan } from "../testing/plan";
import { BACKGROUND_TOOL_NAMES } from "../harness/tool-names";
import { proseIntent } from "../conversation-plan/prose-job";
import { decisionGeneration, proseJobTrigger } from "../questions/card-actions";
import { CARD, OPTION, QUESTION } from "./job-card-memory.test-fixtures";
import { promptCard } from "./job-prompt-card.test-fixtures";

const PARAGRAPH = "We chose GitHub Apps for authentication in the pilot.";

async function answeredDocument() {
	let record = Questions.normalizeRecord({
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
		status: "answered",
		origin: "conversation",
		threadId: "t1",
		owner: "mina",
		decidedAt: 1_758_645_000,
		choices: [OPTION],
		history: [{ choices: [OPTION], owner: "ana", at: 1_758_644_000 }],
	});
	let widget = `<Questionnaire id="${CARD}" status="decided" thread="t1">
<Question id="${QUESTION}" header="Auth" prompt="Which authentication approach?" multiple="false">
<Option id="${OPTION}" label="GitHub Apps" />
<Answer value="GitHub Apps" choices="${OPTION}" />
</Question>
</Questionnaire>\n`;
	let opened = await openPlan(`Context.\n\n${widget}`, { questions: [record] });
	await Plan.close(opened.plan);
	opened.plan = await Plan.open(opened.channel.id, opened.backend, opened.server);
	return opened;
}

function anchoredParagraph(plan: Plan.Plan) {
	let record = plan.records.get(CARD)!;
	expect(record.prose).toHaveLength(1);
	let anchor = record.prose![0]!;
	expect(anchor.orphaned).not.toBe(true);
	let matches = Room.digests(plan.document).map((_, index) => index).filter(index =>
		Room.matchesAnchor(plan.document, anchor, index)
	);
	expect(matches).toHaveLength(1);
	expect(Room.blockText(plan.document, matches)).toBe(PARAGRAPH);
}

test("a prompt-only prose job rejects another card then writes its current saved generation durably", async () => {
	let opened = await answeredDocument();
	let h: Awaited<ReturnType<typeof promptCard>> | undefined;
	try {
		let baseline = structuredClone(opened.plan.records.get(CARD)!);
		let source = Plan.source(opened.plan);
		let revision = opened.plan.revision;
		expect(baseline.status).toBe("answered");
		expect(Room.hasQuestionnaire(opened.plan.document, CARD, QUESTION)).toBe(true);
		expect(decisionGeneration(baseline)).toBe(2);
		let intent = proseIntent(baseline)!;
		expect(intent).toEqual({
			kind: "prose",
			target: CARD,
			trigger: proseJobTrigger(CARD, decisionGeneration(baseline)),
		});
		if (intent.kind !== "prose") throw new Error("expected the actual saved prose intent");
		h = await promptCard(opened, {
			kind: intent.kind,
			target: intent.target,
			trigger: intent.trigger,
		}, [
			{
				tool: "write_decision_prose",
				args: { revision: "$revision", id: "not-this-card", text: PARAGRAPH },
			},
			{
				tool: "write_decision_prose",
				args: { revision: "$revision", id: "$target", text: PARAGRAPH },
			},
		]);
		expect(h.job.trigger).toBe(intent.trigger);
		expect(h.prompt).toStartWith("[Background job: prose]");
		expect(h.prompt).toContain(`Decision card id: ${CARD}`);
		expect(h.prompt).toContain("Chosen: GitHub Apps");
		expect(await h.run()).toEqual({
			status: "done",
			output: JSON.stringify({ title: "Which authentication approach?", mode: "insert" }),
		});
		expect(h.driver.tools).toEqual([[...BACKGROUND_TOOL_NAMES.prose]]);
		expect(h.driver.calls.map(call => call.toolName)).toEqual([
			"read_plan",
			"write_decision_prose",
			"read_plan",
			"write_decision_prose",
		]);
		let observations = await h.results();
		expect(observations.map(item => item.toolName)).toEqual([
			"read_plan",
			"write_decision_prose",
			"read_plan",
			"write_decision_prose",
		]);
		let [firstRead, rejected, renewedRead, accepted] = observations;
		expect(rejected!.output).toBe("Error: This job writes up a different decision.");
		expect(rejected!.saved.record).toEqual(baseline);
		expect(rejected!.saved.source).toBe(source);
		expect(rejected!.revision).toBe(revision);
		expect(rejected!.saved.revision).toBe(revision);
		let firstRevision = JSON.parse(String(firstRead!.output)).revision;
		let renewedRevision = JSON.parse(String(renewedRead!.output)).revision;
		expect(firstRevision).toBe(revision);
		expect(renewedRevision).toBe(revision);
		expect(JSON.parse(String(renewedRead!.output)).source).toBe(source);
		expect(h.driver.calls[1]!.input).toEqual({
			revision: firstRevision,
			id: "not-this-card",
			text: PARAGRAPH,
		});
		expect(h.driver.calls[3]!.input).toEqual({
			revision: renewedRevision,
			id: CARD,
			text: PARAGRAPH,
		});
		expect(String(accepted!.output)).toContain('"ok": true');
		let completed = structuredClone(opened.plan.records.get(CARD)!);
		expect(accepted!.saved.record).toEqual(completed);
		expect(accepted!.saved.source).toBe(Plan.source(opened.plan));
		expect(accepted!.saved.source.split(PARAGRAPH)).toHaveLength(2);
		expect(accepted!.saved.revision).toBe(opened.plan.revision);
		expect(accepted!.revision).toBeGreaterThan(revision);
		expect(completed.definition).toEqual(baseline.definition);
		expect(completed.choices).toEqual(baseline.choices);
		expect(proseIntent(completed)).toEqual(intent);
		anchoredParagraph(opened.plan);
		expect(h.identity.driver.starts()).toBe(0);
		expect(h.driver.starts()).toBe(1);
		expect(h.driver.destroyed()).toBe(1);
		expect(h.counts()).toEqual({
			setups: 1,
			unexpectedCommands: 0,
			sandboxDestroys: 1,
			credentialReleases: 1,
		});
		expect(opened.plan.chat.job).toBeUndefined();
		expect(opened.plan.chat.turn).toBeUndefined();
		expect(opened.plan.chat.entries.some(entry => entry.tools?.length || entry.streaming)).toBe(
			false,
		);
		expect(
			opened.broadcasts.some(frame => ["chat:tool", "chat:delta"].includes(String(frame.kind))),
		).toBe(false);
		let completedSource = Plan.source(opened.plan);
		await h.close();
		let reopened = await Plan.open(opened.channel.id, opened.backend, opened.server);
		try {
			expect(reopened.records.get(CARD)).toEqual(completed);
			expect(Plan.source(reopened)).toBe(completedSource);
			expect(reopened.chat.waiting).toEqual([]);
			expect(h.driver.starts()).toBe(1);
			anchoredParagraph(reopened);
		} finally {
			await Plan.close(reopened);
		}
	} finally {
		if (h) await h.close();
		else if (!opened.plan.chat.closed) await Plan.close(opened.plan);
	}
});
