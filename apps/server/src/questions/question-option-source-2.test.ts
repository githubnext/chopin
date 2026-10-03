import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import * as Questions from "./service";
import * as Service from "../plan/service";

import { openPlan } from "../testing/plan";
import { createSourceFixture } from "./question-option-source.test-fixtures";
let plans: Service.Plan[];
let fixture = createSourceFixture(() => plans, value => {
	plans = value;
});
plans = fixture.plans;
let { OPTION_A, conversationCard } = fixture;

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks and data; import/fixture wrappers only.
test("restore rejects a question source saved only on another card's thread", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let first = await conversationCard(context, "thread-a", "Should we use GitHub Apps?");
	let second = await conversationCard(context, "thread-b", "Which database?");
	expect(
		await Questions.addServerOption(context.plan, context.server, "test", first.id, {
			optionId: OPTION_A,
			label: "GitHub Apps",
			origin: "planner",
			source: first.questionSource,
		}),
	).toEqual({ ok: true, optionId: OPTION_A });
	await Service.close(context.plan);
	plans = [];

	let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	let sidecar = structuredClone(loaded.sidecar ?? loaded.snapshot!.sidecar) as Record<
		string,
		unknown
	>;
	let questions = sidecar.questions as Array<{
		id: string;
		optionOrigins: Record<string, { source?: ConversationPlan.SourceRef }>;
	}>;
	questions.find(record => record.id === first.id)!.optionOrigins[OPTION_A]!.source =
		second.questionSource;
	await context.storage.collaboration.commit({
		channelId: context.channel.id,
		lease: context.lease,
		expectedRevision: loaded.channel.revision,
		operationId: "foreign-question-option-source",
		epoch: loaded.snapshot!.epoch,
		sidecar: sidecar as never,
		events: [],
		now: context.now,
	});
	await expect(Service.open(context.channel.id, context.backend, context.server)).rejects.toThrow(
		"hosted channel has option question source outside its card thread",
	);
});
