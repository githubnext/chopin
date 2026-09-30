import { expect, test } from "bun:test";
import * as Service from "./service";
import { openPlan } from "../testing/plan";
import { draft, legacyRecord } from "./question-record.test-fixtures";
import { applyInference, initialState } from "../conversation-plan/domain";
import { applyEvent } from "../conversation-plan/events";

async function accepted() {
	let context = await openPlan("", { questions: [legacyRecord()], openQuestions: [draft()] });
	let message = {
		id: "m1",
		author: { kind: "member" as const, handle: "ana" },
		text: "Try 🧪 Cloud next",
		ts: 1,
	};
	let source = {
		messageId: message.id,
		author: message.author,
		quote: "🧪 Cloud",
		start: 4,
		end: 12,
		role: "option" as const,
	};
	let state = applyEvent(initialState(), {
		id: "open",
		type: "thread.opened",
		threadId: "t1",
		observedThreadVersion: 0,
		origin: "planner",
		actor: { kind: "agent" },
		at: 1,
		question: "Where should we host?",
	});
	state = applyInference(state, {
		id: "option",
		type: "option.added",
		threadId: "t1",
		observedThreadVersion: 1,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1,
		source,
		contribution: { id: "saved-a", text: "Cloud", authoring: "scribe" },
	}, message);
	let record = context.plan.records.get("saved-card")!;
	context.plan.records.set(record.id, {
		...record,
		threadId: "t1",
		optionOrigins: { "saved-a": { origin: "chat", source } },
	});
	context.plan.chat.entries.push(message);
	context.plan.conversationPlan = state;
	await Service.persist(context.plan);
	await Service.close(context.plan);
	return context;
}

test("saved chat option provenance is tied to the accepted event in its own thread", async () => {
	let context = await accepted();
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	try {
		expect(restored.records.get("saved-card")?.optionOrigins["saved-a"]?.source?.quote)
			.toBe("🧪 Cloud");
		expect(restored.conversationPlan.events.at(-1)?.type).toBe("option.added");
	} finally {
		await Service.close(restored);
	}
});

test("saved chat option provenance rejects wrong thread, contribution and exact source", async () => {
	for (let kind of ["thread", "contribution", "source"]) {
		let context = await accepted();
		let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
		let sidecar = structuredClone(loaded.sidecar ?? loaded.snapshot!.sidecar) as {
			questions: Array<{
				threadId: string;
				optionOrigins: Record<
					string,
					{ origin: string; source: { start: number; end: number; quote: string } }
				>;
			}>;
		};
		let record = sidecar.questions[0]!;
		if (kind === "thread") record.threadId = "other";
		if (kind === "contribution") {
			record.optionOrigins["saved-b"] = record.optionOrigins["saved-a"]!;
			delete record.optionOrigins["saved-a"];
		}
		if (kind === "source") {
			record.optionOrigins["saved-a"]!.source = {
				...record.optionOrigins["saved-a"]!.source,
				start: 0,
				end: 3,
				quote: "Try",
			};
		}
		await context.storage.collaboration.commit({
			channelId: context.channel.id,
			lease: context.lease,
			expectedRevision: loaded.channel.revision,
			operationId: `wrong-${kind}`,
			epoch: loaded.snapshot!.epoch,
			sidecar: sidecar as never,
			events: [],
			now: context.now,
		});
		await expect(Service.open(context.channel.id, context.backend, context.server))
			.rejects.toThrow("option source outside its card thread or evidence");
	}
});
