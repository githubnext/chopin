import { expect, test } from "bun:test";

import * as Question from "@chopin/question";

import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { openPlan } from "../testing/plan";
import * as Service from "./service";

import type { Server } from "bun";
import type { Socket, SocketData } from "../wire";
import type { Plan } from "./service";

const DECISIONS = {
	questions: [
		{
			header: "Storage",
			question: "Where should room state live?",
			multiple: false,
			options: [{ label: "On disk", description: "Readable." }],
		},
		{
			header: "Scope",
			question: "What belongs in the first cut?",
			multiple: false,
			options: [{ label: "Anchors", description: "Link prose." }],
		},
	],
};

async function eventually<T>(read: () => T | undefined): Promise<T> {
	for (let attempt = 0; attempt < 200; attempt++) {
		let value = read();
		if (value !== undefined) return value;
		await Bun.sleep(5);
	}
	throw new Error("condition was never met");
}

function decisionFrames(broadcasts: Array<Record<string, unknown>>) {
	return broadcasts.filter(frame => frame.kind === "session:decisions");
}

function member(): Socket {
	return {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send() {},
		publish() {},
	} as unknown as Socket;
}

async function answerFirst(plan: Plan, server: Server<SocketData>): Promise<void> {
	let record = [...plan.records.values()].find(item => item.status === "open");
	if (!record) throw new Error("no open decision");
	let opened = Store.snapshot(plan.questions, record.id);
	if (!opened.open) throw new Error("question was not open");
	let question = opened.definition.questions[0]!;
	let model = Question.crdt.Model.fromBinary(new Uint8Array(opened.model))
		.fork() as unknown as Question.Model;
	model.api.val([question.id, "choice"]).set(question.options[0]!.id);
	let patch = model.api.flush();
	if (!patch) throw new Error("selection produced no patch");
	let ws = member();
	await Questions.edit(plan, ws, {
		kind: "question:edit",
		ts: 0,
		rid: "select",
		id: record.id,
		patch: [...patch.toBinary()],
	});
	await Questions.submit(plan, server, plan.id, ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save",
		id: record.id,
		revision: Store.get(plan.questions, record.id)!.revision,
	});
}

test("announces committed unanswered counts when decisions are asked and answered", async () => {
	let { broadcasts, channel, plan, server, storage } = await openPlan();
	try {
		let created = Promise.withResolvers<void>();
		void Questions.ask(
			plan,
			server,
			plan.id,
			Questions.identify(DECISIONS),
			undefined,
			created.resolve,
		);
		await created.promise;

		let asked = await eventually(() =>
			decisionFrames(broadcasts).find(frame => frame.unanswered === 2)
		);
		expect(asked).toEqual({
			kind: "session:decisions",
			ts: expect.any(Number),
			channelId: channel.id,
			repositoryId: channel.repositoryId,
			unanswered: 2,
			repositoryUnanswered: 2,
			revision: expect.any(Number),
		});
		expect((await storage.channels.get(channel.id))?.unansweredDecisions).toBe(2);

		await answerFirst(plan, server);
		let answered = await eventually(() =>
			decisionFrames(broadcasts).find(frame => frame.unanswered === 1)
		);
		expect(answered).toMatchObject({ unanswered: 1, repositoryUnanswered: 1 });
		expect(answered.revision).toBeGreaterThan(asked.revision as number);
		expect(answered.revision).toBeLessThanOrEqual(
			(await storage.channels.get(channel.id))!.revision,
		);
		expect((await storage.channels.get(channel.id))?.unansweredDecisions).toBe(1);
		expect(decisionFrames(broadcasts).map(frame => frame.unanswered)).toEqual([2, 1]);
	} finally {
		await Service.close(plan);
	}
});

test("tells a joining socket the committed counts for its document", async () => {
	let { channel, plan, server } = await openPlan();
	try {
		let created = Promise.withResolvers<void>();
		void Questions.ask(
			plan,
			server,
			plan.id,
			Questions.identify(DECISIONS),
			undefined,
			created.resolve,
		);
		await created.promise;
		await eventually(() => plan.persistence.committedUnanswered === 2 || undefined);

		let frames: Array<Record<string, unknown>> = [];
		let ws = { send: (raw: string) => frames.push(JSON.parse(raw)) } as unknown as Socket;
		await Service.tellUnanswered(plan, ws);

		expect(frames).toEqual([{
			kind: "session:decisions",
			ts: expect.any(Number),
			channelId: channel.id,
			repositoryId: channel.repositoryId,
			unanswered: 2,
			repositoryUnanswered: 2,
			revision: plan.persistence.revision,
		}]);
	} finally {
		await Service.close(plan);
	}
});
