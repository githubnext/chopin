/**
 * A questionnaire's decisions, through a real room.
 *
 * `anchors.ts` covers the bookkeeping on its own. What needs a document is
 * everything either side of it: minting an anchor from a block the agent named,
 * carrying it forward when the plan moves, and — the reason this file exists —
 * restoring those relationships through the current hosted sidecar.
 */

import { afterEach, describe, expect, it } from "bun:test";

import * as Questions from "./questions/service";
import * as room from "./plan/room";
import * as Service from "./plan/service";
import { openPlan } from "./testing/plan";

import type { Plan } from "./plan/service";
import type { SeedState } from "./testing/plan";

const SOURCE = `# Title

The renderer caches tiles for 60 seconds.

The second paragraph.
`;

let opens: Plan[] = [];

afterEach(async () => {
	for (let plan of opens) await Service.close(plan);
	opens = [];
});

async function opened(state?: SeedState) {
	let { plan } = await openPlan(SOURCE, state);
	opens.push(plan);
	return plan;
}

/** An answered questionnaire, as the hosted sidecar holds one. */
function stored(anchors?: object) {
	return {
		revision: 1,
		questions: [{
			id: "w1",
			status: "answered",
			resolver: "ana",
			definition: {
				questions: [{
					id: "q1",
					header: "Cache",
					question: "How long do we cache?",
					multiple: false,
					options: [],
				}],
			},
			answers: { q1: "60 seconds" },
			...(anchors ? { anchors } : {}),
		}],
	};
}

describe("saying where a decision lives", () => {
	it("owes a review until the agent has said, and stops when it has", async () => {
		let plan = await opened(stored());

		expect(Questions.outstanding(plan)).toEqual([
			{ widget: "w1", question: "q1", reason: "missing" },
		]);

		let digest = room.digests(plan.document)[1]!;
		expect(Questions.relate(plan, "w1", "q1", [{ index: 1, digest }])).toBeUndefined();

		expect(Questions.outstanding(plan)).toEqual([]);
		expect(Questions.anchors(plan)[0]?.questions.q1?.anchors).toHaveLength(1);
	});

	/** An empty list is a real answer: reviewed, deliberately related to nothing. */
	it("accepts that a decision produced nothing worth pointing at", async () => {
		let plan = await opened(stored());

		expect(Questions.relate(plan, "w1", "q1", [])).toBeUndefined();
		expect(Questions.outstanding(plan)).toEqual([]);
	});

	it("refuses to anchor against a block that has changed", async () => {
		let plan = await opened(stored());

		expect(Questions.relate(plan, "w1", "q1", [{ index: 1, digest: "sha256:stale" }]))
			.toContain("has changed");
	});

	it("refuses a questionnaire the room does not have", async () => {
		let plan = await opened(stored());

		expect(Questions.relate(plan, "nope", "q1", [])).toContain("no questionnaire");
	});

	it("owes the review again once the plan has moved beneath it", async () => {
		let plan = await opened(stored());
		let digest = room.digests(plan.document)[1]!;
		Questions.relate(plan, "w1", "q1", [{ index: 1, digest }]);

		Questions.invalidate(plan, "plan_changed");

		expect(Questions.outstanding(plan)).toEqual([
			{ widget: "w1", question: "q1", reason: "plan_changed" },
		]);
	});
});
