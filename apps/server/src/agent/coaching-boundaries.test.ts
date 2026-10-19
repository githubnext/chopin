import { afterEach, expect, test } from "bun:test";
import * as Questions from "../questions/service";
import * as Room from "../plan/room";
import { documentTools } from "./tools";
import { address, coachingFixture, decoded } from "./coaching-boundaries.test-fixtures";

import type { View } from "./coaching-boundaries.test-fixtures";
import type { Answer } from "@chopin/question";

let opened: Array<Awaited<ReturnType<typeof coachingFixture>>> = [];
afterEach(async () => {
	for (let fixture of opened.splice(0)) await fixture.close();
});

let provisional =
	"# Decision discoverability\n\nHypothesis: people may miss how to open a decision.\n";
let choice = {
	header: "First experiment",
	question: "Which first experiment should we try?",
	options: [
		{
			label: "Improve creation affordance",
			description: "Make the existing action easier to find.",
		},
		{ label: "Explain decision status", description: "Clarify open and answered states." },
	],
	multiple: false,
};

test("a new draft leaves six mixed inline decisions open after its turn finishes", async () => {
	let subjects = ["Audience", "Scope", "Deployment", "Data", "Access", "Rollout"];
	let source = "# New plan\n\n"
		+ subjects.map(subject => `${subject} remains provisional.\n`).join("\n");
	let fixture = await coachingFixture([
		() => ({ tool: "read_plan", input: {} }),
		output => ({
			tool: "edit_plan",
			input: {
				revision: decoded<View>(output).revision,
				operations: [{ op: "insert_root", source }],
			},
		}),
		output => {
			let view = decoded<View>(output);
			return {
				tool: "open_decisions",
				input: {
					revision: view.revision,
					questions: subjects.map((subject, index) => ({
						...choice,
						key: `${subject.toLowerCase()}-decision`,
						header: subject,
						question: `What should we know about ${subject.toLowerCase()}?`,
						...(index % 2 === 0 ? { response: "text", options: [] } : {}),
						blocks: [address(view, `${subject} remains provisional.`)],
					})),
				},
			};
		},
		() => "The provisional document and six decisions are ready.",
	]);
	opened.push(fixture);
	await fixture.run();
	expect(fixture.host.plan.records.size).toBe(6);
	let cards = await fixture.host.cards(6);
	let saved = await fixture.saved();
	expect(fixture.texts).toEqual(["The provisional document and six decisions are ready."]);
	for (let [index, card] of cards.entries()) {
		expect(fixture.host.plan.records.get(card.id)?.status).toBe("open");
		expect(card.definition.questions[0]?.response).toBe(index % 2 === 0 ? "text" : undefined);
		expect(fixture.host.plan.records.get(card.id)?.followUp?.target).toHaveLength(1);
		let before = saved.source.indexOf(`${subjects[index]} remains provisional.`);
		let position = saved.source.indexOf(card.id);
		expect(position).toBeGreaterThan(before);
		if (index < subjects.length - 1) {
			expect(position).toBeLessThan(
				saved.source.indexOf(`${subjects[index + 1]} remains provisional.`),
			);
		}
	}
	fixture.controller.abort();
	expect([...fixture.host.plan.records.values()].every(record => record.status === "open")).toBe(
		true,
	);
	expect(fixture.calls.map(call => call.tool)).toEqual([
		"read_plan",
		"edit_plan",
		"open_decisions",
	]);
});

test("a shared answer drives a current revision edit and settled anchors before the turn ends", async () => {
	let expectedAnswers: Answer[] = [];
	let expectedRecordAnswers: Record<string, string> = {};
	let widget = "";
	let questionId = "";
	let linkedDigest = "";
	let fixture = await coachingFixture([
		() => ({ tool: "read_plan", input: {} }),
		output => ({
			tool: "edit_plan",
			input: {
				revision: decoded<View>(output).revision,
				operations: [{ op: "insert_root", source: provisional }],
			},
		}),
		output => {
			let view = decoded<View>(output);
			return {
				tool: "ask",
				input: {
					revision: view.revision,
					questions: [{ ...choice, blocks: [address(view, "Hypothesis:")] }],
				},
			};
		},
		output => {
			let answer = decoded<{
				outcomes: Array<{ status: string; answered_by: string; answers: Answer[] }>;
				current_plan: View & {
					questions: Array<{
						status: string;
						answered_by?: string;
						answers?: Record<string, string>;
					}>;
				};
			}>(output);
			expect(answer.outcomes).toEqual([{
				status: "answered",
				answered_by: "reader",
				answers: expectedAnswers,
			}]);
			expect(answer.current_plan.questions).toMatchObject([{
				id: widget,
				status: "answered",
				answered_by: "reader",
				answers: expectedRecordAnswers,
			}]);
			let chosen = answer.outcomes[0]!.answers[0]!.choices![0]!;
			let paragraph = address(answer.current_plan, "Hypothesis:");
			return {
				tool: "edit_plan",
				input: {
					revision: answer.current_plan.revision,
					operations: [{
						op: "replace",
						index: paragraph.index,
						source: `Team choice: ${chosen}. Next, test finding it with one new user.\n`,
					}],
				},
			};
		},
		output => {
			let edit = decoded<View & { anchors_pending: Array<{ widget: string; question: string }> }>(
				output,
			);
			expect(edit.anchors_pending).toHaveLength(1);
			let pending = edit.anchors_pending[0]!;
			expect(pending).toMatchObject({ widget, question: questionId });
			let linked = address(edit, "Team choice:");
			linkedDigest = linked.digest;
			return {
				tool: "anchor_plan",
				input: {
					revision: edit.revision,
					anchors: [{
						widget: pending.widget,
						question: pending.question,
						blocks: [linked],
					}],
				},
			};
		},
		async output => {
			expect(decoded<unknown>(output)).toEqual({ ok: true, anchors_pending: [] });
			expect(Questions.outstanding(fixture.host.plan)).toEqual([]);
			let saved = await fixture.saved();
			expect(saved.source).toContain("Team choice: Improve creation affordance.");
			let sidecar = saved.sidecar;
			if (
				!sidecar || typeof sidecar !== "object" || Array.isArray(sidecar)
				|| !Array.isArray(sidecar.questions)
			) throw new Error("Missing saved question records");
			let durable = sidecar.questions.map(Questions.normalizeRecord)
				.find(record => record.id === widget);
			expect(durable).toMatchObject({
				status: "answered",
				resolver: "reader",
				answers: expectedRecordAnswers,
			});
			expect(durable?.anchors?.questions[questionId])
				.toEqual(Questions.anchors(fixture.host.plan)[0]?.questions[questionId]);
			expect(durable?.anchors?.questions[questionId])
				.toMatchObject({ pending: false, anchors: [{ digest: linkedDigest }] });
			return "I updated the document. Next, test whether a new user can find the action.";
		},
	]);
	opened.push(fixture);
	let running = fixture.run();
	let [question] = await fixture.host.cards(1);
	widget = question!.id;
	questionId = question!.definition.questions[0]!.id;
	let selected = question!.definition.questions[0]!.options[0]!;
	expectedRecordAnswers = { [questionId]: selected.label };
	expectedAnswers = [{
		question: choice.question,
		choices: [selected.label],
		optionIds: [selected.id],
	}];
	await fixture.host.answer(question!.id, [0]);
	await running;
	expect(fixture.calls.map(call => call.tool))
		.toEqual(["read_plan", "edit_plan", "ask", "edit_plan", "anchor_plan"]);
	expect(fixture.host.plan.records.get(question!.id)).toMatchObject({
		status: "answered",
		resolver: "reader",
	});
	expect(Questions.anchors(fixture.host.plan)[0]?.questions[question!.definition.questions[0]!.id])
		.toMatchObject({ pending: false, anchors: [expect.any(Object)] });
});

test("a stale coaching edit is refused and a reread retry preserves a collaborator's prose", async () => {
	let before = "";
	let fixture = await coachingFixture([
		() => ({ tool: "read_plan", input: {} }),
		async output => {
			let view = decoded<View>(output);
			let edit = await documentTools.edit_plan.execute!({
				revision: view.revision,
				operations: [{
					op: "insert_root",
					source: "A collaborator says: keep the existing shortcut.\n",
				}],
			}, { context: { room: fixture.room }, toolCallId: "collaborator", messages: [] } as never);
			expect(decoded<{ ok: boolean }>(edit).ok).toBe(true);
			before = Room.project(fixture.host.plan.document);
			return {
				tool: "edit_plan",
				input: {
					revision: view.revision,
					operations: [{ op: "replace_root", source: provisional }],
				},
			};
		},
		output => {
			expect(decoded<unknown>(output)).toMatchObject({ ok: false, reason: "stale" });
			expect(Room.project(fixture.host.plan.document)).toBe(before);
			return { tool: "read_plan", input: {} };
		},
		output => {
			let current = decoded<View>(output);
			expect(current.source).toContain("keep the existing shortcut");
			return {
				tool: "edit_plan",
				input: {
					revision: current.revision,
					operations: [{
						op: "insert_root",
						source: "Recommendation: improve discoverability while retaining the shortcut.\n",
					}],
				},
			};
		},
		output => {
			expect(decoded<{ ok: boolean }>(output).ok).toBe(true);
			return "I preserved the shortcut and added a provisional recommendation.";
		},
	]);
	opened.push(fixture);
	await fixture.run();
	expect((await fixture.saved()).source).toContain("keep the existing shortcut");
	expect((await fixture.saved()).source).toContain("retaining the shortcut");
	expect(fixture.calls.map(call => call.tool)).toEqual([
		"read_plan",
		"edit_plan",
		"read_plan",
		"edit_plan",
	]);
});

test.each(["cancel", "stop"] as const)(
	"%s closes a pending ask without inventing a shared answer",
	async kind => {
		let fixture = await coachingFixture([
			() => ({ tool: "read_plan", input: {} }),
			output => ({
				tool: "ask",
				input: { revision: decoded<View>(output).revision, questions: [{ ...choice, blocks: [] }] },
			}),
			output => {
				expect(decoded<unknown>(output)).toEqual({
					outcomes: [{ status: "cancelled", cancelled_by: "reader" }],
				});
				return "The first experiment remains undecided.";
			},
		]);
		opened.push(fixture);
		let running = fixture.run();
		let [question] = await fixture.host.cards(1);
		if (kind === "stop") fixture.controller.abort();
		else {await Questions.cancel(
				fixture.host.plan,
				fixture.host.server,
				fixture.room.id,
				fixture.host.ws,
				{
					kind: "question:cancel",
					rid: "cancel-coaching",
					ts: 0,
					id: question!.id,
				},
			);}
		await running;
		await fixture.host.cards(0);
		expect(fixture.calls.map(call => call.tool)).toEqual(["read_plan", "ask"]);
		expect(fixture.host.plan.records.get(question!.id)).toMatchObject({ status: "cancelled" });
		expect(fixture.host.plan.records.get(question!.id)?.answers).toBeUndefined();
		expect((await fixture.saved()).source.trim()).toBe("");
	},
);

test("missing owner permission prevents a coaching session before any resources or tools run", async () => {
	let fixture = await coachingFixture([() => ({ tool: "edit_plan", input: {} })], false);
	opened.push(fixture);
	expect(fixture.opened).toMatchObject({ ok: false, error: { kind: "Unavailable" } });
	expect(fixture.allocations()).toEqual({ starts: 0, sandboxes: 0 });
	expect(fixture.calls).toEqual([]);
	expect(Room.project(fixture.host.plan.document).trim()).toBe("");
});

test("an ordinary coaching turn cannot execute a write tool outside its active set", async () => {
	let fixture = await coachingFixture([
		() => ({
			tool: "draft_heading",
			input: { revision: 0, title: "Unauthorized heading", goal: "Invent a plan." },
		}),
		() => "That tool is unavailable in this turn.",
	]);
	opened.push(fixture);
	await fixture.run();
	expect(fixture.names()).not.toContain("draft_heading");
	expect(fixture.results[0]).toMatchObject({
		tool: "draft_heading",
		output: { type: "execution-denied" },
	});
	expect(Room.project(fixture.host.plan.document).trim()).toBe("");
	expect(fixture.host.plan.revision).toBe(0);
});
