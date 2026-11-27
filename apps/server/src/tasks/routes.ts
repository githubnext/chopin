import { documentPath } from "@chopin/protocol/document-url";
import { z } from "zod";
import { liveSnapshot, reportBuild, requestBuild, runner } from "./builds";
import { implementationLifecycle } from "./lifecycle";
import { planningReadiness, reportImplementationLifecycle } from "./plan-graphs";
import { createBuildStarter, MachineRefused } from "./start-build";
import type { DraftBuildStarter } from "./start-build";
import { exclusive } from "../plan/service";
import { GitHubError } from "../github/client";
import type { GitHubReferenceSource } from "../github/client";
import type { PullRequestState } from "./builds";
import { AdmissionDenied } from "../auth/admission";
import { ownOrigin } from "../auth/config";
import { implementationConnector } from "./connector";
import type { Connection, Connections } from "../experiments/connections";
import type { Source } from "@chopin/experiment";
import type { HostedAuth } from "../auth/routes";
import type { Plan } from "../plan/service";
import type { RouteHandler, Router } from "../http/router";
import type {
	BuildMachine,
	BuildRequest,
	ImplementationSnapshot,
	PlanSource,
} from "@chopin/protocol/implementation";

type Options = {
	withPlan<T>(id: string, action: (plan: Plan) => Promise<T>): Promise<T>;
	connections: Connections;
	/** Whether an investigation is executing on a connection, in any document. */
	busy?: (connectionId: string) => Promise<boolean>;
	/** Opening the snapshot may schedule Planner help; it never contributes a hidden veto. */
	assess?: (id: string, planRevision: number) => void;
	/** LIVE_BUILD: builds may queue behind a prototype or another document's build. */
	liveBuild?: boolean;
	/** CHOPIN_BUILD_RESUME_MS: how long after a restart a build's machine may come back to it. */
	resumeMs?: number;
	/**
	 * Throws `machine-offline` naming the machine the person chose, `machine-unavailable` when it is
	 * a teammate's that no longer takes their work, else `no-workspace`.
	 */
	refuseOffline?: (owner: string, documentId: string) => Promise<never>;
	/**
	 * The live connections that may take the work `owner` asks for on a document: their own, and
	 * the teammate's shared machine they chose while its owner can push to the repository. Without
	 * it, only their own.
	 */
	takers?: (owner: string, repositoryId: string, documentId: string) => Promise<Connection[]>;
	/** Whether a connection may take `person`'s work on a document now, as `takers` decides. */
	mayTake?: (connection: Connection, person: string, documentId: string) => Promise<boolean>;
	/** The GitHub name and noreply email of a person a launch token was issued for, when known. */
	identity?: (userId: string) => { name: string; email: string } | undefined;
	/** Reads the stored machine choices, or throws `machine-choice-unavailable`. */
	machineChoices?: () => Promise<void>;
	/**
	 * The checkout a connection's build of a document starts from: the plan source's commit when
	 * there is one, checked on GitHub (else `plan-source-unavailable`). Without it, only a checkout
	 * the connection said it has, at the plan source's commit when there is one.
	 */
	sourceFor?: (connection: Connection, documentId: string, plan?: PlanSource) => Promise<Source>;
	/** Starts a Planner task-drafting turn when programmatic `build_plan` needs a current graph. */
	draftBuild?: DraftBuildStarter;
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

/**
 * The state on GitHub of each of `urls` in the build's repository, read with the access of the
 * machine that runs the build. A pull request whose state can't be read is left out: unknown.
 */
async function pullRequestStates(
	auth: HostedAuth,
	build: BuildRequest,
	urls: readonly string[],
): Promise<ReadonlyMap<string, PullRequestState>> {
	let states = new Map<string, PullRequestState>();
	let github = auth.github as Partial<GitHubReferenceSource>;
	let machine = build.machineId ? await auth.storage.machines.get(build.machineId) : undefined;
	if (!github.pullRequest || !machine) return states;
	let [owner, name] = build.checkout.repository.split("/");
	let prefix = `https://github.com/${build.checkout.repository}/pull/`.toLowerCase();
	await Promise.all(urls.map(async url => {
		let number = Number(url.toLowerCase().startsWith(prefix) ? url.slice(prefix.length) : NaN);
		if (!owner || !name || !Number.isSafeInteger(number) || number <= 0) return;
		try {
			let found = await auth.machines.use(
				machine!,
				token => github.pullRequest!(token, owner!, name!, number),
			);
			if ("state" in found) states.set(url, found.state);
		} catch {
			// Unknown: the agent checks the pull request itself before it pushes.
		}
	}));
	return states;
}

/**
 * A browser build runs on the machine the clicker chose for the document: their own connection for
 * its repository, or a teammate's shared machine whose owner can push there.
 */
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
		options.liveBuild ? options.busy : undefined,
		{
			...options.resumeMs === undefined ? {} : { resumeMs: options.resumeMs },
			...options.mayTake ? { mayTake: options.mayTake } : {},
			...options.identity ? { identity: options.identity } : {},
			login: async id => (await auth.storage.users.get(id))?.login,
			earlierUrls: async id => {
				let channel = await auth.storage.channels.get(id);
				if (!channel || channel.parentChannelId) return [];
				return (await auth.storage.channels.earlierSlugs(id)).map(slug =>
					new URL(
						documentPath(channel.repositoryOwner, channel.repositoryName, slug),
						auth.config.origin,
					).href
				);
			},
			pullRequestStates: (build, urls) => pullRequestStates(auth, build, urls),
		},
	);
	let starter = createBuildStarter({
		withPlan: options.withPlan,
		connections: options.connections,
		connector,
		busy: options.busy,
		liveBuild: options.liveBuild,
		refuseOffline: options.refuseOffline,
		takers: options.takers,
		machineChoices: options.machineChoices,
		sourceFor: options.sourceFor,
		draftBuild: options.draftBuild,
	});
	let safe = (handler: RouteHandler): RouteHandler => async (request, url, params) => {
		try {
			return await handler(request, url, params);
		} catch (error) {
			if (error instanceof MachineRefused) {
				return json({ error: error.code, message: error.message }, error.status);
			}
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
			let { session, channel } = await browser(request, id);
			connector.track(id);
			// Cheap on purpose: whether one is free is decided when Build is pressed.
			let localAgent = options.connections.list(channel.repositoryId, session.user.id).length > 0
				|| options.connections.chosenShared(channel.repositoryId, session.user.id, id).length > 0
				|| options.connections.favoriteShared(channel.repositoryId, session.user.id, id).length
					> 0;
			// Read before the plan lock; the experiment store has its own.
			let queued = options.liveBuild
				? await options.withPlan(id, async plan => plan.builds.at(-1))
				: undefined;
			let ahead = queued?.state === "queued"
					&& options.connections.queued(queued.connectionId).includes(id)
				? options.connections.assigned(queued.connectionId)
				: undefined;
			// The other document shares this repository, so its title is readable here.
			let aheadTitle = ahead && (await auth.storage.channels.get(ahead))?.title;
			let waiting = !ahead && queued?.state === "queued"
				&& !!await options.busy?.(queued.connectionId);
			let current = await options.withPlan(id, plan =>
				exclusive(plan, async () => {
					let ready = await planningReadiness(plan, plan.revision);
					if (!channel.archivedAt) options.assess?.(id, plan.revision);
					let live = liveSnapshot(
						plan,
						options.connections.list(channel.repositoryId),
						session.user.id,
					);
					let snapshot: ImplementationSnapshot = {
						revision: plan.persistence.revision,
						planRevision: plan.revision,
						graph: plan.graph?.versions.at(-1),
						build: plan.builds.findLast(build => {
							let graph = plan.graph?.versions.at(-1);
							return build.graphVersion === graph?.number && build.graphRevision === graph.revision;
						}),
						blockers: ready.blockers,
						buildInvestigations: ready.investigations,
						localAgent,
						buildReady: ready.ok,
						...(waiting ? { waitingForPrototype: true as const } : {}),
						...(ahead ? { waitingForDocument: aheadTitle ? { title: aheadTitle } : {} } : {}),
						...(plan.buildRequested ? { buildRequested: { ...plan.buildRequested } } : {}),
						lifecycle: plan.graph
							? implementationLifecycle({
								graph: plan.graph,
								execution: plan.execution,
								lifecycle: plan.lifecycle,
							})
							: { execution: { state: "idle" }, history: [] },
						...(live ? { live } : {}),
					};
					// The builds the snapshot names, whose machines everyone who sees them may know.
					let named = [
						snapshot.build,
						live && plan.builds.findLast(build => build.kind === "rebuild"),
						live && plan.builds.find(build => build.id === live.buildId),
					].flatMap(build => build?.machineId ? [structuredClone(build)] : []);
					return { snapshot, named };
				}));
			// Read outside the plan lock; a missing user only loses the attribution.
			let login = current.snapshot.build
				&& (await auth.storage.users.get(current.snapshot.build.user))?.login;
			let builder = current.snapshot.live
				&& (await auth.storage.users.get(current.snapshot.live.user))?.login;
			let buildMachines: Record<string, BuildMachine> = {};
			for (let build of current.named) {
				let machine = await auth.storage.machines.get(build.machineId!);
				if (!machine) continue;
				buildMachines[build.id] = {
					label: machine.label,
					...(build.machineOwner !== undefined
						? { owner: (await auth.storage.users.get(build.machineOwner))?.login }
						: {}),
					service: build.machineService === true,
					// Only the starter learns whether their own machine is online.
					...(build.user === session.user.id
						? { connected: options.connections.machine(machine.id).length > 0 }
						: {}),
				};
			}
			return json({
				...current.snapshot,
				...(login ? { startedBy: login } : {}),
				...(builder ? { builtBy: builder } : {}),
				...(Object.keys(buildMachines).length ? { buildMachines } : {}),
			});
		}),
	);
	router.on(
		"POST",
		"/api/channels/:id/implementation",
		safe(async (request, _url, { id }) => {
			if (!ownOrigin(auth.config, request.headers.get("origin"))) {
				throw new GitHubError("origin is not allowed", 403);
			}
			let { session, channel, repository } = await browser(request, id);
			if (!repository.permissions.push && !repository.permissions.admin || channel.archivedAt) {
				throw new GitHubError("repository write access is required", 403);
			}
			let input = await body(request, buildSchema);
			let result = await starter.queueExplicitBuild({
				documentId: id,
				repositoryId: channel.repositoryId,
				userId: session.user.id,
				approvedBy: session.user.login,
				...input,
			});
			if (!result.ok) {
				if (result.machineRefused) {
					throw new MachineRefused(result.code, result.message, result.httpStatus);
				}
				throw new GitHubError(result.message, result.httpStatus);
			}
			return json(result.build);
		}),
	);
	// Build the edits since the last build onto its pull requests, on the presser's own agent.
	router.on(
		"POST",
		"/api/channels/:id/implementation/rebuild",
		safe(async (request, _url, { id }) => {
			if (!ownOrigin(auth.config, request.headers.get("origin"))) {
				throw new GitHubError("origin is not allowed", 403);
			}
			let { session, channel, repository } = await browser(request, id);
			if (!repository.permissions.push && !repository.permissions.admin || channel.archivedAt) {
				throw new GitHubError("repository write access is required", 403);
			}
			let result = await starter.queueExplicitRebuild({
				documentId: id,
				repositoryId: channel.repositoryId,
				userId: session.user.id,
			});
			if (!result.ok) {
				if (result.machineRefused) {
					throw new MachineRefused(result.code, result.message, result.httpStatus);
				}
				throw new GitHubError(result.message, result.httpStatus);
			}
			return json(result.build);
		}),
	);
	router.on(
		"POST",
		"/api/channels/:id/implementation/stop",
		safe(async (request, _url, { id }) => {
			if (!ownOrigin(auth.config, request.headers.get("origin"))) {
				throw new GitHubError("origin is not allowed", 403);
			}
			let { session, channel, repository } = await browser(request, id);
			if (!repository.permissions.push && !repository.permissions.admin || channel.archivedAt) {
				throw new GitHubError("repository write access is required", 403);
			}
			let input = await body(request, z.object({ id: z.string().uuid() }).strict());
			await options.withPlan(id, async plan => {
				let build = plan.builds.at(-1);
				if (build?.id !== input.id) throw new GitHubError("build has changed", 409);
				if (build.user !== session.user.id) {
					throw new GitHubError("only the build owner can stop it", 403);
				}
				if (build.state === "failed" || build.state === "stopped") {
					if (build.stoppedAtRevision !== undefined) return;
					throw new GitHubError("build has already ended", 409);
				}
				try {
					// A human interruption must not publish unfinished work as a delivered live build.
					await reportBuild(plan, runner(build), build.connectionId, build.id, {
						state: "failed",
						error: "Stopped in Chopin.",
						stoppedBy: session.user.login,
					});
					options.connections.release(build.connectionId, id);
				} catch (error) {
					if (
						error instanceof Error && [
							"build is unavailable",
							"build report is out of order",
						].includes(error.message)
					) throw new GitHubError("build has changed", 409);
					throw error;
				}
			});
			return json({ accepted: true });
		}),
	);
	router.on(
		"DELETE",
		"/api/channels/:id/implementation/request",
		safe(async (request, _url, { id }) => {
			if (!ownOrigin(auth.config, request.headers.get("origin"))) {
				throw new GitHubError("origin is not allowed", 403);
			}
			let { channel, repository } = await browser(request, id);
			if (!repository.permissions.push && !repository.permissions.admin || channel.archivedAt) {
				throw new GitHubError("repository write access is required", 403);
			}
			await options.withPlan(id, async plan => requestBuild(plan, undefined));
			return json({ accepted: true });
		}),
	);
	router.on(
		"POST",
		"/api/channels/:id/implementation/revise",
		safe(async (request, _url, { id }) => {
			if (!ownOrigin(auth.config, request.headers.get("origin"))) {
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
				// A run ends with its build (see releaseEndedRun), so it is usually returned already.
				if (plan.execution?.id !== build.id) {
					if (plan.lifecycle.history.some(item => item.run.id === build.id)) {
						return json({ accepted: true });
					}
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
	return { ...connector, startPlanBuild: starter.startPlanBuild };
}
