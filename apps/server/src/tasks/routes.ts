import { documentPath } from "@chopin/protocol/document-url";
import { z } from "zod";
import { liveSnapshot, queueBuild } from "./builds";
import { implementationLifecycle } from "./lifecycle";
import { implementationReadiness, reportImplementationLifecycle } from "./plan-graphs";
import { exclusive } from "../plan/service";
import { GitHubError } from "../github/client";
import { AdmissionDenied } from "../auth/admission";
import { implementationConnector } from "./connector";
import type { Connections } from "../experiments/connections";
import type { HostedAuth } from "../auth/routes";
import type { Plan } from "../plan/service";
import type { RouteHandler, Router } from "../http/router";
import type { ImplementationSnapshot } from "@chopin/protocol/implementation";

type Options = {
	withPlan<T>(id: string, action: (plan: Plan) => Promise<T>): Promise<T>;
	connections: Connections;
	/** Whether an investigation is executing on a connection, in any document. */
	busy?: (connectionId: string) => Promise<boolean>;
};
let buildSchema = z.object({
	retryOf: z.string().uuid().optional(),
	planRevision: z.number().int().nonnegative(),
	graphVersion: z.number().int().positive(),
	graphRevision: z.number().int().positive(),
}).strict();

function json(value: unknown, status = 200) {
	return Response.json(value, {
		status,
		headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
	});
}

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
	let reader = request.body?.getReader();
	if (!reader) throw new GitHubError("request body is required", 400);
	let size = 0;
	let chunks: Uint8Array[] = [];
	try {
		while (true) {
			let { done, value } = await reader.read();
			if (done || !value) break;
			size += value.byteLength;
			if (size > 8192) {
				await reader.cancel();
				throw new GitHubError("request too large", 413);
			}
			chunks.push(value);
		}
		return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	} catch (error) {
		if (error instanceof GitHubError) throw error;
		throw new GitHubError("invalid request", 400);
	} finally {
		reader.releaseLock();
	}
}

/** A browser build runs on the clicker's own connection for the document's repository. */
export function registerImplementationRoutes(router: Router, auth: HostedAuth, options: Options) {
	let connector = implementationConnector(
		options.withPlan,
		options.connections,
		async id => {
			let channel = await auth.storage.channels.get(id);
			if (!channel) throw new Error("document is unavailable");
			return new URL(
				documentPath(channel.repositoryOwner, channel.repositoryName, channel.slug),
				auth.config.origin,
			).href;
		},
		async id => !!await auth.storage.channels.get(id),
	);
	let safe = (handler: RouteHandler): RouteHandler => async (request, url, params) => {
		try {
			return await handler(request, url, params);
		} catch (error) {
			if (error instanceof GitHubError) return json({ error: error.message }, error.status);
			if (error instanceof AdmissionDenied) return json({ error: error.message }, 403);
			console.error("chopin: implementation request failed", error);
			return json({ error: "implementation request failed" }, 500);
		}
	};
	async function browser(request: Request, id: string) {
		let session = await auth.sessions.authenticate(request);
		if (!session) throw new GitHubError("authentication required", 401);
		let channel = await auth.storage.channels.get(id);
		if (!channel || channel.parentChannelId) throw new GitHubError("document not found", 404);
		let { value: repository } = await auth.sessions.use(
			session,
			token => auth.github.repositoryAccess(token, channel.repositoryOwner, channel.repositoryName),
		);
		if (!repository?.permissions.pull || repository.id !== channel.repositoryId) {
			throw new GitHubError("document not found", 404);
		}
		return { session, channel, repository };
	}
	/**
	 * The caller's live connections for a repository that can take a build for `id`: the one
	 * last used for this document first, then the most recently heard from. A build already
	 * waiting on this document does not make its connection busy, so a repeated request can
	 * return that build.
	 */
	async function available(owner: string, repositoryId: string, id: string) {
		let free = [];
		for (let connection of options.connections.candidates(repositoryId, owner, id)) {
			let here = options.connections.assigned(connection.id) === id;
			if (await options.busy?.(connection.id) || !here && await connector.busy(connection)) {
				continue;
			}
			if (here) free.unshift(connection);
			else free.push(connection);
		}
		return free;
	}
	router.on(
		"GET",
		"/api/channels/:id/implementation",
		safe(async (request, _url, { id }) => {
			let { session, channel } = await browser(request, id);
			connector.track(id);
			// Cheap on purpose: whether one is free is decided when Build is pressed.
			let localAgent = options.connections.list(channel.repositoryId, session.user.id).length > 0;
			let current = await options.withPlan(id, plan =>
				exclusive(plan, async () => {
					let ready = implementationReadiness(plan, plan.revision);
					let live = liveSnapshot(plan, options.connections.list(id));
					let snapshot: ImplementationSnapshot = {
						revision: plan.persistence.revision,
						planRevision: plan.revision,
						graph: plan.graph?.versions.at(-1),
						build: plan.builds.findLast(build => {
							let graph = plan.graph?.versions.at(-1);
							return build.graphVersion === graph?.number && build.graphRevision === graph.revision;
						}),
						blockers: ready.ok ? [] : ready.blockers,
						localAgent,
						lifecycle: plan.graph
							? implementationLifecycle({
								graph: plan.graph,
								execution: plan.execution,
								lifecycle: plan.lifecycle,
							})
							: { execution: { state: "idle" }, history: [] },
						...(live ? { live } : {}),
					};
					return snapshot;
				}));
			// Read outside the plan lock; a missing user only loses the attribution.
			let login = current.build && (await auth.storage.users.get(current.build.user))?.login;
			return json(login ? { ...current, startedBy: login } : current);
		}),
	);
	router.on(
		"POST",
		"/api/channels/:id/implementation",
		safe(async (request, _url, { id }) => {
			if (request.headers.get("origin") !== auth.config.origin) {
				throw new GitHubError("origin is not allowed", 403);
			}
			let { session, channel, repository } = await browser(request, id);
			if (!repository.permissions.push && !repository.permissions.admin || channel.archivedAt) {
				throw new GitHubError("repository write access is required", 403);
			}
			let input = await body(request, buildSchema);
			if (!options.connections.list(channel.repositoryId, session.user.id).length) {
				throw new GitHubError("no-workspace", 409);
			}
			let [connection] = await available(session.user.id, channel.repositoryId, id);
			if (!connection) throw new GitHubError("workspace is offline or busy", 409);
			let checkout = {
				repository: connection.source.repository,
				commit: connection.source.commit,
				...(connection.source.branch ? { branch: connection.source.branch } : {}),
			};
			connector.track(id);
			return options.connections.locked(connection.id, async () => {
				if (
					!options.connections.get(connection.id)
					|| !(await available(session.user.id, channel.repositoryId, id)).includes(connection)
				) {
					throw new GitHubError("workspace is offline or busy", 409);
				}
				return options.withPlan(id, async plan => {
					try {
						let build = await queueBuild(plan, {
							...input,
							user: session.user.id,
							connectionId: connection.id,
							repositoryId: channel.repositoryId,
							checkout,
						});
						options.connections.assign(connection.id, id);
						options.connections.use(id, connection.id);
						options.connections.wake(channel.repositoryId);
						return json(build);
					} catch (error) {
						throw new GitHubError(error instanceof Error ? error.message : "build refused", 409);
					}
				});
			});
		}),
	);
	router.on(
		"POST",
		"/api/channels/:id/implementation/revise",
		safe(async (request, _url, { id }) => {
			if (request.headers.get("origin") !== auth.config.origin) {
				throw new GitHubError("origin is not allowed", 403);
			}
			let { channel, repository } = await browser(request, id);
			if (!repository.permissions.push && !repository.permissions.admin || channel.archivedAt) {
				throw new GitHubError("repository write access is required", 403);
			}
			let input = await body(
				request,
				z.object({
					buildId: z.string().uuid(),
					reason: z.string().trim().min(1).max(2000),
				}).strict(),
			);
			return options.withPlan(id, async plan => {
				let build = plan.builds.at(-1);
				if (!build || build.id !== input.buildId || !["stopped", "failed"].includes(build.state)) {
					throw new GitHubError("stop the local agent before returning the plan for changes", 409);
				}
				if (
					plan.execution?.id !== build.id
					&& !plan.lifecycle.history.some(item => item.run.id === build.id)
				) {
					throw new GitHubError("implementation is not awaiting changes", 409);
				}
				let result = await reportImplementationLifecycle(plan, {
					kind: "request_revision",
					runId: build.id,
					idempotencyKey: `browser-review:${build.id}`,
					reason: input.reason,
				});
				if (result.kind === "refused") throw new GitHubError(result.reason, 409);
				return json({ accepted: true });
			});
		}),
	);
	return connector;
}
