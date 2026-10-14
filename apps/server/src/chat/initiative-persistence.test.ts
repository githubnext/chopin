import { expect, test } from "bun:test";
import type { Socket } from "../wire";
import * as Plan from "../plan/service";
import { hosted } from "../plan/conversation-persistence.test-fixtures";
import * as Chat from "./service";
import { setParticipation } from "./initiative";

function context(h: Awaited<ReturnType<typeof hosted>>, plan: Plan.Plan): Chat.Room {
	return {
		chat: plan.chat,
		plan,
		server: h.server,
		room: h.channel.id,
		config: { agent: true, conversationInitiative: true } as Chat.Room["config"],
		auth: {} as Chat.Room["auth"],
		claimantSessionId: undefined,
		repository: { id: "R_score", owner: "octo-org", name: "score", defaultBranch: "main" },
		persist: next => Plan.persist(plan, next),
	};
}

function socket(replies: Array<Record<string, unknown>>): Socket {
	return {
		data: { handle: "octocat", principalId: "U_octocat", client: "octocat-tab" },
		send(value: string) {
			replies.push(JSON.parse(value) as Record<string, unknown>);
		},
	} as unknown as Socket;
}

function change(paused: boolean) {
	return { kind: "chat:participation" as const, ts: 0, rid: crypto.randomUUID(), paused };
}

test("pause and resume survive real plan sidecar commits and reopen", async () => {
	let h = await hosted();
	let plan = await Plan.open(h.channel.id, h.backend, h.server);
	let replies: Array<Record<string, unknown>> = [];
	let ws = socket(replies);
	try {
		await setParticipation(context(h, plan), ws, change(true));
		await Plan.close(plan);
		plan = await Plan.open(h.channel.id, h.backend, h.server);
		expect(plan.chat.initiativePaused).toBe(true);
		Chat.greet(plan.chat, ws);
		expect(replies.at(-1)).toMatchObject({
			kind: "chat:history",
			participation: { paused: true },
		});
		await setParticipation(context(h, plan), ws, change(false));
		await Plan.close(plan);
		plan = await Plan.open(h.channel.id, h.backend, h.server);
		expect(plan.chat.initiativePaused).toBe(false);
		Chat.greet(plan.chat, ws);
		expect(replies.at(-1)).toMatchObject({
			kind: "chat:history",
			participation: { paused: false },
		});
	} finally {
		await Plan.close(plan);
	}
});

test("a held real sidecar commit keeps pause unpublished until durable success", async () => {
	let h = await hosted();
	let plan = await Plan.open(h.channel.id, h.backend, h.server);
	let replies: Array<Record<string, unknown>> = [];
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let commit = h.storage.collaboration.commit;
	h.storage.collaboration.commit = async input => {
		entered.resolve();
		await release.promise;
		return commit(input);
	};
	try {
		let changing = setParticipation(context(h, plan), socket(replies), change(true));
		await entered.promise;
		expect(plan.chat.initiativePaused).toBe(false);
		expect(replies).toEqual([]);
		expect(h.frames.filter(frame => frame.kind === "chat:participation")).toEqual([]);
		release.resolve();
		await changing;
		expect(plan.chat.initiativePaused).toBe(true);
		expect(replies.at(-1)).toMatchObject({ kind: "chat:participation", paused: true });
		expect(h.frames.at(-1)).toMatchObject({ kind: "chat:participation", paused: true });
		await Plan.close(plan);
		plan = await Plan.open(h.channel.id, h.backend, h.server);
		expect(plan.chat.initiativePaused).toBe(true);
	} finally {
		release.resolve();
		h.storage.collaboration.commit = commit;
		await Plan.close(plan);
	}
});

test.each([false, true])("a failed real preference commit preserves paused=%s", async previous => {
	let h = await hosted();
	let plan = await Plan.open(h.channel.id, h.backend, h.server);
	let replies: Array<Record<string, unknown>> = [];
	let ws = socket(replies);
	await setParticipation(context(h, plan), ws, change(previous));
	let commit = h.storage.collaboration.commit;
	h.storage.collaboration.commit = async () => {
		throw new Error("commit unavailable");
	};
	try {
		await setParticipation(context(h, plan), ws, change(!previous));
		expect(plan.chat.initiativePaused).toBe(previous);
		expect(replies.at(-1)?.kind).toBe("session:error");
		let last = h.frames.findLast(frame => frame.kind === "chat:participation");
		expect(last?.paused).toBe(previous);
		h.storage.collaboration.commit = commit;
		await Plan.persist(plan);
		await Plan.close(plan);
		plan = await Plan.open(h.channel.id, h.backend, h.server);
		expect(plan.chat.initiativePaused).toBe(previous);
	} finally {
		h.storage.collaboration.commit = commit;
		await Plan.close(plan);
	}
});

test("an unrelated queued commit retains a prospective pause after its live publication", async () => {
	let h = await hosted();
	let plan = await Plan.open(h.channel.id, h.backend, h.server);
	let replies: Array<Record<string, unknown>> = [];
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let commit = h.storage.collaboration.commit;
	h.storage.collaboration.commit = async input => {
		entered.resolve();
		await release.promise;
		return commit(input);
	};
	try {
		let changing = setParticipation(context(h, plan), socket(replies), change(true));
		await entered.promise;
		expect(plan.chat.initiativePaused).toBe(false);
		let unrelated = Plan.persist(plan);
		release.resolve();
		await Promise.all([changing, unrelated]);
		let loaded = await h.storage.collaboration.load(h.channel.id, h.now);
		let sidecar = (loaded?.sidecar ?? loaded?.snapshot?.sidecar) as {
			initiativePaused?: boolean;
		};
		expect(sidecar.initiativePaused).toBe(true);
		await Plan.close(plan);
		plan = await Plan.open(h.channel.id, h.backend, h.server);
		expect(plan.chat.initiativePaused).toBe(true);
	} finally {
		release.resolve();
		h.storage.collaboration.commit = commit;
		await Plan.close(plan);
	}
});
