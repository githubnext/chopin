import { afterEach, expect, spyOn, test } from "bun:test";
import { ulid } from "@chopin/dialect";

import { toolbox } from "./tools";
import { Admission } from "../auth/admission";
import { Sessions } from "../auth/session";
import * as Chat from "../chat/service";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Store from "../questions/store";
import { openPlan } from "../testing/plan";

import type { HostedAuth } from "../auth/routes";
import type { SeedState } from "../testing/plan";
import type { Config } from "../config";
import type { Socket } from "../wire";

const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";
const SECOND_WIDGET = "01K0N4X2M5R8T3VQ7YB6ZC4DEF";
const SECOND_QUESTION = "01K0N4Y2M5R8T3VQ7YB6ZC4DEF";
const SECOND_OPTION = "01K0N4Z2M5R8T3VQ7YB6ZC4DEF";
const SOURCE = `# Title

The renderer caches tiles for 60 seconds.

The second paragraph.

<Questionnaire id="${WIDGET}" by="ana" at="2026-07-28T10:14:00.000Z">
<Question id="${QUESTION}" header="Cache" prompt="How long do we cache?" multiple="false">
<Option id="${OPTION}" label="60 seconds" />
<Answer value="60 seconds" />
</Question>
</Questionnaire>
`;
const SECOND_QUESTIONNAIRE =
	`<Questionnaire id="${SECOND_WIDGET}" by="ana" at="2026-07-28T10:14:00.000Z">
<Question id="${SECOND_QUESTION}" header="Scope" prompt="What ships first?" multiple="false">
<Option id="${SECOND_OPTION}" label="Anchors" />
<Answer value="Anchors" />
</Question>
</Questionnaire>
`;

let plans: Awaited<ReturnType<typeof Service.open>>[] = [];

afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
});

async function opened(source: string, state: SeedState = {}) {
	let context = await openPlan(source, state);
	plans.push(context.plan);
	return context;
}

test("create_research_workspace validates one question and waits for the committed draft", async () => {
	let { plan, server } = await opened("Research context.\n");
	let committed = Promise.withResolvers<{
		workspaceId: string;
		state: "draft";
		url: string;
	}>();
	let questions: string[] = [];
	let createResearch = toolbox({
		plan,
		server,
		room: "test",
		persist: () => Service.persist(plan),
		exclusive: action => Service.exclusive(plan, action),
		async publish() {},
		anchors() {},
		changes() {},
		createResearch: question => {
			questions.push(question);
			return committed.promise;
		},
	}).find(tool => tool.name === "create_research_workspace");
	if (!createResearch?.handler) throw new Error("create_research_workspace is missing");
	expect(createResearch.parameters).toEqual({
		type: "object",
		properties: { question: { type: "string", minLength: 1, maxLength: 4_096 } },
		required: ["question"],
		additionalProperties: false,
	});
	let call = async (raw: unknown): Promise<string> => {
		let response = await createResearch.handler!(raw as never, {
			sessionId: "session",
			toolCallId: "call",
			toolName: "create_research_workspace",
			arguments: raw as never,
		});
		if (typeof response !== "string") throw new Error("research tool returned no text");
		return response;
	};

	let question = "Which public release evidence supports adopting version 3?";
	let response = call({ question });
	let settled = false;
	void response.then(() => settled = true);
	await Promise.resolve();
	expect(questions).toEqual([question]);
	expect(settled).toBe(false);
	let result = {
		workspaceId: "workspace-1",
		state: "draft" as const,
		url: "/documents/owner/repo/plan/research/workspace-1",
	};
	committed.resolve(result);
	expect(JSON.parse(await response)).toEqual(result);

	let error = spyOn(console, "error").mockImplementation(() => {});
	try {
		for (
			let invalid of [
				{},
				{ question: "" },
				{ question: 1 },
				{ question: "valid", extra: true },
				{ question: "x".repeat(4_097) },
			]
		) {
			expect(await call(invalid)).toStartWith("Error:");
		}
	} finally {
		error.mockRestore();
	}
	expect(questions).toEqual([question]);
});

test("read_reference accepts only ids made available by the active chat session", async () => {
	let { plan, server } = await opened("Reference context.\n");
	let available = ulid();
	let reads: string[] = [];
	let readReference = toolbox({
		plan,
		server,
		room: "test",
		persist: () => Service.persist(plan),
		exclusive: action => Service.exclusive(plan, action),
		async publish() {},
		anchors() {},
		changes() {},
		readReference: async id => {
			if (id !== available) throw new Error("reference is not available in this Planner session");
			reads.push(id);
			return { id, source: "untrusted" };
		},
	}).find(tool => tool.name === "read_reference");
	if (!readReference?.handler) throw new Error("read_reference is missing");
	let call = (raw: unknown) =>
		readReference.handler!(raw as never, {
			sessionId: "session",
			toolCallId: "call",
			toolName: "read_reference",
			arguments: raw as never,
		});
	let error = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(await call({ id: available })).toContain("untrusted");
		expect(await call({ id: ulid() })).toContain("Error: reference is not available");
		expect(await call({ id: "arbitrary" })).toContain("Error: reference id is invalid");
		expect(await call({ id: available, channelId: "another-room" })).toContain(
			"Error: read_reference accepts only",
		);
	} finally {
		error.mockRestore();
	}
	expect(reads).toEqual([available]);
});

test("anchor_plan publishes moving a decision beside the validated prose", async () => {
	let { plan, server } = await opened(SOURCE, {
		revision: 1,
		questions: [{
			id: WIDGET,
			status: "answered",
			resolver: "ana",
			definition: {
				questions: [{
					id: QUESTION,
					header: "Cache",
					question: "How long do we cache?",
					multiple: false,
					options: [{ id: OPTION, label: "60 seconds", description: "" }],
				}],
			},
			answers: { [QUESTION]: "60 seconds" },
		}],
	});
	let published: unknown[] = [];
	let anchors = 0;
	let anchorPlan = toolbox({
		plan,
		server,
		room: "test",
		persist: () => Service.persist(plan),
		exclusive: action => Service.exclusive(plan, action),
		publish: async mutation => {
			published.push(mutation);
		},
		anchors: () => anchors++,
		changes() {},
	}).find(tool => tool.name === "anchor_plan");
	if (!anchorPlan) throw new Error("anchor_plan is missing");
	if (!anchorPlan.handler) throw new Error("anchor_plan has no handler");
	let digest = room.digests(plan.document)[1]!;

	let args = {
		revision: plan.revision,
		anchors: [{ widget: WIDGET, question: QUESTION, blocks: [{ index: 1, digest }] }],
	};
	let response = await anchorPlan.handler(args, {
		sessionId: "session",
		toolCallId: "call",
		toolName: "anchor_plan",
		arguments: args,
	});
	if (typeof response !== "string") throw new Error("anchor_plan returned no text");
	let result = JSON.parse(response);

	expect(result.ok).toBe(true);
	expect(published).toHaveLength(1);
	expect(anchors).toBe(1);
	let source = room.project(plan.document);
	expect(source.indexOf("The renderer caches tiles for 60 seconds."))
		.toBeLessThan(source.indexOf(`<Questionnaire id="${WIDGET}"`));
	expect(source.indexOf(`<Questionnaire id="${WIDGET}"`))
		.toBeLessThan(source.indexOf("The second paragraph."));
});

test("edit_plan refuses while an implementation claim drains", async () => {
	let { plan, server } = await opened("The plan is ready.\n");
	(plan as typeof plan & { claiming: boolean }).claiming = true;
	let editPlan = toolbox({
		plan,
		server,
		room: "test",
		persist: () => Service.persist(plan),
		exclusive: action => Service.exclusive(plan, action),
		async publish() {},
		anchors() {},
		changes() {},
	}).find(tool => tool.name === "edit_plan");
	if (!editPlan?.handler) throw new Error("edit_plan has no handler");
	let args = {
		revision: plan.revision,
		operations: [{ op: "replace", index: 0, source: "The plan was changed.\n" }],
	};

	let response = await editPlan.handler(args, {
		sessionId: "session",
		toolCallId: "call",
		toolName: "edit_plan",
		arguments: args,
	});

	expect(JSON.parse(response as string)).toEqual({ ok: false, reason: "locked" });
	expect(room.project(plan.document)).toBe("The plan is ready.\n");
});

test("anchor_plan keeps same-block decisions in original ask order", async () => {
	let { plan, server } = await opened(
		SOURCE.replace(
			`<Questionnaire id="${WIDGET}"`,
			`${SECOND_QUESTIONNAIRE}\n<Questionnaire id="${WIDGET}"`,
		),
		{
			revision: 1,
			questions: [
				{
					id: WIDGET,
					status: "answered",
					resolver: "ana",
					definition: {
						questions: [{
							id: QUESTION,
							header: "Cache",
							question: "How long do we cache?",
							multiple: false,
							options: [{ id: OPTION, label: "60 seconds", description: "" }],
						}],
					},
					answers: { [QUESTION]: "60 seconds" },
				},
				{
					id: SECOND_WIDGET,
					status: "answered",
					resolver: "ana",
					definition: {
						questions: [{
							id: SECOND_QUESTION,
							header: "Scope",
							question: "What ships first?",
							multiple: false,
							options: [{ id: SECOND_OPTION, label: "Anchors", description: "" }],
						}],
					},
					answers: { [SECOND_QUESTION]: "Anchors" },
				},
			],
		},
	);
	let anchorPlan = toolbox({
		plan,
		server,
		room: "test",
		persist: () => Service.persist(plan),
		exclusive: action => Service.exclusive(plan, action),
		async publish() {},
		anchors() {},
		changes() {},
	}).find(tool => tool.name === "anchor_plan");
	if (!anchorPlan?.handler) throw new Error("anchor_plan has no handler");
	let digest = room.digests(plan.document)[1]!;
	let args = {
		revision: plan.revision,
		anchors: [
			{ widget: SECOND_WIDGET, question: SECOND_QUESTION, blocks: [{ index: 1, digest }] },
			{ widget: WIDGET, question: QUESTION, blocks: [{ index: 1, digest }] },
		],
	};

	await anchorPlan.handler(args, {
		sessionId: "session",
		toolCallId: "call",
		toolName: "anchor_plan",
		arguments: args,
	});

	let source = room.project(plan.document);
	let prose = source.indexOf("The renderer caches tiles for 60 seconds.");
	let first = source.indexOf(`<Questionnaire id="${WIDGET}"`);
	let second = source.indexOf(`<Questionnaire id="${SECOND_WIDGET}"`);
	expect(prose).toBeLessThan(first);
	expect(first).toBeLessThan(second);
	expect(second).toBeLessThan(source.indexOf("The second paragraph."));
});

test("ask publishes a pending questionnaire beside its validated prose", async () => {
	let published: unknown[] = [];
	let { broadcasts, plan, server } = await opened("Related prose.\n");
	let anchors = 0;
	let created = Promise.withResolvers<void>();
	let ask = toolbox({
		plan,
		server,
		room: "test",
		persist: () => Service.persist(plan),
		exclusive: action => Service.exclusive(plan, action),
		publish: async mutation => {
			published.push(mutation);
		},
		anchors: () => {
			anchors++;
			created.resolve();
		},
		changes() {},
	}).find(tool => tool.name === "ask");
	if (!ask?.handler) throw new Error("ask has no handler");
	let digest = room.digests(plan.document)[0]!;
	let args = {
		revision: plan.revision,
		questions: [{
			header: "Rollout",
			question: "How should we deploy?",
			multiple: false,
			options: [{ label: "Canary", description: "Limit exposure." }],
			blocks: [{ index: 0, digest }],
		}],
	};
	let response = ask.handler(args, {
		sessionId: "session",
		toolCallId: "call",
		toolName: "ask",
		arguments: args,
	});
	await created.promise;

	let source = room.project(plan.document);
	expect(source.indexOf("Related prose.")).toBeLessThan(source.indexOf("<Questionnaire"));
	expect(broadcasts.some(frame => frame.kind === "plan:update")).toBe(true);
	expect(anchors).toBe(1);

	let record = [...plan.records.values()][0]!;
	let claimed = Store.claimCancel(plan.questions, record.id, "test");
	if (!claimed.ok) throw new Error("could not resolve question");
	Store.commit(plan.questions, claimed.claim);
	let result = await response;
	expect(typeof result).toBe("string");
	expect(JSON.parse(result as string).outcomes).toEqual([
		{ status: "cancelled", cancelled_by: "test" },
	]);
});

test("a stale ask does not announce an anchor snapshot", async () => {
	let { plan, server } = await opened("Related prose.\n");
	let anchors = 0;
	let ask = toolbox({
		plan,
		server,
		room: "test",
		persist: () => Service.persist(plan),
		exclusive: action => Service.exclusive(plan, action),
		async publish() {},
		anchors: () => anchors++,
		changes() {},
	}).find(tool => tool.name === "ask");
	if (!ask?.handler) throw new Error("ask has no handler");
	let digest = room.digests(plan.document)[0]!;
	let args = {
		revision: plan.revision + 1,
		questions: [{
			header: "Rollout",
			question: "How should we deploy?",
			multiple: false,
			options: [{ label: "Canary", description: "Limit exposure." }],
			blocks: [{ index: 0, digest }],
		}],
	};

	await ask.handler(args, {
		sessionId: "session",
		toolCallId: "call",
		toolName: "ask",
		arguments: args,
	});

	expect(plan.records.size).toBe(0);
	expect(anchors).toBe(0);
});

test("ask refuses to create a questionnaire while implementation is active", async () => {
	let { plan, server } = await opened("Related prose.\n");
	let anchors = 0;
	let ask = toolbox({
		plan,
		server,
		room: "test",
		persist: () => Service.persist(plan),
		exclusive: action => Service.exclusive(plan, action),
		async publish() {},
		anchors: () => anchors++,
		changes() {},
	}).find(tool => tool.name === "ask");
	if (!ask?.handler) throw new Error("ask is missing");
	let digest = room.digests(plan.document)[0]!;
	let args = {
		revision: plan.revision,
		questions: [{
			header: "Rollout",
			question: "How should we deploy?",
			multiple: false,
			options: [{ label: "Canary", description: "Limit exposure." }],
			blocks: [{ index: 0, digest }],
		}],
	};
	plan.execution = { id: "run-1" } as never;

	let response = await ask.handler(args, {
		sessionId: "session",
		toolCallId: "call",
		toolName: "ask",
		arguments: args,
	});

	expect(JSON.parse(response as string)).toEqual({ ok: false, reason: "locked" });
	expect(plan.records.size).toBe(0);
	expect(anchors).toBe(0);
});

test("planner graph edits draft a revision without changing plan prose", async () => {
	let { plan, server } = await opened("Prepare the implementation.\n");
	// The graph tool is called from inside the planner turn that `chat:send`
	// started. That turn is busy by definition; readiness must not mistake it
	// for a competing request.
	plan.chat.busy = true;
	plan.chat.turn = { id: "turn", handle: "ana", started: 1, responded: false };
	let before = room.project(plan.document);
	let graph = toolbox({
		plan,
		server,
		room: "test",
		persist: () => Service.persist(plan),
		exclusive: action => Service.exclusive(plan, action),
		async publish() {},
		anchors() {},
		changes() {},
	}).find(tool => tool.name === "edit_implementation_graph");
	if (!graph?.handler) throw new Error("edit_implementation_graph is missing");
	let args = {
		plan_revision: plan.revision,
		graph_revision: 0,
		operations: [{
			op: "add",
			task: {
				id: "graph-tools",
				title: "Give the planner constrained graph tools",
				context: "The shared plan is ready for implementation preparation.",
				goal: "Create a draft implementation graph beside the plan.",
				acceptance: [
					"A draft graph is stored against the plan revision.",
					"The planner does not change plan.mdx.",
				],
				dependsOn: [],
			},
		}],
	};
	let response = await graph.handler(args, {
		sessionId: "session",
		toolCallId: "call",
		toolName: "edit_implementation_graph",
		arguments: args,
	});
	if (typeof response !== "string") throw new Error("graph tool returned no text");

	expect(JSON.parse(response)).toMatchObject({
		ok: true,
		graph: { versions: [{ state: "draft", planRevision: plan.revision }] },
	});
	expect(plan.graph?.versions[0]?.definition.tasks.map(task => task.id)).toEqual(["graph-tools"]);
	expect(room.project(plan.document)).toBe(before);

	let stale = await graph.handler({ ...args, graph_revision: 0 }, {
		sessionId: "session",
		toolCallId: "later",
		toolName: "edit_implementation_graph",
		arguments: args,
	});
	expect(JSON.parse(stale as string)).toEqual({ ok: false, reason: "stale-graph" });
	expect(room.project(plan.document)).toBe(before);
});

test("chat-started tools retain only the current member request provenance", async () => {
	let { plan, server, storage, channel } = await opened("Prepare the implementation.\n");
	let now = new Date();
	let tools = toolbox({
		plan,
		server,
		room: "test",
		persist: () => Service.persist(plan),
		exclusive: action => Service.exclusive(plan, action),
		async publish() {},
		anchors() {},
		changes() {},
	});
	let graph = tools.find(tool => tool.name === "edit_implementation_graph");
	if (!graph?.handler) throw new Error("edit_implementation_graph is missing");
	let args = {
		plan_revision: plan.revision,
		graph_revision: 0,
		operations: [{
			op: "add",
			task: {
				id: "chat-graph",
				title: "Draft from the chat turn",
				context: "The planner turn began from the room conversation.",
				goal: "Create a graph while the planner is busy.",
				acceptance: ["The graph is drafted.", "The chat turn can complete."],
				dependsOn: [],
			},
		}],
	};
	let response: string | undefined;
	let event: ((value: { type: string }) => void) | undefined;
	let firstStarted = Promise.withResolvers<void>();
	let continueFirst = Promise.withResolvers<void>();
	let sent = Promise.withResolvers<void>();
	let activeRequests: Array<Chat.ActiveMemberRequest | undefined> = [];
	let researchRequests: Array<Parameters<NonNullable<Chat.Room["createResearch"]>>[0]> = [];
	let researchResponses: string[] = [];
	let researchTool: ReturnType<typeof Chat.planTools>[number] | undefined;
	plan.chat.agent = {
		id: "session",
		session: {
			on(listener: (value: { type: string }) => void) {
				event = listener;
				return () => {};
			},
			async send() {
				let active = plan.chat.activeRequest;
				activeRequests.push(active ? { ...active } : undefined);
				let turn = activeRequests.length;
				if (turn === 1) {
					firstStarted.resolve();
					await continueFirst.promise;
					let result = await graph.handler!(args, {
						sessionId: "session",
						toolCallId: "call",
						toolName: "edit_implementation_graph",
						arguments: args,
					});
					if (typeof result !== "string") throw new Error("graph tool returned no text");
					response = result;
				} else {
					if (!researchTool?.handler) throw new Error("research tool is missing");
					let question = "Which public release evidence supports adopting version 3?";
					let attempts = turn === 2 ? 2 : 1;
					for (let attempt = 0; attempt < attempts; attempt++) {
						let result = await researchTool.handler({ question }, {
							sessionId: "session",
							toolCallId: `research-${turn}-${attempt}`,
							toolName: "create_research_workspace",
							arguments: { question },
						});
						if (typeof result !== "string") throw new Error("research tool returned no text");
						researchResponses.push(result);
					}
				}
				event?.({ type: "session.idle" });
				if (turn === 3) sent.resolve();
			},
			async abort() {},
			async disconnect() {},
		} as never,
	};
	let key = new Uint8Array(32).fill(7);
	let sessions = new Sessions(storage, true, () => now);
	let claimant = await sessions.issue("U_test", {
		accessToken: "gho_test",
		accessExpiresIn: 28_800,
		refreshToken: "ghr_test",
		refreshExpiresIn: 15_897_600,
	});
	let queuedClaimant = await sessions.issue("U_test", {
		accessToken: "gho_queued",
		accessExpiresIn: 28_800,
		refreshToken: "ghr_queued",
		refreshExpiresIn: 15_897_600,
	});
	let repository = { id: "R_test", owner: "owner", name: "repository", defaultBranch: "main" };
	let config = {
		origin: "https://test",
		appSlug: "chopin-test",
		clientId: "id",
		clientSecret: "secret",
		encryptionKey: key,
	};
	let github = {
		async repositoryAccess() {
			return {
				...repository,
				fullName: "owner/repository",
				private: true,
				url: "",
				permissions: { pull: true, push: true, admin: false },
			};
		},
	} as never;
	let auth: HostedAuth = {
		config,
		storage,
		github,
		admission: new Admission(config, github, () => now.getTime()),
		sessions,
		clock: () => now,
	};
	let ownership = await Chat.resolveOwner(auth, repository, channel.id, claimant.id);
	plan.chat.owner = {
		sessionId: claimant.id,
		generation: ownership.ownership.generation,
		revision: ownership.owner.access.revision,
		expiresAt: Math.min(
			ownership.owner.access.expiresAt.getTime(),
			ownership.owner.session.expiresAt.getTime(),
		),
	};
	let context: Chat.Room = {
		chat: plan.chat,
		plan,
		server,
		room: channel.id,
		config: { agent: true } as Config,
		auth,
		claimantSessionId: claimant.id,
		repository,
		persist: () => Service.persist(plan),
		createResearch: async request => {
			researchRequests.push(request);
			return {
				workspaceId: "workspace-1",
				state: "draft",
				url: "/documents/owner/repository/plan/research/workspace-1",
			};
		},
	};
	researchTool = Chat.planTools(context).find(tool => tool.name === "create_research_workspace");

	await Chat.send(
		context,
		{ data: { handle: "ana", principalId: "U_test" }, send() {} } as unknown as Socket,
		{
			kind: "chat:send",
			rid: "request",
			requestId: crypto.randomUUID(),
			text: "prepare implementation",
			to: "planner",
			ts: 0,
		},
	);
	let running = plan.chat.running;
	await firstStarted.promise;
	let queuedContext = { ...context, claimantSessionId: queuedClaimant.id };
	await Chat.send(
		queuedContext,
		{ data: { handle: "bob", principalId: "U_bob" }, send() {} } as unknown as Socket,
		{
			kind: "chat:send",
			rid: "queued",
			requestId: crypto.randomUUID(),
			text: "@chopin start research on version 3 adoption",
			to: "planner",
			ts: 0,
		},
	);
	let queuedEntryId = plan.chat.waiting[0]!.id;
	await Chat.instruct(
		context,
		"ana",
		"Act on the accepted comment.",
		"@ana accepted a comment.",
	);
	let error = spyOn(console, "error").mockImplementation(() => {});
	continueFirst.resolve();
	await sent.promise;
	await running;
	if (!researchTool?.handler) throw new Error("research tool is missing");
	let stale = await researchTool.handler({ question: "Search again" }, {
		sessionId: "session",
		toolCallId: "research-stale",
		toolName: "create_research_workspace",
		arguments: { question: "Search again" },
	});
	if (typeof stale !== "string") throw new Error("research tool returned no text");
	researchResponses.push(stale);
	error.mockRestore();

	expect(JSON.parse(response ?? "")).toMatchObject({
		ok: true,
		graph: { versions: [{ state: "draft", planRevision: 0 }] },
	});
	expect(plan.graph?.versions[0]?.definition.tasks.map(task => task.id)).toEqual(["chat-graph"]);
	expect(activeRequests).toHaveLength(3);
	expect(activeRequests[0]).toMatchObject({
		entryId: plan.chat.entries.find(entry => entry.text === "prepare implementation")?.id,
		userId: "U_test",
		handle: "ana",
		text: "prepare implementation",
		claimantSessionId: claimant.id,
		lifecycle: 0,
	});
	expect(activeRequests[1]).toMatchObject({
		entryId: queuedEntryId,
		userId: "U_bob",
		handle: "bob",
		text: "start research on version 3 adoption",
		claimantSessionId: queuedClaimant.id,
		lifecycle: 0,
	});
	expect(activeRequests[0]?.turnId).not.toBe(activeRequests[1]?.turnId);
	expect(activeRequests[2]).toBeUndefined();
	expect(researchRequests).toEqual([
		{
			entryId: queuedEntryId,
			userId: "U_bob",
			handle: "bob",
			text: "start research on version 3 adoption",
			question: "Which public release evidence supports adopting version 3?",
		},
		{
			entryId: queuedEntryId,
			userId: "U_bob",
			handle: "bob",
			text: "start research on version 3 adoption",
			question: "Which public release evidence supports adopting version 3?",
		},
	]);
	expect(researchResponses.slice(0, 2).map(value => JSON.parse(value))).toEqual([
		expect.objectContaining({ workspaceId: "workspace-1", state: "draft" }),
		expect.objectContaining({ workspaceId: "workspace-1", state: "draft" }),
	]);
	expect(researchResponses[2]).toContain(
		"Error: research workspaces require the explicit member message",
	);
	expect(researchResponses[3]).toContain(
		"Error: research workspaces require the explicit member message",
	);
	expect(plan.chat.activeRequest).toBeUndefined();
});

test("planner graph edits name readiness blockers before changing a graph", async () => {
	let { plan, server } = await opened("Prepare the implementation.\n");
	plan.records.set("open", {
		id: "open",
		status: "open",
		definition: {
			questions: [{
				id: "question",
				header: "Readiness",
				question: "May implementation begin?",
				multiple: false,
				options: [{ id: "yes", label: "Yes", description: "" }],
			}],
		},
	} as never);
	let graph = toolbox({
		plan,
		server,
		room: "test",
		persist: () => Service.persist(plan),
		exclusive: action => Service.exclusive(plan, action),
		async publish() {},
		anchors() {},
		changes() {},
	}).find(tool => tool.name === "edit_implementation_graph");
	if (!graph?.handler) throw new Error("edit_implementation_graph is missing");
	let args = {
		plan_revision: plan.revision,
		graph_revision: 0,
		operations: [{
			op: "add",
			task: {
				id: "blocked",
				title: "Blocked graph",
				context: "The plan still has an open decision.",
				goal: "Demonstrate that preparation is refused.",
				acceptance: ["The tool names the blocker.", "No graph is created."],
				dependsOn: [],
			},
		}],
	};
	let response = await graph.handler(args, {
		sessionId: "session",
		toolCallId: "call",
		toolName: "edit_implementation_graph",
		arguments: args,
	});

	expect(JSON.parse(response as string)).toEqual({
		ok: false,
		reason: "not-ready",
		blockers: ["unanswered questionnaires"],
	});
	expect(plan.graph).toBeUndefined();
});
