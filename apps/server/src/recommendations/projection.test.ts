import { expect, it } from "bun:test";

import { documentTools } from "../agent/tools";
import * as Service from "../plan/service";
import { planningReadiness } from "../tasks/plan-graphs";
import { openPlan } from "../testing/plan";

import type { RecommendationSnapshot } from "@chopin/protocol/recommendation";

it("read_plan includes only current advisory evidence without changing Build readiness", async () => {
	let fixture = await openPlan("# Decision discovery\n\nExplain open and resolved decisions.\n");
	let advice: RecommendationSnapshot = {
		state: "ready",
		key: `sha256:${"a".repeat(64)}`,
		planRevision: fixture.plan.revision,
		recommendation: {
			kind: "build",
			title: "Explain open decisions",
			scope: "Add a short status explanation to the Decisions view.",
			reasons: ["The existing statuses support this small copy change."],
			dependencies: [],
			optional: ["Broader onboarding can remain open."],
			evidenceIds: ["repository:1"],
			nextAction: "Discuss a short explanation of the existing decision statuses.",
		},
		evidence: [],
	};
	let read = async (recommendation: () => Promise<RecommendationSnapshot>) => {
		let result = await documentTools.read_plan.execute!({}, {
			toolCallId: "advice-read",
			messages: [],
			context: { room: { plan: fixture.plan, recommendation } },
		} as never);
		return JSON.parse(result as string);
	};
	try {
		let readiness = await planningReadiness(fixture.plan, fixture.plan.revision);
		let original = await read(async () => ({ state: "unavailable" }));
		let projected = await read(async () => advice);
		expect(projected.recommendation).toMatchObject({
			advisory: true,
			kind: "build",
			optional: ["Broader onboarding can remain open."],
		});
		expect(await planningReadiness(fixture.plan, fixture.plan.revision)).toEqual(readiness);
		expect(fixture.plan.graph).toBeUndefined();
		expect(fixture.plan.builds).toEqual([]);
		advice.planRevision++;
		expect(await read(async () => advice)).toEqual(original);
		expect(
			await read(async () => {
				throw new Error("advisory storage unavailable");
			}),
		).toEqual(original);
	} finally {
		await Service.close(fixture.plan);
	}
});
