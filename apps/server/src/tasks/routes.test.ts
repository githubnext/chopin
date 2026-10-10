import { expect, test } from "bun:test";
import { Sessions } from "../auth/session";
import { Admission } from "../auth/admission";
import { Router } from "../http/router";
import { openPlan, openSiblingPlan } from "../testing/plan";
import * as Plan from "../plan/service";
import { registerExperimentRoutes } from "../experiments/routes";
import { implementationGraphs } from "./plan-graphs";
import { registerImplementationRoutes } from "./routes";
import { queueRebuild, requestBuild } from "./builds";
import { implementationStatus } from "./notifications";
import type { GitHub } from "../github/client";
import type { HostedAuth } from "../auth/routes";

let checkout = { repository: "owner/repository", branch: "main", commit: "a".repeat(40) };
async function prepare(plan: Plan.Plan) {
	await implementationGraphs().revise(plan, {
		planRevision: 0,
		graphRevision: 0,
		operations: [{
			op: "add",
			task: {
				id: "first",
				title: "First",
				context: "Tracer",
				goal: "Launch",
				acceptance: ["Starts", "Reports"],
				dependsOn: [],
			},
		}],
	});
}

async function setup() {
	let context = await openPlan("# Launcher plan\n");
	let github = {
		async user(token: string) {
			return { id: token === "other" ? "U_other" : "U_test", login: "test", avatarUrl: "" };
		},
		async repository(token: string) {
			return {
				id: "R_test",
				owner: "owner",
				name: "repository",
				fullName: checkout.repository,
				defaultBranch: "main",
				private: true,
				url: "https://github.test",
				permissions: { pull: true, push: token !== "readonly", admin: false },
			};
		},
		async repositoryAccess(token: string) {
			return github.repository(token, "owner", "repository");
		},
	} as unknown as GitHub;
	let config = {
		origin: "https://chopin.test",
		appSlug: "chopin",
		clientId: "test",
		clientSecret: "test",
		encryptionKey: new Uint8Array(32).fill(4),
	};
	let sessions = new Sessions(context.storage, true, () => context.now);
	await context.storage.users.put({
		id: "U_other",
		login: "other",
		avatarUrl: "",
		now: context.now,
	});
	let other = await sessions.issue("U_other", {
		accessToken: "other",
		accessExpiresIn: 28_800,
		refreshToken: "refresh",
		refreshExpiresIn: 15_897_600,
	});
	let issued = await sessions.issue("U_test", {
		accessToken: "test",
		accessExpiresIn: 28_800,
		refreshToken: "refresh",
		refreshExpiresIn: 15_897_600,
	});
	let auth: HostedAuth = {
		config,
		github,
		sessions,
		storage: context.storage,
		admission: new Admission(config, github, () => context.now.getTime()),
		clock: () => context.now,
	};
	let router = new Router();
	let implementations: ReturnType<typeof registerImplementationRoutes>;
	let experiments = registerExperimentRoutes(router, auth, {
		lease: () => context.lease,
		changed: () => {},
		context: async () => ({ source: "# Launcher plan", revision: 0 }),
		implementations: () => implementations,
	});
	implementations = registerImplementationRoutes(router, auth, {
		connections: experiments.connections,
		busy: async connectionId =>
			(await experiments.service.store.active()).some(item =>
				item.connectionId === connectionId && ["running", "publishing"].includes(item.state)
			),
		withPlan: async (id, action) => {
			let plan = plans.get(id);
			if (!plan) throw new Error("document is unavailable");
			return action(plan);
		},
	});
	let plans = new Map([[context.plan.id, context.plan]]);
	await prepare(context.plan);
	let path = `/api/channels/${context.plan.id}/implementation`;
	let call = async (
		url: string,
		value?: unknown,
		token?: string,
		origin = config.origin,
		cookie = issued.cookie,
	) => {
		let response = await router.handle(
			new Request(config.origin + url, {
				method: value ? "POST" : "GET",
				headers: {
					origin,
					cookie: cookie.split(";")[0],
					...(token ? { authorization: `Bearer ${token}` } : {}),
				},
				...(value ? { body: JSON.stringify(value) } : {}),
			}),
		);
		if (!response) throw new Error("missing route");
		return response;
	};
	return {
		...context,
		auth,
		router,
		path,
		call,
		cookie: issued.cookie,
		otherCookie: other.cookie,
		implementations,
		experiments,
		plans,
	};
}

async function paired(context: Awaited<ReturnType<typeof setup>>, cookie?: string) {
	let pairing =
		await (await context.call("/api/connector/pairings", { ...checkout, label: "Laptop" })).json();
	await context.call(
		`/api/connector/pairings/${pairing.id}/approve`,
		{},
		undefined,
		undefined,
		cookie,
	);
	return (await context.call(`/api/connector/pairings/${pairing.id}/claim`, {
		secret: pairing.secret,
	})).json();
}
async function tool(
	context: Awaited<ReturnType<typeof setup>>,
	token: string,
	name: string,
	args: unknown = {},
) {
	let response = await context.call("/connector/mcp", {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name, arguments: args },
	}, token);
	let result = (await response.json()).result;
	return result.isError ? result : JSON.parse(result.content[0].text);
}

test("a paired workspace claims a browser build once and reports through run-scoped MCP", async () => {
	let context = await setup();
	let connection = await paired(context);
	let snapshot = await (await context.call(context.path)).json();
	expect(snapshot.localAgent).toBe(true);
	expect(JSON.stringify(snapshot)).not.toContain("Laptop");
	let review = {
		planRevision: 0,
		graphVersion: 1,
		graphRevision: 1,
	};
	expect((await context.call(context.path, review, undefined, "https://untrusted.test")).status)
		.toBe(403);
	let built = await (await context.call(context.path, review)).json();
	expect(built.state).toBe("queued");
	expect((await (await context.call(context.path, review)).json()).id).toBe(built.id);
	expect((await (await context.call(context.path)).json()).startedBy).toBe("test");
	expect(await tool(context, connection.token, "wait_for_work")).toEqual({
		id: built.id,
		kind: "implementation",
	});
	let claim = await tool(context, connection.token, "claim_implementation_build", { id: built.id });
	expect(claim.build.id).toBe(built.id);
	expect(claim.live).toBe(false);
	expect(
		(await tool(context, connection.token, "claim_implementation_build", { id: built.id })).isError,
	).toBe(true);
	await tool(context, connection.token, "report_implementation_build", {
		id: built.id,
		state: "running",
		session: "acp-session",
	});
	let read = await tool(context, claim.runToken, "read_implementation");
	expect(read.document.source).toContain("Launcher plan");
	expect(read.graph.number).toBe(1);
	expect(read.run.id).toBe(built.id);
	await tool(context, claim.runToken, "start_task", {
		taskId: "first",
		idempotencyKey: "start-first",
	});
	await tool(context, claim.runToken, "block_task", {
		taskId: "first",
		idempotencyKey: "block-first",
		reason: "Choose the next tracer",
	});
	expect((await tool(context, claim.runToken, "claim_experiment", { id: built.id })).isError).toBe(
		true,
	);
	expect(
		(await tool(context, claim.runToken, "start_task", {
			id: "foreign",
			taskId: "first",
			idempotencyKey: "foreign",
		})).isError,
	).toBe(true);
	await tool(context, connection.token, "report_implementation_build", {
		id: built.id,
		state: "stopped",
	});
	snapshot = await (await context.call(context.path)).json();
	expect(snapshot.build.session).toBe("acp-session");
	expect(snapshot.lifecycle.activity.tasks[0].blocker).toBe("Choose the next tracer");
	expect((await tool(context, claim.runToken, "read_implementation")).isError).toBe(true);
	await Plan.close(context.plan);
});

test("a run's parallel lifecycle batch lands in order and refusals say what to do next", async () => {
	let context = await setup();
	let connection = await paired(context);
	let built = await (await context.call(context.path, {
		planRevision: 0,
		graphVersion: 1,
		graphRevision: 1,
	})).json();
	let claim = await tool(context, connection.token, "claim_implementation_build", { id: built.id });
	await tool(context, connection.token, "report_implementation_build", {
		id: built.id,
		state: "running",
		session: "acp-session",
	});
	let pr = "https://github.com/owner/repository/pull/7";
	// The agent sends the whole batch at once; complete_task arrives before report_pr.
	let results = await Promise.all([
		tool(context, claim.runToken, "complete_task", {
			taskId: "first",
			summary: "Done.",
			idempotencyKey: "complete-first",
		}),
		tool(context, claim.runToken, "report_pr", {
			taskId: "first",
			url: pr,
			state: "open",
			idempotencyKey: "pr-first",
		}),
		tool(context, claim.runToken, "start_task", { taskId: "first", idempotencyKey: "start-first" }),
	]);
	expect(results.map(result => result.isError)).toEqual([undefined, undefined, undefined]);
	let snapshot = await (await context.call(context.path)).json();
	expect(snapshot.lifecycle.activity.tasks[0]).toMatchObject({ state: "completed" });
	let refused = await tool(context, claim.runToken, "start_task", {
		taskId: "first",
		idempotencyKey: "start-again",
	});
	expect(refused.content[0].text).toContain(
		"task-state: The task is already in progress or completed",
	);
	await Plan.close(context.plan);
});

test("a build runs only on the clicker's own connection and records who started it", async () => {
	let context = await setup();
	let foreign = await paired(context, context.otherCookie);
	let review = {
		planRevision: 0,
		graphVersion: 1,
		graphRevision: 1,
	};
	let refused = await context.call(context.path, review);
	expect(refused.status).toBe(409);
	expect((await refused.json()).error).toBe("no-workspace");
	expect((await (await context.call(context.path)).json()).localAgent).toBe(false);
	expect(context.plan.builds).toEqual([]);
	expect(context.plan.graph?.versions[0].state).toBe("draft");
	let own = await paired(context);
	expect((await context.call(context.path, { ...review, planRevision: 1 })).status).toBe(409);
	let built = await (await context.call(context.path, review)).json();
	expect(built.connectionId).toBe(own.connection.id);
	expect(built.connectionId).not.toBe(foreign.connection.id);
	expect(built.user).toBe("U_test");
	expect(built.checkout).toEqual(checkout);
	expect(
		(await tool(context, foreign.token, "claim_implementation_build", { id: built.id })).isError,
	)
		.toBe(true);
	await Plan.close(context.plan);
});

test("a one-click build request outlives a reload until its build starts or is cancelled", async () => {
	let context = await setup();
	let cancel = () =>
		context.router.handle(
			new Request(`${context.auth.config.origin}${context.path}/request`, {
				method: "DELETE",
				headers: { origin: context.auth.config.origin, cookie: context.cookie.split(";")[0] },
			}),
		);
	try {
		expect((await (await context.call(context.path)).json()).buildRequested).toBeUndefined();
		requestBuild(context.plan, "U_test");
		expect((await (await context.call(context.path)).json()).buildRequested).toEqual({
			by: "U_test",
			revision: context.plan.revision,
		});
		expect((await cancel())!.status).toBe(200);
		expect(context.plan.buildRequested).toBeUndefined();
		requestBuild(context.plan, "U_test");
		await paired(context);
		let built = await context.call(context.path, {
			planRevision: 0,
			graphVersion: 1,
			graphRevision: 1,
		});
		expect(built.status).toBe(200);
		expect((await (await context.call(context.path)).json()).buildRequested).toBeUndefined();
	} finally {
		await Plan.close(context.plan);
	}
});

test("investigations and implementations cannot execute on the same workspace together", async () => {
	let context = await setup();
	let connection = await paired(context);
	let investigation = await (await context.call(`/api/documents/${context.plan.id}/experiments`, {
		id: crypto.randomUUID(),
		brief: "Inspect a fixture",
	})).json();
	await context.call(`/api/documents/${context.plan.id}/experiments/${investigation.id}/run`, {});
	let build = await (await context.call(context.path, {
		planRevision: 0,
		graphVersion: 1,
		graphRevision: 1,
	})).json();
	await tool(context, connection.token, "claim_implementation_build", { id: build.id });
	expect(
		(await tool(context, connection.token, "claim_experiment", { id: investigation.id })).isError,
	).toBe(true);
	await tool(context, connection.token, "report_implementation_build", {
		id: build.id,
		state: "failed",
		error: "Stopped before session",
	});
	expect(
		(await tool(context, connection.token, "claim_experiment", { id: investigation.id }))
			.generation,
	).toBe(1);
	await Plan.close(context.plan);
});

test("disconnect reconciles a pending build without automatic replay", async () => {
	let context = await setup();
	let connection = await paired(context);
	await context.call(context.path, {
		planRevision: 0,
		graphVersion: 1,
		graphRevision: 1,
	});
	await tool(context, connection.token, "disconnect_workspace");
	await context.implementations.sweep();
	expect(context.plan.builds[0].state).toBe("failed");
	expect(Plan.implementationActive(context.plan)).toBe(false);
	expect(context.plan.execution).toBeUndefined();
	await Plan.close(context.plan);
});

test("a deleted document cannot block implementation recovery sweeps", async () => {
	let context = await setup();
	let connection = await paired(context);
	await context.call(context.path, {
		planRevision: 0,
		graphVersion: 1,
		graphRevision: 1,
	});
	context.experiments.connections.revoke(connection.connection.id);
	await Plan.close(context.plan);
	await context.storage.channels.archive({ id: context.plan.id, now: context.now });
	await context.storage.channels.delete(context.plan.id);
	await expect(context.implementations.sweep()).resolves.toBeUndefined();
	await expect(context.implementations.sweep()).resolves.toBeUndefined();
});

test("Build queues behind a running prototype and starts once it finishes", async () => {
	let context = await setup();
	let connection = await paired(context);
	let investigation = await (await context.call(`/api/documents/${context.plan.id}/experiments`, {
		id: crypto.randomUUID(),
		brief: "Inspect a fixture",
	})).json();
	await context.call(`/api/documents/${context.plan.id}/experiments/${investigation.id}/run`, {});
	await tool(context, connection.token, "claim_experiment", { id: investigation.id });
	let response = await context.call(context.path, {
		planRevision: 0,
		graphVersion: 1,
		graphRevision: 1,
	});
	expect(response.status).toBe(200);
	let build = await response.json();
	expect(build.state).toBe("queued");
	let snapshot = await (await context.call(context.path)).json();
	expect(snapshot).toMatchObject({ build: { id: build.id }, waitingForPrototype: true });
	expect(await tool(context, connection.token, "claim_implementation_build", { id: build.id }))
		.toMatchObject({ isError: true });
	// A prototype outlasting the pickup window keeps the build queued rather than failing it.
	context.plan.builds = [{ ...context.plan.builds.at(-1)!, expiresAt: Date.now() - 1 }];
	await context.implementations.sweep();
	expect(context.plan.builds.at(-1)).toMatchObject({ id: build.id, state: "queued" });
	expect(context.plan.builds.at(-1)!.expiresAt).toBeGreaterThan(Date.now());
	await context.experiments.service.stop(investigation.id, "interrupted", "Finished.");
	expect((await (await context.call(context.path)).json()).waitingForPrototype).toBeUndefined();
	expect(await tool(context, connection.token, "wait_for_work"))
		.toEqual({ id: build.id, kind: "implementation" });
	expect(
		(await tool(context, connection.token, "claim_implementation_build", { id: build.id })).build,
	).toMatchObject({ id: build.id, state: "starting" });
	await Plan.close(context.plan);
});

test("a committed build wakes the waiting connector and a failed pickup can be retried", async () => {
	let context = await setup();
	let connection = await paired(context);
	let abort = new AbortController();
	try {
		let woken = false;
		let waiting = context.experiments.connections.wait("R_test", abort.signal)
			.then(() => woken = true);
		let review = {
			planRevision: 0,
			graphVersion: 1,
			graphRevision: 1,
		};
		let built = await (await context.call(context.path, review)).json();
		expect(woken).toBe(true);
		await waiting;
		await tool(context, connection.token, "claim_implementation_build", { id: built.id });
		await tool(context, connection.token, "report_implementation_build", {
			id: built.id,
			state: "failed",
			error: "Startup failed",
		});
		let retry = { ...review, retryOf: built.id };
		let next = await (await context.call(context.path, retry)).json();
		expect(next.id).not.toBe(built.id);
		expect(next.state).toBe("queued");
		expect((await (await context.call(context.path, retry)).json()).id).toBe(next.id);
	} finally {
		abort.abort();
		await Plan.close(context.plan);
	}
});

test("returning a stopped implementation for changes durably unlocks it once", async () => {
	let context = await setup();
	let connection = await paired(context);
	try {
		let built = await (await context.call(context.path, {
			planRevision: 0,
			graphVersion: 1,
			graphRevision: 1,
		})).json();
		await tool(context, connection.token, "claim_implementation_build", { id: built.id });
		await tool(context, connection.token, "report_implementation_build", {
			id: built.id,
			state: "running",
			session: "session",
		});
		let input = { buildId: built.id, reason: "Resolve the missing design decision" };
		expect((await context.call(`${context.path}/revise`, input)).status).toBe(409);
		await tool(context, connection.token, "report_implementation_build", {
			id: built.id,
			state: "stopped",
		});
		expect(
			(await context.call(`${context.path}/revise`, input, undefined, "https://other.test")).status,
		)
			.toBe(403);
		let commit = context.storage.collaboration.commit;
		context.storage.collaboration.commit = async () => {
			throw new Error("offline");
		};
		expect((await context.call(`${context.path}/revise`, input)).status).toBe(409);
		expect(Plan.implementationActive(context.plan)).toBe(true);
		context.storage.collaboration.commit = commit;
		expect((await context.call(`${context.path}/revise`, input)).status).toBe(200);
		expect((await context.call(`${context.path}/revise`, input)).status).toBe(200);
		expect(Plan.implementationActive(context.plan)).toBe(false);
		expect(context.plan.execution).toBeUndefined();
		expect(context.plan.lifecycle.history).toHaveLength(1);
		expect(context.plan.lifecycle.history[0].events.at(-1)?.kind).toBe("request_revision");
	} finally {
		await Plan.close(context.plan);
	}
});

test("a second document queues behind the first on one connection, which a finished or deleted build never strands", async () => {
	let context = await setup();
	let second = await openSiblingPlan(context, "# Second plan\n");
	await prepare(second);
	context.plans.set(second.id, second);
	let secondPath = `/api/channels/${second.id}/implementation`;
	let review = { planRevision: 0, graphVersion: 1, graphRevision: 1 };
	let connection = await paired(context);
	try {
		let first = await (await context.call(context.path, review)).json();
		// The agent holds the first document's build, so the second queues behind it.
		let waiting = await context.call(secondPath, review);
		expect(waiting.status).toBe(200);
		let next = await waiting.json();
		expect(next).toMatchObject({ state: "queued", connectionId: connection.connection.id });
		expect((await context.call(secondPath, review)).status).toBe(200);
		expect(second.builds).toHaveLength(1);
		let title = (await context.storage.channels.get(context.plan.id))!.title;
		expect((await (await context.call(secondPath)).json()).waitingForDocument).toEqual({ title });
		// Waiting behind another build renews the queued one instead of expiring it.
		second.builds = [{ ...second.builds[0]!, expiresAt: Date.now() - 1 }];
		await context.implementations.sweep();
		expect(second.builds.at(-1)).toMatchObject({ state: "queued" });
		expect(second.builds.at(-1)!.expiresAt).toBeGreaterThan(Date.now());
		expect(await tool(context, connection.token, "wait_for_work")).toEqual({
			id: first.id,
			kind: "implementation",
		});
		await tool(context, connection.token, "claim_implementation_build", { id: first.id });
		await tool(context, connection.token, "report_implementation_build", {
			id: first.id,
			state: "failed",
			error: "Startup failed",
		});
		expect(second.builds.at(-1)?.id).toBe(next.id);
		expect(context.plan.builds).toHaveLength(1);
		expect(await tool(context, connection.token, "wait_for_work")).toEqual({
			id: next.id,
			kind: "implementation",
		});
		expect((await (await context.call(secondPath)).json()).waitingForDocument).toBeUndefined();
		let claim = await tool(context, connection.token, "claim_implementation_build", {
			id: next.id,
		});
		expect(claim.documentId).toBe(second.id);
		await tool(context, connection.token, "report_implementation_build", {
			id: next.id,
			state: "running",
			session: "acp-session",
		});
		expect((await tool(context, claim.runToken, "read_implementation")).document.id).toBe(
			second.id,
		);

		// Deleting the document under a queued build must not break pickup or a new build.
		await tool(context, connection.token, "report_implementation_build", {
			id: next.id,
			state: "stopped",
		});
		let third = await openSiblingPlan(context, "# Third plan\n");
		await prepare(third);
		context.plans.set(third.id, third);
		let thirdPath = `/api/channels/${third.id}/implementation`;
		let queued = await (await context.call(thirdPath, review)).json();
		expect(queued.state).toBe("queued");
		await Plan.close(third);
		context.plans.delete(third.id);
		await context.storage.channels.archive({ id: third.id, now: context.now });
		await context.storage.channels.delete(third.id);
		let snapshot = await context.call(context.path);
		expect(snapshot.status).toBe(200);
		expect((await snapshot.json()).localAgent).toBe(true);
		let investigation = await (await context.call(
			`/api/documents/${context.plan.id}/experiments`,
			{ id: crypto.randomUUID(), brief: "Still reachable" },
		)).json();
		let run = await context.call(
			`/api/documents/${context.plan.id}/experiments/${investigation.id}/run`,
			{},
		);
		expect(run.status).toBe(200);
		expect((await run.json()).connectionId).toBe(connection.connection.id);
		expect(await tool(context, connection.token, "wait_for_work")).toEqual({
			id: investigation.id,
			kind: "experiment",
		});
	} finally {
		await Plan.close(second);
		await Plan.close(context.plan);
	}
});

const pullRequest = "https://github.com/owner/repository/pull/7";

function edit(plan: Plan.Plan, text: string) {
	let next = `${Plan.source(plan).trimEnd()}\n\n${text}\n`;
	return Plan.rewrite(plan, next, (source, revision) => ({
		idempotencyKey: crypto.randomUUID(),
		fingerprint: text,
		fromRevision: plan.revision,
		client: { name: "test", version: "1" },
		document: { source, revision, title: "Launcher plan", url: "https://chopin.test" },
	}));
}

/** Deliver a live build, edit the document, then queue and start a rebuild of that edit. */
async function rebuilding() {
	let context = await setup();
	context.plan.persistence.liveBuild = true;
	let stopped: string[] = [];
	context.plan.persistence.onBuildStopped = id => stopped.push(id);
	let connection = await paired(context);
	let built = await (await context.call(context.path, {
		planRevision: 0,
		graphVersion: 1,
		graphRevision: 1,
	})).json();
	let claim = await tool(context, connection.token, "claim_implementation_build", { id: built.id });
	// The connector gives a living document's first build a prompt that ends at complete_task.
	expect(claim.live).toBe(true);
	await tool(context, connection.token, "report_implementation_build", {
		id: built.id,
		state: "running",
		session: "session",
	});
	for (
		let [name, args] of [
			["start_task", { taskId: "first", idempotencyKey: "start" }],
			["report_pr", { taskId: "first", idempotencyKey: "pr", url: pullRequest, state: "open" }],
			["complete_task", { taskId: "first", idempotencyKey: "done", summary: "Launched" }],
		] as const
	) expect((await tool(context, claim.runToken, name, args)).isError).toBeUndefined();
	await tool(context, connection.token, "report_implementation_build", {
		id: built.id,
		state: "stopped",
	});
	let builtSource = context.plan.live!.baseSource;
	expect((await edit(context.plan, "A rebuilt paragraph.")).ok).toBe(true);
	let target = Plan.source(context.plan);
	let queued = await queueRebuild(context.plan, context.experiments.connections);
	if (queued.kind !== "queued") throw new Error(`rebuild was ${queued.kind}`);
	expect(await tool(context, connection.token, "wait_for_work")).toEqual({
		id: queued.build.id,
		kind: "implementation",
	});
	let rebuild = await tool(context, connection.token, "claim_implementation_build", {
		id: queued.build.id,
	});
	expect(rebuild.build.kind).toBe("rebuild");
	expect(rebuild.live).toBe(false);
	await tool(context, connection.token, "report_implementation_build", {
		id: queued.build.id,
		state: "running",
		session: "rebuild-session",
	});
	return { context, connection, built, rebuild, builtSource, target, stopped };
}

test("a running rebuild leaves editing open and reads its sealed delta", async () => {
	let { context, rebuild, builtSource, target } = await rebuilding();
	try {
		expect(context.plan.execution).toBeUndefined();
		expect(Plan.implementationActive(context.plan)).toBe(false);
		expect(implementationStatus(context.plan).locked).toBe(false);
		let listed = await (await context.call("/connector/mcp", {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
		}, rebuild.runToken)).json();
		expect(listed.result.tools.map((item: { name: string }) => item.name)).toEqual([
			"read_rebuild",
			"report_rebuild",
		]);
		expect((await edit(context.plan, "An edit during the rebuild.")).ok).toBe(true);
		let read = await tool(context, rebuild.runToken, "read_rebuild");
		expect(read).toEqual({
			before: builtSource,
			after: target,
			baseRevision: 0,
			targetRevision: 1,
			pullRequests: [{ url: pullRequest, title: "First" }],
			tasks: [{ title: "First", goal: "Launch", pullRequest, summary: "Launched" }],
		});
		expect(read.after).not.toContain("An edit during the rebuild.");
	} finally {
		await Plan.close(context.plan);
	}
});

test("report_rebuild appends a completed version, records commits and advances the base", async () => {
	let { context, connection, rebuild, target, stopped } = await rebuilding();
	let closed = false;
	try {
		expect((await edit(context.plan, "An edit during the rebuild.")).ok).toBe(true);
		let report = {
			summary: "Rendered the rebuilt paragraph.",
			commits: [{ pullRequest, sha: "c".repeat(40), message: "Add the rebuilt paragraph" }],
			tasks: [{ title: "Rebuilt paragraph", goal: "Render it", pullRequest }],
		};
		expect(
			(await tool(context, rebuild.runToken, "report_rebuild", {
				...report,
				commits: [{
					...report.commits[0],
					pullRequest: "https://github.com/owner/repository/pull/8",
				}],
			})).isError,
		).toBe(true);
		expect(await tool(context, rebuild.runToken, "report_rebuild", report)).toEqual({
			state: "stopped",
		});
		let plan = context.plan;
		expect(plan.graph!.versions.map(version => [version.number, version.state])).toEqual([
			[1, "superseded"],
			[2, "approved"],
		]);
		expect(plan.graph!.versions[1]).toMatchObject({ planRevision: plan.revision });
		expect(plan.lifecycle.history.at(-1)).toMatchObject({ live: true, run: { graphVersion: 2 } });
		expect(plan.live).toMatchObject({
			baseRevision: 1,
			baseSource: target,
			commits: [{ ...report.commits[0], revision: 1 }],
		});
		expect(plan.live!.target).toBeUndefined();
		expect(plan.builds.at(-1)!.state).toBe("stopped");
		expect(stopped).toEqual([plan.id, plan.id]);
		expect(
			await tool(context, connection.token, "report_implementation_build", {
				id: rebuild.build.id,
				state: "stopped",
			}),
		).toEqual({ accepted: true });
		let snapshot = await (await context.call(context.path)).json();
		expect(snapshot.live).toMatchObject({
			pullRequests: [pullRequest],
			commits: [{ pullRequest, sha: "c".repeat(40), revision: 1 }],
			rebuild: { id: rebuild.build.id, state: "stopped" },
			outOfSync: true,
			builderConnected: true,
		});
		expect(snapshot.live.baseSource).toBeUndefined();
		expect(snapshot.lifecycle.history.at(-1).outcome.kind).toBe("implemented");
		let live = plan.live;
		await Plan.close(plan);
		closed = true;
		let restored = await Plan.open(
			plan.id,
			{ ...context.backend, liveBuild: true },
			context.server,
		);
		expect(restored.live).toEqual(live);
		expect(restored.graph).toEqual(plan.graph);
		await Plan.close(restored);
	} finally {
		if (!closed) await Plan.close(context.plan);
	}
});

test("a rebuild that needed no code change still leaves a trace", async () => {
	let { context, rebuild } = await rebuilding();
	let closed = false;
	try {
		let report = { summary: "The edit only clarified wording.", commits: [], tasks: [] };
		expect(await tool(context, rebuild.runToken, "report_rebuild", report)).toEqual({
			state: "stopped",
		});
		expect(context.plan.live!.noChange).toEqual([{
			buildId: rebuild.build.id,
			revision: 1,
			summary: report.summary,
			at: expect.any(String),
		}]);
		let snapshot = await (await context.call(context.path)).json();
		expect(snapshot.live.commits).toEqual([]);
		expect(snapshot.live.noChange).toEqual([
			expect.objectContaining({ buildId: rebuild.build.id, summary: report.summary }),
		]);
		let live = context.plan.live;
		await Plan.close(context.plan);
		closed = true;
		let restored = await Plan.open(
			context.plan.id,
			{ ...context.backend, liveBuild: true },
			context.server,
		);
		expect(restored.live).toEqual(live);
		await Plan.close(restored);
	} finally {
		if (!closed) await Plan.close(context.plan);
	}
});

test("a landed rebuild keeps its heartbeat and a retried report harmless", async () => {
	let { context, connection, rebuild } = await rebuilding();
	try {
		let report = {
			summary: "Rendered the rebuilt paragraph.",
			commits: [{ pullRequest, sha: "c".repeat(40), message: "Add the rebuilt paragraph" }],
			tasks: [],
		};
		expect(await tool(context, rebuild.runToken, "report_rebuild", report)).toEqual({
			state: "stopped",
		});
		let landed = structuredClone({ live: context.plan.live, graph: context.plan.graph });
		expect(
			await tool(context, connection.token, "renew_implementation_build", {
				id: rebuild.build.id,
			}),
		).toEqual({ accepted: true, state: "stopped" });
		expect(await tool(context, rebuild.runToken, "report_rebuild", report)).toEqual({
			state: "stopped",
		});
		expect({ live: context.plan.live, graph: context.plan.graph }).toEqual(landed);
		expect(context.plan.builds.at(-1)!.state).toBe("stopped");
		expect(
			(await tool(context, rebuild.runToken, "report_rebuild", {
				...report,
				commits: [{ ...report.commits[0], sha: "d".repeat(40) }],
			})).isError,
		).toBe(true);
	} finally {
		await Plan.close(context.plan);
	}
});

test("a rebuild that ends without a report fails and leaves the live base alone", async () => {
	let { context, connection, rebuild } = await rebuilding();
	try {
		let live = structuredClone(context.plan.live);
		let graph = structuredClone(context.plan.graph);
		await tool(context, connection.token, "report_implementation_build", {
			id: rebuild.build.id,
			state: "stopped",
		});
		expect(context.plan.builds.at(-1)).toMatchObject({ state: "failed" });
		expect(context.plan.live).toEqual(live!);
		expect(context.plan.graph).toEqual(graph!);
		expect(
			(await tool(context, rebuild.runToken, "report_rebuild", {
				summary: "Too late",
				commits: [],
				tasks: [],
			})).isError,
		).toBe(true);
		let again = await queueRebuild(context.plan, context.experiments.connections);
		expect(again.kind).toBe("queued");
	} finally {
		await Plan.close(context.plan);
	}
});
