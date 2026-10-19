import { afterEach, expect, test } from "bun:test";

import { ArgumentError, askPlan } from "./arguments";
import { documentTools } from "./tools";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Store from "../questions/store";
import { openPlan } from "../testing/plan";

import type { Plan } from "../plan/service";

let plans: Plan[] = [];
afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
});

const DIGEST = `sha256:${"a".repeat(64)}`;

function ask(overrides: Record<string, unknown> = {}) {
	return {
		revision: 1,
		questions: [{
			header: "Auth",
			question: "How do we sign in?",
			multiple: false,
			options: [{ label: "Passkeys", description: "" }, { label: "Passwords", description: "" }],
			criteria: [{ label: "New device" }, { label: "Easy reset" }],
			blocks: [{ index: 0, digest: DIGEST }],
			...overrides,
		}],
	};
}

test("askPlan passes criteria through and leaves them absent when not given", () => {
	expect(askPlan(ask()).questions[0]!.criteria).toEqual([
		{ label: "New device" },
		{ label: "Easy reset" },
	]);
	let plain = ask();
	delete (plain.questions[0] as Record<string, unknown>).criteria;
	expect(askPlan(plain).questions[0]).not.toHaveProperty("criteria");
});

test("askPlan rejects malformed, duplicate, oversize and written-question criteria", () => {
	for (
		let criteria of [
			[],
			"New device",
			[{ label: "" }],
			[{ label: "x".repeat(41) }],
			[{ label: "A" }, { label: "a" }],
			[{ label: "A", id: "c1" }],
			Array.from({ length: 6 }, (_, index) => ({ label: `C${index}` })),
		]
	) expect(() => askPlan(ask({ criteria }))).toThrow();
	expect(() => askPlan(ask({ response: "text", options: [] }))).toThrow();
	expect(() => askPlan(ask({ marks: {} }))).toThrow(ArgumentError);
});

test("the ask tool advertises criteria but no marks, and records the criteria it was given", async () => {
	let schema = JSON.stringify(documentTools.ask.inputSchema);
	expect(schema).toContain('"criteria"');
	expect(schema).not.toContain("marks");

	let context = await openPlan("Related prose.\n");
	plans.push(context.plan);
	let { plan, server } = context;
	let created = Promise.withResolvers<void>();
	let args = ask({ blocks: [{ index: 0, digest: room.digests(plan.document)[0]! }] });
	args.revision = plan.revision;
	let response = documentTools.ask.execute!(args as never, {
		context: {
			room: {
				id: "test",
				plan,
				server,
				persist: () => Service.persist(plan),
				exclusive: (action: () => Promise<unknown>) => Service.exclusive(plan, action as never),
				publish: async () => {},
				anchors: () => created.resolve(),
				changes() {},
			},
			repository: { id: "R_test" },
		},
		toolCallId: "call",
		messages: [],
	} as never);
	await created.promise;
	let record = [...plan.records.values()][0]!;
	expect(record.definition.questions[0]!.criteria!.map(item => item.label)).toEqual([
		"New device",
		"Easy reset",
	]);
	expect(room.project(plan.document)).toContain('<Criterion id="');
	let claimed = Store.claimCancel(plan.questions, record.id, "test");
	if (!claimed.ok) throw new Error("could not resolve question");
	Store.commit(plan.questions, claimed.claim);
	await response;
});
