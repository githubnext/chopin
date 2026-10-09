import { documentPath } from "@chopin/protocol/document-url";
import { z } from "zod";
import { checkoutSchema, queueBuild } from "./builds";
import { implementationLifecycle } from "./lifecycle";
import { implementationReadiness } from "./plan-graphs";
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
	busy?: (id: string) => Promise<string[]>;
};
let buildSchema = z.object({
	connectionId: z.string().uuid(),
	checkout: checkoutSchema,
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

/** Browser approval dispatches through the existing owner-paired connector. */
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
	router.on(
		"GET",
		"/api/channels/:id/implementation",
		safe(async (request, _url, { id }) => {
			let { session } = await browser(request, id);
			connector.track(id);
			let busy = await options.busy?.(id) ?? [];
			return options.withPlan(id, plan =>
				exclusive(plan, async () => {
					let ready = implementationReadiness(plan, plan.revision);
					let snapshot: ImplementationSnapshot = {
						planRevision: plan.revision,
						graph: plan.graph?.versions.at(-1),
						build: plan.builds.findLast(build => {
							let graph = plan.graph?.versions.at(-1);
							return build.graphVersion === graph?.number && build.graphRevision === graph.revision;
						}),
						blockers: ready.ok ? [] : ready.blockers,
						workspaces: options.connections.list(id).filter(item => item.owner === session.user.id)
							.map(item => ({
								id: item.id,
								label: item.label,
								checkout: {
									repository: item.source.repository,
									commit: item.source.commit,
									...(item.source.branch ? { branch: item.source.branch } : {}),
								},
								available: !busy.includes(item.id) && !plan.builds.some(build =>
									build.connectionId === item.id
									&& ["queued", "starting", "running"].includes(build.state)
								),
							})),
						lifecycle: plan.graph
							? implementationLifecycle({
								graph: plan.graph,
								execution: plan.execution,
								lifecycle: plan.lifecycle,
							})
							: { execution: { state: "idle" }, history: [] },
					};
					return json(snapshot);
				}));
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
			let connection = options.connections.get(input.connectionId);
			if (
				!connection || connection.owner !== session.user.id || connection.documentId !== id
				|| connection.source.repositoryId !== channel.repositoryId
			) {
				throw new GitHubError("workspace is unavailable", 409);
			}
			if (
				input.checkout.repository.toLowerCase() !== connection.source.repository.toLowerCase()
				|| input.checkout.branch !== connection.source.branch
				|| input.checkout.commit !== connection.source.commit
			) {
				throw new GitHubError("workspace checkout changed; review again", 409);
			}
			connector.track(id);
			return options.connections.locked(connection.id, async () => {
				if (
					!options.connections.get(connection.id)
					|| (await options.busy?.(id) ?? []).includes(connection.id)
				) {
					throw new GitHubError("workspace is offline or busy", 409);
				}
				return options.withPlan(id, async plan => {
					try {
						return json(
							await queueBuild(plan, {
								...input,
								user: session.user.id,
								repositoryId: channel.repositoryId,
								checkout: input.checkout,
							}),
						);
					} catch (error) {
						throw new GitHubError(error instanceof Error ? error.message : "build refused", 409);
					}
				});
			});
		}),
	);
	return connector;
}
