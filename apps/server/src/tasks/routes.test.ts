import { expect, test } from "bun:test";
import { Sessions } from "../auth/session";
import { Admission } from "../auth/admission";
import { Router } from "../http/router";
import { openPlan } from "../testing/plan";
import * as Plan from "../plan/service";
import { registerExperimentRoutes } from "../experiments/routes";
import { implementationGraphs } from "./plan-graphs";
import { registerImplementationRoutes } from "./routes";
import type { GitHub } from "../github/client";
import type { HostedAuth } from "../auth/routes";

let checkout = { repository: "owner/repository", branch: "main", commit: "a".repeat(40) };
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
		busy: async id =>
			(await experiments.service.store.list(id)).filter(item =>
				["running", "publishing"].includes(item.state)
			).map(item => item.connectionId!),
		withPlan: async (_id, action) => action(context.plan),
	});
	await implementationGraphs().revise(context.plan, {
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
		otherCookie: other.cookie,
		implementations,
		experiments,
	};
}

async function paired(context: Awaited<ReturnType<typeof setup>>, cookie?: string) {
	let pairing =
		await (await context.call("/api/connector/pairings", { ...checkout, label: "Laptop" })).json();
	await context.call(
		`/api/connector/pairings/${pairing.id}/approve`,
		{
			documentId: context.plan.id,
		},
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
	expect(snapshot.workspaces[0].label).toBe("Laptop");
	let review = {
		connectionId: connection.connection.id,
		checkout,
		planRevision: 0,
		graphVersion: 1,
		graphRevision: 1,
	};
	expect((await context.call(context.path, review, undefined, "https://untrusted.test")).status)
		.toBe(403);
	let built = await (await context.call(context.path, review)).json();
	expect(built.state).toBe("queued");
	expect((await (await context.call(context.path, review)).json()).id).toBe(built.id);
	expect(await tool(context, connection.token, "wait_for_work")).toEqual({
		id: built.id,
		kind: "implementation",
	});
	let claim = await tool(context, connection.token, "claim_implementation_build", { id: built.id });
	expect(claim.build.id).toBe(built.id);
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

test("build authorization rejects another owner's workspace and changed checkout", async () => {
	let context = await setup();
	let foreign = await paired(context, context.otherCookie);
	let review = {
		connectionId: foreign.connection.id,
		checkout,
		planRevision: 0,
		graphVersion: 1,
		graphRevision: 1,
	};
	expect((await context.call(context.path, review)).status).toBe(409);
	let own = await paired(context);
	expect(
		(await context.call(context.path, {
			...review,
			connectionId: own.connection.id,
			checkout: { ...checkout, commit: "b".repeat(40) },
		})).status,
	).toBe(409);
	expect(context.plan.builds).toEqual([]);
	expect(context.plan.graph?.versions[0].state).toBe("draft");
	await Plan.close(context.plan);
});

test("investigations and implementations cannot execute on the same workspace together", async () => {
	let context = await setup();
	let connection = await paired(context);
	let investigation = await (await context.call(`/api/documents/${context.plan.id}/experiments`, {
		id: crypto.randomUUID(),
		brief: "Inspect a fixture",
	})).json();
	await context.call(`/api/documents/${context.plan.id}/experiments/${investigation.id}/run`, {
		connectionId: connection.connection.id,
	});
	let build = await (await context.call(context.path, {
		connectionId: connection.connection.id,
		checkout,
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
		connectionId: connection.connection.id,
		checkout,
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
		connectionId: connection.connection.id,
		checkout,
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

test("Build waits for an investigation-busy workspace before approving the graph", async () => {
	let context = await setup();
	let connection = await paired(context);
	let investigation = await (await context.call(`/api/documents/${context.plan.id}/experiments`, {
		id: crypto.randomUUID(),
		brief: "Inspect a fixture",
	})).json();
	await context.call(`/api/documents/${context.plan.id}/experiments/${investigation.id}/run`, {
		connectionId: connection.connection.id,
	});
	await tool(context, connection.token, "claim_experiment", { id: investigation.id });
	let snapshot = await (await context.call(context.path)).json();
	expect(snapshot.workspaces[0].available).toBe(false);
	expect(
		(await context.call(context.path, {
			connectionId: connection.connection.id,
			checkout,
			planRevision: 0,
			graphVersion: 1,
			graphRevision: 1,
		})).status,
	).toBe(409);
	expect(context.plan.builds).toEqual([]);
	expect(context.plan.graph?.versions[0].state).toBe("draft");
	await Plan.close(context.plan);
});

test("a committed build wakes the waiting connector and a failed pickup can be retried", async () => {
	let context = await setup();
	let connection = await paired(context);
	let abort = new AbortController();
	try {
		let woken = false;
		let waiting = context.experiments.connections.wait(context.plan.id, abort.signal)
			.then(() => woken = true);
		let review = {
			connectionId: connection.connection.id,
			checkout,
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
			connectionId: connection.connection.id,
			checkout,
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
