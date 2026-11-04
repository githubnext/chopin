import { expect, test } from "bun:test";
import { documentTools } from "./tools";
import { askPlan, openDecision } from "./arguments";
import { openPlan } from "../testing/plan";
import * as Edit from "../plan/edit";
import * as Room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import { member } from "../questions/text-response.test-fixtures";
import type { DocumentRoom } from "./tools";

test("ask accepts a written decision without fabricated alternatives", () => {
	let question = {
		header: "Onboarding",
		question: "How should onboarding work?",
		response: "text" as const,
		multiple: false,
		options: [],
		blocks: [],
	};
	expect(askPlan({ revision: 0, questions: [question] }).questions[0]).toEqual(question);
	let { response: _response, ...choice } = question;
	expect(() => askPlan({ revision: 0, questions: [choice] })).toThrow(
		"requires at least one option",
	);
	expect(() =>
		openDecision({ revision: 0, key: "onboarding", question: "How?", answer: "Use a tour" })
	)
		.toThrow("unexpected field");
});

test("open_decision returns an open card promptly, preserves one identity on retry and refuses stale work", async () => {
	let fixture = await openPlan();
	let anchors = 0;
	let room: DocumentRoom = {
		id: fixture.plan.id,
		plan: fixture.plan,
		server: fixture.server,
		persist: () => Service.persist(fixture.plan),
		exclusive: action => Service.exclusive(fixture.plan, action),
		publish: async () => {},
		anchors: () => {
			anchors++;
		},
		changes: () => {},
	};
	let options = { toolCallId: "open-one", messages: [], context: { room } };
	let input = { revision: 0, key: "onboarding", question: "How should onboarding work?" };
	try {
		let first = await documentTools.open_decision.execute!(input, options as never);
		expect(JSON.parse(first as string)).toMatchObject({ id: expect.any(String), status: "open" });
		expect(fixture.plan.records.size).toBe(1);
		expect(anchors).toBe(1);
		let again = await documentTools.open_decision.execute!(input, options as never);
		expect(again).toEqual(first);
		let stale = await documentTools.open_decision.execute!(
			{ ...input, key: "new-decision" },
			options as never,
		);
		expect(stale).toContain("changed");
		expect(fixture.plan.records.size).toBe(1);
		let id = JSON.parse(first as string).id as string;
		let { ws } = member();
		await Questions.discard(fixture.plan, fixture.server, fixture.plan.id, ws, {
			kind: "question:discard",
			ts: 0,
			rid: "discard-one",
			id,
		});
		let settled = await documentTools.open_decision.execute!(input, options as never);
		expect(JSON.parse(settled as string)).toEqual({ id, status: "discarded" });
	} finally {
		await Service.close(fixture.plan);
	}
});

test("open_decisions rebases a stale revision for an authorized Planner and refuses one whose access lapsed", async () => {
	let fixture = await openPlan("# Draft\n\nProvisional onboarding.\n\nProvisional collaboration.");
	let access = false;
	let room: DocumentRoom = {
		id: fixture.plan.id,
		plan: fixture.plan,
		server: fixture.server,
		persist: () => Service.persist(fixture.plan),
		exclusive: action => Service.exclusive(fixture.plan, action),
		publish: async () => {},
		anchors: () => {},
		changes: () => {},
	};
	let owner = { signal: new AbortController().signal, revalidate: async () => access };
	let options = { toolCallId: "open-many", messages: [], context: { room, owner } };
	let input = {
		revision: 0,
		questions: [{
			key: "onboarding-1",
			header: "Onboarding",
			question: "How should onboarding work?",
			response: "text",
			options: [],
			multiple: false,
			blocks: [{ index: 1, digest: Room.digests(fixture.plan.document)[1]! }],
		}],
	};
	try {
		await documentTools.read_plan.execute!({}, options as never);
		let edited = Edit.apply(fixture.plan, 0, [{ op: "insert_root", source: "A late note." }]);
		if (!edited.ok || !edited.mutation) throw new Error("fixture edit failed");
		await Service.publish(fixture.plan, fixture.server, fixture.plan.id, edited.mutation);
		expect(fixture.plan.revision).toBeGreaterThan(input.revision);

		expect(await documentTools.open_decisions.execute!(input, options as never))
			.toContain("Planner access could not be confirmed");
		expect(fixture.plan.records.size).toBe(0);

		access = true;
		let first = JSON.parse(
			await documentTools.open_decisions.execute!(input, options as never) as string,
		);
		expect(first.decisions).toEqual([{
			key: "onboarding-1",
			id: expect.any(String),
			status: "open",
		}]);
		let again = JSON.parse(
			await documentTools.open_decisions.execute!(input, options as never) as string,
		);
		expect(again.decisions).toEqual(first.decisions);
		expect(fixture.plan.records.size).toBe(1);
	} finally {
		await Service.close(fixture.plan);
	}
});
