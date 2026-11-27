import { afterEach, describe, expect, it } from "bun:test";

import * as Question from "@chopin/question";

import { Admission } from "../auth/admission";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import { GitHubError } from "../github/client";
import { handler } from "../mcp";
import * as edit from "../plan/edit";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import * as Rooms from "../rooms";
import { openPlan } from "../testing/plan";
import { applyEvent } from "../conversation-plan/events";
import {
	activateD02Deferral,
	d02DeferralQuote,
	d02Settlement,
	d02Source,
} from "../question-service-deferral.test-fixtures";
import { hosted } from "./hosted";
import { answerDecisionInvocationKey } from "./decisions";

import type { Server } from "bun";
import type { HostedAuth } from "../auth/routes";
import type {
	GitHub,
	GitHubTokenGrant,
	GitHubUser,
	InstallationPage,
	Repository,
	RepositoryPage,
} from "../github/client";
import type { Socket, SocketData } from "../wire";

const NOW = new Date("2026-11-20T12:00:00.000Z");

class FakeGitHub implements GitHub {
	push = true;
	repositoryValue: Repository = {
		id: "R_score",
		owner: "octo-org",
		name: "score",
		fullName: "octo-org/score",
		private: true,
		url: "https://github.test/octo-org/score",
		defaultBranch: "main",
		permissions: { pull: true, push: true, admin: false },
	};

	authorize(): string {
		return "";
	}
	async exchange(): Promise<GitHubTokenGrant> {
		return {
			accessToken: "t",
			accessExpiresIn: 28_800,
			refreshToken: "r",
			refreshExpiresIn: 15_897_600,
		};
	}
	async refresh(): Promise<GitHubTokenGrant> {
		return {
			accessToken: "t",
			accessExpiresIn: 28_800,
			refreshToken: "r",
			refreshExpiresIn: 15_897_600,
		};
	}
	async user(token: string): Promise<GitHubUser> {
		if (token === "denied") throw new GitHubError("bad credentials", 401);
		return { id: `U_${token}`, login: token, avatarUrl: "https://github.test/avatar" };
	}
	async organizationMembership() {
		return undefined;
	}
	async repositories(): Promise<RepositoryPage> {
		return { repositories: [], nextPage: undefined };
	}
	async installations(): Promise<InstallationPage> {
		return { installations: [], nextPage: undefined };
	}
	async installationRepositories(): Promise<RepositoryPage> {
		return this.repositories();
	}
	async repository(_token: string, owner: string, name: string): Promise<Repository> {
		return {
			...this.repositoryValue,
			owner,
			name,
			fullName: `${owner}/${name}`,
			permissions: { pull: true, push: this.push, admin: false },
		};
	}
	async repositoryAccess(token: string, owner: string, name: string) {
		return this.repository(token, owner, name);
	}
	async installationRepositoryAccess() {
		return undefined;
	}
	invalidate(): void {}
}

function actor(handle = "alice") {
	let replies: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle, client: `client-${handle}`, room: "test" },
		send(data: string) {
			replies.push(JSON.parse(data) as Record<string, unknown>);
		},
		publish() {},
	} as unknown as Socket;
	return { ws, replies };
}

let roomsToClear: Rooms.Room[] = [];
let plansToClose: Plan.Plan[] = [];

afterEach(async () => {
	for (let room of roomsToClear.splice(0)) Rooms.forget(room);
	for (let plan of plansToClose.splice(0)) await Plan.close(plan);
});

async function setupDoc(source = "# Release plan\n\nDeploy the new service.\n") {
	let opened = await openPlan(source);
	plansToClose.push(opened.plan);
	let storage = opened.storage;
	let github = new FakeGitHub();
	let now = NOW;
	let clock = () => now;
	let config = {
		origin: "https://chopin.test",
		encryptionKey: new Uint8Array(32).fill(7),
		clientId: "client-id",
		clientSecret: "client-secret",
		appSlug: "chopin-test",
	};
	let auth: HostedAuth = {
		config,
		storage,
		github,
		sessions: new Sessions(storage, true, clock),
		machines: new Machines(storage, clock, { origin: config.origin, clientId: config.clientId }),
		admission: new Admission(config, github, () => clock().getTime()),
		clock,
		pairings: {},
	};
	// Update stored channel metadata so repository matches FakeGitHub.
	let channel = (await storage.channels.get(opened.channel.id))!;
	github.repositoryValue = {
		...github.repositoryValue,
		id: channel.repositoryId,
		owner: channel.repositoryOwner,
		name: channel.repositoryName,
		fullName: `${channel.repositoryOwner}/${channel.repositoryName}`,
	};

	let plannerAnswers: Array<{ channelId: string; id: string; generation: number }> = [];
	let lease = opened.lease;
	let mcp = handler(
		hosted(auth, { lease: () => lease }, {
			onPlannerAnswer: (channelId, id, generation) => {
				plannerAnswers.push({ channelId, id, generation });
			},
		}),
	);

	let call = async (name: string, args: Record<string, unknown>, token = "alice") => {
		let res = await mcp(
			new Request("https://chopin.test/mcp", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name, arguments: args },
				}),
			}),
		);
		return await res.json() as {
			result?: {
				content: Array<{ type: "text"; text: string }>;
				structuredContent?: Record<string, unknown>;
				isError?: boolean;
			};
			error?: { code: number; message: string };
		};
	};

	let heldRoom: { room: Rooms.Room; release: () => void } | undefined;
	let attachLive = () => {
		heldRoom = Rooms.hold(channel.id);
		heldRoom.room.plan = opened.plan;
		roomsToClear.push(heldRoom.room);
	};

	let detachLive = () => {
		if (!heldRoom) return;
		heldRoom.release();
		Rooms.forget(heldRoom.room);
		roomsToClear = roomsToClear.filter(room => room !== heldRoom!.room);
		heldRoom = undefined;
	};

	return {
		opened,
		channel,
		storage,
		github,
		auth,
		plannerAnswers,
		call,
		attachLive,
		detachLive,
		setClock(next: Date) {
			now = next;
		},
	};
}

async function addChoiceCard(
	plan: Plan.Plan,
	server: Server<SocketData>,
	channelId: string,
	options: {
		question?: string;
		multiple?: boolean;
		choices?: Array<{ label: string; description: string; preview?: string }>;
		blocking?: boolean;
	} = {},
) {
	let definition = Questions.identify({
		questions: [{
			header: "Choice",
			question: options.question ?? "Which database should we use?",
			description: "Pick the primary backing store.",
			multiple: options.multiple ?? false,
			options: options.choices ?? [
				{
					label: "PostgreSQL",
					description: "Relational store",
					preview: "```mermaid\ngraph LR\nA-->B\n```",
				},
				{ label: "SQLite", description: "Embedded store" },
			],
		}],
	});
	if (options.blocking) {
		let beforeIds = new Set(plan.questions.open.keys());
		let created = Promise.withResolvers<string>();
		let pending = Questions.ask(
			plan,
			server,
			channelId,
			definition,
			{
				revision: plan.revision,
				blocks: [[{ index: 1, digest: edit.outline(plan)[1]!.digest }]],
			},
			undefined,
			undefined,
			ids => created.resolve(ids[0]!),
		);
		let id = await created.promise;
		expect(beforeIds.has(id)).toBe(false);
		let entry = plan.questions.open.get(id)!;
		entry.awaited = true;
		return { id, definition: entry.definition, pending };
	}
	let result = await Questions.captureDecisions(
		plan,
		server,
		channelId,
		{
			revision: plan.revision,
			questions: [{
				key: `key-${Math.random().toString(36).slice(2, 12)}`,
				header: "Choice",
				question: options.question ?? "Which database should we use?",
				description: "Pick the primary backing store.",
				multiple: options.multiple ?? false,
				options: options.choices ?? [
					{
						label: "PostgreSQL",
						description: "Relational store",
						preview: "```mermaid\ngraph LR\nA-->B\n```",
					},
					{ label: "SQLite", description: "Embedded store" },
				],
				blocks: [{
					index: 1,
					digest: edit.outline(plan)[1]!.digest,
				}],
			}],
		},
	);
	let id = result.decisions[0]!.id;
	let record = plan.records.get(id)!;
	return { id, definition: record.definition };
}

async function addTextCard(
	plan: Plan.Plan,
	server: Server<SocketData>,
	channelId: string,
	question = "What rollout window should we target?",
) {
	let id = await Questions.capture(
		plan,
		server,
		channelId,
		{
			key: `text-${Math.random().toString(36).slice(2, 12)}`,
			question,
			description: "Describe the preferred schedule.",
			block: {
				index: 1,
				digest: edit.outline(plan)[1]!.digest,
			},
		},
		{ revision: plan.revision },
	);
	let record = plan.records.get(id)!;
	return { id, definition: record.definition };
}

describe("read_document decision reading and filtering", () => {
	it("leaves default read_document output unchanged when no decision flags are set", async () => {
		let ctx = await setupDoc();
		ctx.attachLive();
		await addChoiceCard(ctx.opened.plan, ctx.opened.server, ctx.channel.id);

		let plain = await ctx.call("read_document", { id: ctx.channel.id });
		expect(plain.error).toBeUndefined();
		expect(plain.result?.structuredContent).not.toHaveProperty("decisions");
		expect(plain.result?.structuredContent).not.toHaveProperty("decisionCounts");
		expect(plain.result?.content[0]?.text).not.toContain("Decisions:");
	});

	it("filters by status (single, array, all), origin, and reports counts, paused, draftInProgress, and previous across reopen on live and stored docs", async () => {
		let ctx = await setupDoc();
		ctx.attachLive();
		let plan = ctx.opened.plan;

		// 1. Open planner choice card with untouched draft
		let openChoice = await addChoiceCard(plan, ctx.opened.server, ctx.channel.id);
		// 2. Open planner text card with untouched draft
		let openText = await addTextCard(plan, ctx.opened.server, ctx.channel.id);
		// 3. Answered then reopened card (preserves previous attribution!)
		let reopenedCard = await addChoiceCard(plan, ctx.opened.server, ctx.channel.id, {
			question: "Which region should launch first?",
			choices: [
				{ label: "US East", description: "Virginia cluster" },
				{ label: "EU West", description: "Dublin cluster" },
			],
		});
		let reopenQ = reopenedCard.definition.questions[0]!;
		let settledFirst = await Questions.answerDecision(plan, ctx.opened.server, ctx.channel.id, {
			decisionId: reopenedCard.id,
			revision: 0,
			resolver: "mona",
			optionIds: [reopenQ.options[0]!.id],
		});
		expect(settledFirst.ok).toBe(true);
		await Questions.reopen(plan, ctx.opened.server, ctx.channel.id, actor("bob").ws, {
			kind: "question:reopen",
			rid: "r-reopen",
			ts: 0,
			id: reopenedCard.id,
		});
		// 4. Answered human card
		let humanId = await Questions.capture(
			plan,
			ctx.opened.server,
			ctx.channel.id,
			{
				key: "human-dec-1",
				question: "Who owns on-call?",
			},
			{ human: "alice" },
		);
		let settledHuman = await Questions.answerDecision(plan, ctx.opened.server, ctx.channel.id, {
			decisionId: humanId,
			revision: 0,
			resolver: "alice",
			text: "Platform team",
		});
		expect(settledHuman.ok).toBe(true);

		// Touch draft on openText so draftInProgress becomes true on openText (while untouched on openChoice)
		let textEntry = plan.questions.open.get(openText.id)!;
		let fork = textEntry.model.fork() as Question.Model;
		fork.api.str([openText.definition.questions[0]!.id, "custom"]).ins(0, "Next Tuesday");
		await Questions.edit(plan, actor("bob").ws, {
			kind: "question:edit",
			rid: "edit-text-1",
			ts: 0,
			id: openText.id,
			patch: [...fork.api.flush().toBinary()],
		});

		// Mark openChoice paused via real applyEvent sequence on its linked thread
		let seed = d02Settlement(plan, openChoice.id);
		// Rewind hand-mutated proposal and apply proposal -> stance.changed -> settle.deferred cleanly
		plan.conversationPlan = {
			...plan.conversationPlan,
			events: plan.conversationPlan.events.slice(0, -1),
			threads: plan.conversationPlan.threads.map(thread =>
				thread.id === seed.threadId
					? { ...thread, version: thread.version - 1, pendingSettle: undefined }
					: thread
			),
		};
		plan.conversationPlan = applyEvent(plan.conversationPlan, seed.proposal);
		let v1 = plan.conversationPlan.threads.find(t => t.id === seed.threadId)!.version;
		plan.conversationPlan = applyEvent(plan.conversationPlan, {
			id: "d02:stance-m7",
			type: "stance.changed",
			threadId: seed.threadId,
			observedThreadVersion: v1,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 6,
			optionId: seed.optionId,
			position: "neutral",
			source: d02Source("m7", "Bram", d02DeferralQuote, "withdrawal"),
		} as never);
		let v2 = plan.conversationPlan.threads.find(t => t.id === seed.threadId)!.version;
		plan.conversationPlan = applyEvent(plan.conversationPlan, {
			...seed.deferral,
			observedThreadVersion: v2,
		} as never);
		await Plan.persist(plan);

		// Live read: all decisions
		let allLive = await ctx.call("read_document", {
			id: ctx.channel.id,
			includeDecisions: true,
		});
		expect(allLive.result?.isError).toBeUndefined();
		let sc = allLive.result?.structuredContent as {
			decisions: Array<Record<string, unknown>>;
			decisionCounts: Record<string, number>;
		};
		expect(sc.decisionCounts).toEqual({
			open: 2,
			reopened: 1,
			answered: 1,
			discarded: 0,
			cancelled: 0,
			expired: 0,
			total: 4,
		});
		expect(sc.decisions).toHaveLength(4);
		expect(allLive.result?.content[0]?.text).toContain("Decisions:");

		let snapChoice = sc.decisions.find(d => d.id === openChoice.id)!;
		expect(snapChoice).toMatchObject({
			status: "open",
			origin: "planner",
			revision: 0,
			paused: true,
			draftInProgress: false,
			historyCount: 0,
		});
		let snapText = sc.decisions.find(d => d.id === openText.id)!;
		expect(snapText).toMatchObject({
			status: "open",
			origin: "planner",
			revision: 1,
			paused: false,
			draftInProgress: true,
		});
		let snapReopened = sc.decisions.find(d => d.id === reopenedCard.id)!;
		expect(snapReopened).toMatchObject({
			status: "reopened",
			origin: "planner",
			draftInProgress: false,
			historyCount: 1,
			previous: {
				by: "mona",
				answers: { [reopenQ.id]: "US East" },
				optionIds: [reopenQ.options[0]!.id],
			},
		});
		let snapHuman = sc.decisions.find(d => d.id === humanId)!;
		expect(snapHuman).toMatchObject({
			status: "answered",
			origin: "human",
			settled: {
				by: "alice",
				answers: { [plan.records.get(humanId)!.definition.questions[0]!.id]: "Platform team" },
				optionIds: [],
			},
		});

		// Filter by status array (deduped) — decisionCounts still reflects ALL 4!
		let filtered = await ctx.call("read_document", {
			id: ctx.channel.id,
			decisionStatus: ["open", "reopened", "open"],
		});
		let fsc = filtered.result?.structuredContent as {
			decisions: Array<{ id: string }>;
			decisionCounts: Record<string, number>;
		};
		expect(fsc.decisions.map(d => d.id).sort()).toEqual(
			[openChoice.id, openText.id, reopenedCard.id].sort(),
		);
		expect(fsc.decisionCounts.total).toBe(4);
		expect(fsc.decisionCounts.answered).toBe(1);

		// Filter by single status + origin
		let humanOnly = await ctx.call("read_document", {
			id: ctx.channel.id,
			decisionStatus: "answered",
			decisionOrigin: "human",
		});
		let hsc = humanOnly.result?.structuredContent as { decisions: Array<{ id: string }> };
		expect(hsc.decisions.map(d => d.id)).toEqual([humanId]);

		// Stored-only read (room detached/unloaded) produces identical snapshots!
		ctx.detachLive();
		let stored = await ctx.call("read_document", {
			id: ctx.channel.id,
			decisionStatus: "all",
		});
		expect(stored.result?.structuredContent).toEqual(allLive.result?.structuredContent);

		// Malformed arguments rejected via JSON-RPC -32602
		let badStatus = await ctx.call("read_document", {
			id: ctx.channel.id,
			decisionStatus: "bogus",
		});
		expect(badStatus.error?.code).toBe(-32602);
		let badCombo = await ctx.call("read_document", {
			id: ctx.channel.id,
			includeDecisions: false,
			decisionStatus: "open",
		});
		expect(badCombo.error?.code).toBe(-32602);
	});
});

describe("answer_decision core and MCP protocol", () => {
	it("answers by card ID and by question ID, replays idempotently (even after reopen/lock) without re-notifying Planner, and rejects conflicts", async () => {
		let ctx = await setupDoc();
		ctx.attachLive();
		let plan = ctx.opened.plan;

		let card1 = await addChoiceCard(plan, ctx.opened.server, ctx.channel.id);
		let q1 = card1.definition.questions[0]!;
		let card2 = await addChoiceCard(plan, ctx.opened.server, ctx.channel.id, {
			question: "Which queue backend?",
			choices: [
				{ label: "Postgres", description: "Durable queue" },
				{ label: "Redis", description: "In-memory queue" },
			],
		});
		let q2 = card2.definition.questions[0]!;

		// Answer card1 by card ID
		let first = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: card1.id,
			revision: 0,
			idempotencyKey: "ans-card1",
			optionIds: [q1.options[0]!.id],
		});
		expect(first.result?.isError).toBeUndefined();
		let firstSc = first.result?.structuredContent as Record<string, unknown>;
		expect(firstSc).toMatchObject({
			status: "answered",
			replayed: false,
			decisionId: card1.id,
			resolver: "alice",
			answers: { [q1.id]: "PostgreSQL" },
			decision: { id: card1.id, status: "answered" },
		});
		let originalCommittedAt = firstSc.committedAt as number;
		expect(ctx.plannerAnswers).toEqual([
			{ channelId: ctx.channel.id, id: card1.id, generation: 1 },
		]);

		// Reopen card1 AND advance clock AND simulate active implementation — exact replay STILL returns original result!
		await Questions.reopen(plan, ctx.opened.server, ctx.channel.id, actor("bob").ws, {
			kind: "question:reopen",
			rid: "r-reopen-1",
			ts: 0,
			id: card1.id,
		});
		ctx.setClock(new Date(NOW.getTime() + 60_000));
		let replay = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: card1.id,
			revision: 0,
			idempotencyKey: "ans-card1",
			optionIds: [q1.options[0]!.id],
		});
		expect(replay.result?.isError).toBeUndefined();
		expect(replay.result?.structuredContent).toEqual({
			...firstSc,
			replayed: true,
		});
		expect((replay.result!.structuredContent as Record<string, unknown>).committedAt).toBe(
			originalCommittedAt,
		);
		// Must NOT fire a duplicate onPlannerAnswer!
		expect(ctx.plannerAnswers).toHaveLength(1);
		// Card1 remained reopened (replay mutated zero state!)
		expect(plan.records.get(card1.id)?.status).toBe("reopened");

		// Reusing same key with different payload -> idempotency-conflict (zero mutation)
		let conflict = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: card1.id,
			revision: 0,
			idempotencyKey: "ans-card1",
			optionIds: [q1.options[1]!.id],
		});
		expect(conflict.result?.isError).toBe(true);
		expect(conflict.result?.structuredContent).toEqual({ code: "idempotency-conflict" });
		expect(plan.records.get(card1.id)?.status).toBe("reopened");

		// Answer card2 by QUESTION ID (not card ID!)
		let byQuestion = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: q2.id,
			revision: 0,
			idempotencyKey: "k".repeat(128), // also exercises 128-char key hashing
			optionIds: [q2.options[1]!.id],
		});
		expect(byQuestion.result?.isError).toBeUndefined();
		expect(byQuestion.result?.structuredContent).toMatchObject({
			status: "answered",
			replayed: false,
			decisionId: card2.id,
			answers: { [q2.id]: "Redis" },
		});
		expect(ctx.plannerAnswers).toEqual([
			{ channelId: ctx.channel.id, id: card1.id, generation: 1 },
			{ channelId: ctx.channel.id, id: card2.id, generation: 1 },
		]);
		expect(answerDecisionInvocationKey("k".repeat(128)).length).toBeLessThanOrEqual(128);
	});

	it("returns every typed refusal cleanly, frees idempotency key on refusal, and supports multi-question and text cards", async () => {
		let ctx = await setupDoc();
		ctx.attachLive();
		let plan = ctx.opened.plan;

		// 1. unknown-decision (never fake "cancelled by system")
		let missing = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: "does-not-exist",
			revision: 0,
			idempotencyKey: "retryable-key",
			optionIds: ["opt-1"],
		});
		expect(missing.result?.isError).toBe(true);
		expect(missing.result?.structuredContent).toEqual({ code: "unknown-decision" });

		// 2. stale with currentRevision, then draft-in-progress on choice & text cards
		let choice = await addChoiceCard(plan, ctx.opened.server, ctx.channel.id, { multiple: true });
		let cq = choice.definition.questions[0]!;
		let stale = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: choice.id,
			revision: 99,
			idempotencyKey: "retryable-key", // key was freed after unknown-decision!
			optionIds: [cq.options[0]!.id],
		});
		expect(stale.result?.structuredContent).toEqual({ code: "stale", currentRevision: 0 });

		// Touch draft -> draft-in-progress (also test stale on old revision)
		let choiceEntry = plan.questions.open.get(choice.id)!;
		let fork = choiceEntry.model.fork() as Question.Model;
		fork.api.val([cq.id, "options", cq.options[0]!.id]).set(true);
		await Questions.edit(plan, actor("bob").ws, {
			kind: "question:edit",
			rid: "edit-choice-1",
			ts: 0,
			id: choice.id,
			patch: [...fork.api.flush().toBinary()],
		});
		let currentChoiceRev = plan.questions.open.get(choice.id)!.revision;
		expect(currentChoiceRev).toBe(1);
		let draftBusy = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: choice.id,
			revision: currentChoiceRev,
			idempotencyKey: "retryable-key",
			optionIds: [cq.options[1]!.id],
		});
		expect(draftBusy.result?.structuredContent).toEqual({
			code: "draft-in-progress",
			currentRevision: currentChoiceRev,
		});

		// 3. Text card (untouched draft has mode === "custom" -> allowed! Touched -> draft-in-progress!)
		let textCard = await addTextCard(plan, ctx.opened.server, ctx.channel.id);
		let badOptionOnText = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: textCard.id,
			revision: 0,
			idempotencyKey: "retryable-key",
			optionIds: ["fake"],
		});
		expect(badOptionOnText.result?.structuredContent).toMatchObject({ code: "invalid-answer" });
		// Retry with same key and valid text succeeds!
		let answeredText = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: textCard.id,
			revision: 0,
			idempotencyKey: "retryable-key",
			text: "Roll out gradually at 10% per day.",
		});
		expect(answeredText.result?.isError).toBeUndefined();
		expect(answeredText.result?.structuredContent).toMatchObject({
			status: "answered",
			replayed: false,
			decisionId: textCard.id,
			answers: { [textCard.definition.questions[0]!.id]: "Roll out gradually at 10% per day." },
		});

		// 4. already-settled with status & resolver
		let already = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: textCard.id,
			revision: 0,
			idempotencyKey: "fresh-key-settled",
			text: "Again",
		});
		expect(already.result?.structuredContent).toEqual({
			code: "already-settled",
			status: "answered",
			resolver: "alice",
		});

		// 5. paused refusal
		let pausedCard = await addChoiceCard(plan, ctx.opened.server, ctx.channel.id, {
			question: "Paused choice?",
		});
		let pauseSeed = d02Settlement(plan, pausedCard.id);
		activateD02Deferral(plan, pauseSeed.deferral);
		let paused = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: pausedCard.id,
			revision: 0,
			idempotencyKey: "k-paused",
			optionIds: [pausedCard.definition.questions[0]!.options[0]!.id],
		});
		expect(paused.result?.structuredContent).toEqual({ code: "paused" });

		// 6. state-diverged (open record with missing open store entry)
		let divergedCard = await addChoiceCard(plan, ctx.opened.server, ctx.channel.id, {
			question: "Diverged choice?",
		});
		plan.questions.open.delete(divergedCard.id);
		let diverged = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: divergedCard.id,
			revision: 0,
			idempotencyKey: "k-diverged",
			optionIds: [divergedCard.definition.questions[0]!.options[0]!.id],
		});
		expect(diverged.result?.structuredContent).toEqual({ code: "state-diverged" });

		// 7. implementation-active
		let lockedCard = await addChoiceCard(plan, ctx.opened.server, ctx.channel.id, {
			question: "Locked choice?",
		});
		plan.claiming = true;
		let locked = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: lockedCard.id,
			revision: 0,
			idempotencyKey: "k-locked",
			optionIds: [lockedCard.definition.questions[0]!.options[0]!.id],
		});
		expect(locked.result?.structuredContent).toEqual({ code: "implementation-active" });
		plan.claiming = false;

		// 8. Multi-choice + `answers` map + awaited blocking ask does NOT trigger onPlannerAnswer
		let multiChoice = await addChoiceCard(plan, ctx.opened.server, ctx.channel.id, {
			question: "Select all supported platforms",
			multiple: true,
			choices: [
				{ label: "Linux", description: "Ubuntu/Debian" },
				{ label: "macOS", description: "Apple Silicon" },
				{ label: "Windows", description: "x86_64" },
			],
		});
		let mq = multiChoice.definition.questions[0]!;
		let multiRes = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: multiChoice.id,
			revision: 0,
			idempotencyKey: "k-multi",
			answers: { [mq.id]: { optionIds: [mq.options[0]!.id, mq.options[1]!.id] } },
		});
		expect(multiRes.result?.isError).toBeUndefined();
		expect(multiRes.result?.structuredContent).toMatchObject({
			status: "answered",
			answers: { [mq.id]: "Linux, macOS" },
		});

		// Blocking awaited ask settles its waiter without firing onPlannerAnswer
		let beforeCount = ctx.plannerAnswers.length;
		let blocking = await addChoiceCard(plan, ctx.opened.server, ctx.channel.id, {
			question: "Blocking ask?",
			blocking: true,
		});
		let bq = blocking.definition.questions[0]!;
		let blockRes = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: blocking.id,
			revision: 0,
			idempotencyKey: "k-blocking",
			optionIds: [bq.options[0]!.id],
		});
		expect(blockRes.result?.isError).toBeUndefined();
		let ended = await blocking.pending!;
		expect(ended[0]).toMatchObject({ status: "answered", resolver: "alice" });
		expect(ctx.plannerAnswers).toHaveLength(beforeCount);

		// Pull-only caller -> repository-forbidden
		ctx.github.push = false;
		let forbidden = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: lockedCard.id,
			revision: 0,
			idempotencyKey: "k-forb",
			optionIds: [lockedCard.definition.questions[0]!.options[0]!.id],
		});
		expect(forbidden.result?.structuredContent).toEqual({ code: "repository-forbidden" });
	});

	it("settles a decision on a closed (stored-only) document cleanly and persists across reload", async () => {
		let ctx = await setupDoc();
		let card = await addChoiceCard(ctx.opened.plan, ctx.opened.server, ctx.channel.id);
		let q = card.definition.questions[0]!;
		await Plan.persist(ctx.opened.plan);
		// Close live plan completely so MCP opens from storage!
		await Plan.close(ctx.opened.plan);
		plansToClose = plansToClose.filter(p => p !== ctx.opened.plan);

		let res = await ctx.call("answer_decision", {
			id: ctx.channel.id,
			decisionId: card.id,
			revision: 0,
			idempotencyKey: "closed-doc-1",
			optionIds: [q.options[1]!.id],
		});
		expect(res.result?.isError).toBeUndefined();
		expect(res.result?.structuredContent).toMatchObject({
			status: "answered",
			replayed: false,
			decisionId: card.id,
			answers: { [q.id]: "SQLite" },
		});
		expect(ctx.plannerAnswers).toEqual([
			{ channelId: ctx.channel.id, id: card.id, generation: 1 },
		]);

		let reread = await ctx.call("read_document", {
			id: ctx.channel.id,
			decisionStatus: "answered",
		});
		expect(reread.result?.structuredContent).toMatchObject({
			decisionCounts: { answered: 1, open: 0, total: 1 },
			decisions: [{
				id: card.id,
				status: "answered",
				settled: { by: "alice", answers: { [q.id]: "SQLite" } },
			}],
		});
	});
});
