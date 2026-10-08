import { expect, test } from "bun:test";

import * as Question from "@chopin/question";

import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { openPlan } from "../testing/plan";
import * as Service from "./service";

import { repositoryTopic, topic } from "../wire";

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
	return broadcasts.filter(frame => frame.kind === "sidebar:decisions");
}

function member(): Socket {
	return {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send() {},
		publish() {},
	} as unknown as Socket;
}

function askDecisions(plan: Plan, server: Server<SocketData>): Promise<void> {
	let created = Promise.withResolvers<void>();
	void Questions.ask(
		plan,
		server,
		plan.id,
		Questions.identify(DECISIONS),
		undefined,
		created.resolve,
	);
	return created.promise;
}

function recordTopics(server: Server<SocketData>) {
	let published: Array<{ topic: string; frame: Record<string, unknown> }> = [];
	let publish = server.publish.bind(server);
	server.publish = ((target: string, data: string) => {
		published.push({ topic: target, frame: JSON.parse(data) });
		return publish(target, data);
	}) as typeof server.publish;
	return published;
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
			kind: "sidebar:decisions",
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

test("publishes decision counts to the repository topic sidebars watch, not the document's room", async () => {
	let { channel, plan, server } = await openPlan();
	let published = recordTopics(server);
	try {
		await askDecisions(plan, server);
		let announced = await eventually(() =>
			published.find(entry => entry.frame.kind === "sidebar:decisions")
		);

		expect(announced.topic).toBe(repositoryTopic(channel.repositoryId));
		expect(announced.frame).toMatchObject({ channelId: channel.id, unanswered: 2 });
		expect(
			published.filter(entry =>
				entry.frame.kind === "sidebar:decisions" && entry.topic === topic(plan.id)
			),
		).toEqual([]);
	} finally {
		await Service.close(plan);
	}
});

test("never sends a repository total older than one already sent", async () => {
	let { channel, plan, server, storage } = await openPlan();
	let delivered: Array<Record<string, unknown>> = [];
	let publish = server.publish.bind(server);
	server.publish = ((target: string, data: string) => {
		delivered.push(JSON.parse(data));
		return publish(target, data);
	}) as typeof server.publish;
	let ws = { send: (raw: string) => delivered.push(JSON.parse(raw)) } as unknown as Socket;
	let readTotal = storage.channels.unansweredDecisions.bind(storage.channels);
	let firstRead = Promise.withResolvers<void>();
	let released = Promise.withResolvers<void>();
	let reads = 0;
	storage.channels.unansweredDecisions = async repositoryId => {
		let total = await readTotal(repositoryId);
		if (reads++ === 0) {
			firstRead.resolve();
			await released.promise;
		}
		return total;
	};
	try {
		let told = Service.tellRepositoryUnanswered(
			storage,
			ws,
			channel.repositoryId,
			[channel.id],
			() => true,
		);
		await firstRead.promise;
		await askDecisions(plan, server);
		await eventually(() => plan.persistence.committedUnanswered === 2 || undefined);
		released.resolve();
		await told;
		await eventually(() => decisionFrames(delivered).length === 1 || undefined);

		let frames = delivered.filter(frame =>
			frame.kind === "sidebar:snapshot" || frame.kind === "sidebar:decisions"
		);
		expect(frames.map(frame => [frame.kind, frame.repositoryUnanswered])).toEqual([
			["sidebar:snapshot", 0],
			["sidebar:decisions", 2],
		]);
		expect(frames[1]).toMatchObject({ channelId: channel.id, unanswered: 2 });
	} finally {
		await Service.close(plan);
	}
});

test("announces the repository total when a document leaves the active catalogue", async () => {
	let { channel, plan, server, storage, now } = await openPlan();
	let published = recordTopics(server);
	try {
		await askDecisions(plan, server);
		await eventually(() =>
			published.find(entry =>
				entry.frame.kind === "sidebar:decisions" && entry.frame.repositoryUnanswered === 2
			)
		);
		await Service.drain(plan);
		await Service.persist(plan);
		let archived = await storage.channels.archive({ id: channel.id, now });
		await Service.announceCatalogueUnanswered(server, storage, archived.channel);

		let frames = published.filter(entry => entry.frame.kind === "sidebar:decisions");
		expect(frames.at(-1)).toEqual({
			topic: repositoryTopic(channel.repositoryId),
			frame: {
				kind: "sidebar:decisions",
				ts: expect.any(Number),
				channelId: channel.id,
				repositoryId: channel.repositoryId,
				unanswered: 2,
				repositoryUnanswered: 0,
				revision: archived.channel.revision,
			},
		});
	} finally {
		await Service.close(plan);
	}
});

test("sends a watching socket current counts for its loaded documents and repository", async () => {
	let { channel, plan, server, storage } = await openPlan();
	try {
		await askDecisions(plan, server);
		await answerFirst(plan, server);
		await eventually(() => plan.persistence.committedUnanswered === 1 || undefined);
		await Service.drain(plan);
		await Service.persist(plan);
		let stored = await storage.channels.get(channel.id);
		let frames: Array<Record<string, unknown>> = [];
		let ws = { send: (raw: string) => frames.push(JSON.parse(raw)) } as unknown as Socket;

		await Service.tellRepositoryUnanswered(
			storage,
			ws,
			channel.repositoryId,
			[channel.id, "cccccccc-0000-4000-8000-000000000009"],
			() => true,
		);
		await Service.tellRepositoryUnanswered(
			storage,
			ws,
			"R_elsewhere",
			[channel.id],
			() => true,
		);
		await Service.tellRepositoryUnanswered(storage, ws, channel.repositoryId, [], () => false);

		expect(frames).toEqual([{
			kind: "sidebar:snapshot",
			ts: expect.any(Number),
			repositoryId: channel.repositoryId,
			repositoryUnanswered: 1,
			documents: [{ channelId: channel.id, unanswered: 1, revision: stored!.revision }],
		}, {
			kind: "sidebar:snapshot",
			ts: expect.any(Number),
			repositoryId: "R_elsewhere",
			repositoryUnanswered: 0,
			documents: [],
		}]);
	} finally {
		await Service.close(plan);
	}
});

test("announces the repository total after a document is permanently deleted", async () => {
	let { channel, plan, server, storage, now } = await openPlan();
	let published = recordTopics(server);
	let closed = false;
	try {
		await askDecisions(plan, server);
		await eventually(() => plan.persistence.committedUnanswered === 2 || undefined);
		await Service.drain(plan);
		await Service.persist(plan);
		let archived = await storage.channels.archive({ id: channel.id, now });
		await Service.close(plan);
		closed = true;
		expect(await storage.channels.delete(channel.id)).toBe(true);
		await Service.announceDeletedUnanswered(server, storage, archived.channel);

		let frames = published.filter(entry => entry.frame.kind === "sidebar:decisions");
		expect(frames.at(-1)).toEqual({
			topic: repositoryTopic(channel.repositoryId),
			frame: {
				kind: "sidebar:decisions",
				ts: expect.any(Number),
				channelId: channel.id,
				repositoryId: channel.repositoryId,
				unanswered: 0,
				repositoryUnanswered: 0,
				revision: archived.channel.revision,
			},
		});
	} finally {
		if (!closed) await Service.close(plan);
	}
});
