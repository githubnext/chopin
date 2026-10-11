import { z } from "zod";
import { capabilities, ExperimentError, limits, sourceSchema } from "@chopin/experiment";
import { publicInvestigation } from "@chopin/experiment/records";
import type { HostedAuth } from "../auth/routes";
import type { AuthenticatedSession } from "../auth/session";
import type { Router } from "../http/router";
import { canonical as canonicalReport } from "../mcp/create";
import { parse } from "@chopin/dialect";
import { documentsPath } from "@chopin/protocol/document-url";
import { Connections } from "./connections";
import type { Connection } from "./connections";
import { Experiments, fail } from "./service";
import { datasetCsv } from "./export";
import { implementationSchemas } from "../tasks/connector";
import type { ImplementationConnector } from "../tasks/connector";
import { connectorSchemas } from "./mcp-schema";
import type { Lease } from "../storage/model";
import { createHash } from "node:crypto";
import { imagePath } from "../images/format";
import { MAX_IMAGE_REQUEST_BYTES, prepareImage } from "../mcp/image";
import { spikeReport, spikeSubmissionSchema } from "./spikes";

export type ExperimentRuntime = ReturnType<typeof registerExperimentRoutes>;
type Options = {
	implementations?: () => ImplementationConnector | undefined;
	lease: () => Lease;
	context: (id: string) => Promise<{ source: string; revision: number } | undefined>;
	changed: (id: string) => void;
	canMutate?: (id: string) => Promise<boolean>;
	/** A local agent was paired to a repository for one of its owner's sessions. */
	connected?: (repositoryId: string, owner: string) => void;
	place?: (
		documentId: string,
		experiment: string,
		view: string,
		decision: string,
		remove: boolean,
	) => Promise<void>;
	/** Land a document's finished spike results before a first build claims it. */
	settleSpikes?: (documentId: string) => Promise<void>;
};
const pairingSchema = sourceSchema.omit({ repositoryId: true }).extend({
	label: z.string().trim().min(1).max(100),
}).strict();

const MAX_BODY_BYTES = limits.resultBytes + 64 * 1024;
/** Screenshots a spike run may upload; distinct images, so a retried upload is free. */
export const MAX_SPIKE_IMAGES = 3;

async function raw(request: Request, max: number) {
	let size = 0;
	let chunks: Uint8Array[] = [];
	if (!request.body) fail("invalid-request");
	for await (let chunk of request.body) {
		size += chunk.length;
		if (size > max) fail("request-too-large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}
async function body(request: Request, max = MAX_BODY_BYTES) {
	return JSON.parse((await raw(request, max)).toString("utf8"));
}
function json(value: unknown, status = 200) {
	return Response.json(value, {
		status,
		headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
	});
}

export function registerExperimentRoutes(router: Router, auth: HostedAuth, options: Options) {
	let connections = new Connections();
	let changed = (id: string) => {
		void auth.storage.channels.get(id).then(
			channel => channel && connections.wake(channel.repositoryId),
			() => {},
		);
		options.changed(id);
	};
	let service = new Experiments(auth.storage.experiments, options.lease, changed);
	/** Image hashes each spike run uploaded; a run may only cite its own screenshots. */
	let uploads = new Map<string, Set<string>>();
	async function access(session: AuthenticatedSession | undefined, id: string, write: boolean) {
		if (!session) fail("authentication-required");
		let channel = await auth.storage.channels.get(id);
		if (!channel) fail("not-found");
		let { value: repository } = await auth.sessions.use(
			session,
			token => auth.github.repositoryAccess(token, channel.repositoryOwner, channel.repositoryName),
		);
		if (
			!repository || repository.id !== channel.repositoryId || !repository.permissions.pull
			|| write && !(repository.permissions.push || repository.permissions.admin)
		) fail("repository-forbidden");
		if (write && channel.archivedAt) fail("document-archived");
		return { channel, repository, session };
	}
	/** Push or admin on a repository named by a checkout, resolved through the session. */
	async function repositoryWrite(session: AuthenticatedSession | undefined, fullName: string) {
		if (!session) fail("authentication-required");
		let [owner, name] = fullName.split("/");
		let { value: repository } = await auth.sessions.use(
			session,
			token => auth.github.repositoryAccess(token, owner, name),
		);
		if (!repository || !(repository.permissions.push || repository.permissions.admin)) {
			fail("repository-forbidden");
		}
		return repository;
	}
	/** Work only ever runs on the clicker's own live connection for the document's repository. */
	async function busy(connection: Connection) {
		return (await service.store.active()).some(item =>
			item.connectionId === connection.id && ["running", "publishing"].includes(item.state)
		) || !!await options.implementations?.()?.busy(connection);
	}
	/**
	 * The clicker's idle connection, preferring the one last used for this document. When every
	 * connection is busy the work queues behind the first.
	 */
	async function choose(owner: string, repositoryId: string, documentId: string) {
		let live = connections.candidates(repositoryId, owner, documentId);
		if (!live.length) fail("no-workspace");
		for (let connection of live) if (!await busy(connection)) return connection;
		return live[0];
	}
	async function mutationAllowed(id: string) {
		if (options.canMutate && !await options.canMutate(id)) fail("document-locked");
	}
	function route(
		method: string,
		path: string,
		action: (request: Request, params: Readonly<Record<string, string>>) => Promise<Response>,
	) {
		router.on(method, path, async (request, _url, params) => {
			try {
				if (request.headers.has("origin") && request.headers.get("origin") !== auth.config.origin) {
					fail("origin-forbidden");
				}
				if (
					method !== "GET" && request.headers.has("cookie")
					&& request.headers.get("origin") !== auth.config.origin
				) fail("origin-forbidden");
				return await action(request, params);
			} catch (error) {
				let code = error instanceof ExperimentError
					? error.code
					: error instanceof z.ZodError || error instanceof SyntaxError
					? "invalid-request"
					: "unavailable";
				return json(
					{ error: code },
					code === "authentication-required"
						? 401
						: code.includes("forbidden")
						? 403
						: code === "not-found"
						? 404
						: code === "unavailable"
						? 503
						: 409,
				);
			}
		});
	}
	route("POST", "/api/connector/pairings", async request => {
		let created = connections.create(pairingSchema.parse(await body(request)));
		return json({ ...created, url: `${auth.config.origin}/connect?pairing=${created.id}` });
	});
	route("GET", "/api/connector/pairings/:id", async (request, params) => {
		let session = await auth.sessions.authenticate(request);
		if (!session) fail("authentication-required");
		let pending = connections.pending(params.id);
		await repositoryWrite(session, pending.input.repository);
		return json({ input: pending.input, owner: session.user.login, code: pending.code });
	});
	route("POST", "/api/connector/pairings/:id/approve", async (request, params) => {
		z.object({}).strict().parse(await body(request));
		let session = await auth.sessions.authenticate(request);
		let pending = connections.pending(params.id);
		let repository = await repositoryWrite(session, pending.input.repository);
		let connection = connections.approve(
			params.id,
			{ id: session!.user.id, login: session!.user.login, sessionId: session!.session.id },
			repository.id,
		);
		connections.wake(repository.id);
		options.connected?.(repository.id, session!.user.id);
		return json({ id: connection.id, url: documentsPath(repository.owner, repository.name) });
	});
	route("POST", "/api/connector/pairings/:id/claim", async (request, params) => {
		let { secret } = z.object({ secret: z.string().min(32).max(100) }).strict().parse(
			await body(request),
		);
		return json(connections.claim(params.id, secret));
	});
	route("GET", "/api/documents/:id/experiments", async (request, params) => {
		await access(await auth.sessions.authenticate(request), params.id, false);
		return json({
			// A spike's callout under its passage is its record in the document.
			experiments: (await service.store.list(params.id)).filter(value => !value.spike).map(
				value => ({
					id: value.id,
					brief: value.brief,
					state: value.state,
					revision: value.revision,
					requester: value.requester,
					decisionCount: value.decisions.length,
					progress: value.progress,
					createdAt: value.createdAt,
				}),
			),
		});
	});
	route("POST", "/api/documents/:id/experiments", async (request, params) => {
		let { session } = await access(await auth.sessions.authenticate(request), params.id, true);
		await mutationAllowed(params.id);
		let input = z.object({
			id: z.string().uuid(),
			brief: z.string().min(1).max(limits.brief),
			parentId: z.string().uuid().optional(),
		}).strict().parse(await body(request));
		return json(
			publicInvestigation(
				await service.create(params.id, session.user.id, input.brief, input.id, input.parentId),
			),
		);
	});
	route("GET", "/api/documents/:id/experiments/:experiment", async (request, params) => {
		await access(await auth.sessions.authenticate(request), params.id, false);
		let value = await service.store.get(params.experiment);
		if (!value || value.documentId !== params.id) fail("not-found");
		return json(publicInvestigation(value));
	});
	route("POST", "/api/documents/:id/experiments/:experiment/run", async (request, params) => {
		let { session, channel } = await access(
			await auth.sessions.authenticate(request),
			params.id,
			true,
		);
		await mutationAllowed(params.id);
		z.object({}).strict().parse(await body(request));
		let value = await service.store.get(params.experiment);
		if (!value || value.documentId !== params.id) fail("not-found");
		let context = await options.context(params.id);
		if (!context) fail("not-found");
		let previous = (await service.store.list(params.id)).toReversed().find(item => item.input);
		let connection = await choose(session.user.id, channel.repositoryId, params.id);
		let result = await service.authorize(value.id, connection.id, {
			id: value.id,
			documentId: params.id,
			requester: value.requester,
			authorizer: session.user.id,
			brief: value.brief,
			source: previous?.input?.source ?? connection.source,
			context: `Document revision ${context.revision}\n${context.source}`,
		});
		connections.use(params.id, connection.id);
		return json(publicInvestigation(result));
	});
	route("POST", "/api/documents/:id/experiments/:experiment/cancel", async (request, params) => {
		let { session } = await access(await auth.sessions.authenticate(request), params.id, true);
		let value = await service.store.get(params.experiment);
		if (!value || value.documentId !== params.id) fail("not-found");
		if ((value.input?.authorizer ?? value.requester) !== session.user.id) {
			fail("connection-forbidden");
		}
		return json(
			publicInvestigation(await service.stop(value.id, "cancelled", "Cancelled by owner.")),
		);
	});

	/** Re-authorize the connection's owner for its repository, and for a run's document. */
	async function connector(token: string) {
		let found = connections.lookup(token);
		let session = await auth.sessions.resolve(found.connection.sessionId);
		let repository = await repositoryWrite(session, found.connection.source.repository);
		if (repository.id !== found.connection.source.repositoryId) fail("repository-forbidden");
		if (found.grant.run) await target(session, found.connection, found.grant.run.documentId);
		if (!connections.get(found.connection.id)) fail("connection-unavailable");
		let stale = !connections.fresh(found.connection);
		connections.touch(found.connection);
		// Work held back from a silent connection can go to it again now it is heard from.
		if (stale) {
			options.connected?.(found.connection.source.repositoryId, found.connection.owner);
		}
		return { ...found, session: session! };
	}
	/** Write access to a run's document, which must belong to the connection's repository. */
	async function target(
		session: AuthenticatedSession | undefined,
		connection: Connection,
		documentId: string,
	) {
		let { channel } = await access(session, documentId, true);
		if (channel.repositoryId !== connection.source.repositoryId) fail("repository-forbidden");
	}
	/** The connection's queued, running, or publishing investigations across its repository. */
	/** A connection's work in creation order, so queued runs are dispatched first come first served. */
	async function work(connection: Connection, states: string[]) {
		return (await service.store.active()).filter(item =>
			item.connectionId === connection.id && states.includes(item.state)
		).sort((a, b) => a.createdAt - b.createdAt);
	}
	route(
		"GET",
		"/api/documents/:id/experiments/:experiment/export/:dataset",
		async (request, params) => {
			await access(await auth.sessions.authenticate(request), params.id, false);
			let value = await service.store.get(params.experiment);
			let dataset = value?.result?.datasets.find(item => item.key === params.dataset);
			if (!value || value.documentId !== params.id || !dataset) fail("not-found");
			let csv = new URL(request.url).searchParams.get("format") === "csv";
			return new Response(csv ? datasetCsv(dataset) : JSON.stringify(dataset, null, 2), {
				headers: {
					"content-type": csv ? "text/csv; charset=utf-8" : "application/json",
					"content-disposition": `attachment; filename="${dataset.key}.${csv ? "csv" : "json"}"`,
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
				},
			});
		},
	);
	route("POST", "/api/documents/:id/experiments/:experiment/decision", async (request, params) => {
		let { session } = await access(await auth.sessions.authenticate(request), params.id, true);
		await mutationAllowed(params.id);
		let value = await service.store.get(params.experiment);
		if (!value || value.documentId !== params.id) fail("not-found");
		return json(
			publicInvestigation(await service.decide(value.id, session.user, await body(request))),
		);
	});
	route("POST", "/api/documents/:id/experiments/:experiment/placement", async (request, params) => {
		await access(await auth.sessions.authenticate(request), params.id, true);
		await mutationAllowed(params.id);
		let input = z.object({
			view: z.string().min(1).max(64),
			decision: z.string().uuid().optional(),
			remove: z.boolean().optional(),
		}).strict().parse(await body(request));
		let value = await service.store.get(params.experiment);
		if (
			!value || value.documentId !== params.id
			|| !value.result?.views.some(view => view.key === input.view)
		) fail("not-found");
		if (
			input.decision
			&& !value.decisions.some(decision =>
				decision.id === input.decision && decision.view === input.view
			)
		) fail("not-found");
		if (!options.place) fail("unavailable");
		await options.place(
			params.id,
			value.id,
			input.view,
			input.decision ?? "",
			input.remove ?? false,
		);
		return json(publicInvestigation(value));
	});
	route("POST", "/api/documents/:id/experiments/:experiment/state", async (request, params) => {
		let { session } = await access(await auth.sessions.authenticate(request), params.id, true);
		let value = await service.store.get(params.experiment);
		if (!value || value.documentId !== params.id) fail("not-found");
		let input = z.object({ view: z.string().max(64), patch: z.unknown() }).strict().parse(
			await body(request),
		);
		return json(
			publicInvestigation(await service.select(value.id, session.user.id, input.view, input.patch)),
		);
	});
	route("GET", "/connector/mcp", async () => new Response(null, { status: 405 }));
	route("DELETE", "/connector/mcp", async request => {
		let { connection, grant } = await connector(
			(request.headers.get("authorization") ?? "").replace(/^Bearer /, ""),
		);
		if (!grant.run) connections.revoke(connection.id);
		return new Response(null, { status: 204 });
	});
	route("POST", "/connector/mcp", async request => {
		let token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
		let { connection, grant, session } = await connector(token);
		let implementation = options.implementations?.();
		let implementationRun = grant.run?.kind === "implementation" || grant.run?.kind === "rebuild";
		let spikeRun = !!grant.run && !implementationRun
			&& !!(await service.store.get(grant.run.id))?.spike;
		let schemas = implementationRun ? implementationSchemas(true, grant.run?.kind === "rebuild") : {
			...connectorSchemas(!!grant.run, spikeRun),
			...(!grant.run && implementation ? implementationSchemas(false) : {}),
		};
		// Only a spike run's image upload may exceed the ordinary connector body limit.
		let bytes = await raw(
			request,
			spikeRun ? Math.max(MAX_BODY_BYTES, MAX_IMAGE_REQUEST_BYTES) : MAX_BODY_BYTES,
		);
		let call = z.object({
			jsonrpc: z.literal("2.0"),
			id: z.union([z.string(), z.number()]).optional(),
			method: z.string(),
			params: z.record(z.string(), z.unknown()).optional(),
		}).parse(JSON.parse(bytes.toString("utf8")));
		if (
			bytes.length > MAX_BODY_BYTES
			&& (call.method !== "tools/call" || call.params?.name !== "upload_investigation_image")
		) fail("request-too-large");
		let respond = (result: unknown) => json({ jsonrpc: "2.0", id: call.id, result });
		if (call.method.startsWith("notifications/")) return new Response(null, { status: 202 });
		if (call.method === "initialize") {
			return respond({
				protocolVersion: "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "chopin-connector", version: "0.1.0" },
			});
		}
		if (call.method === "ping") return respond({});
		if (call.method === "tools/list") {
			return respond({
				tools: Object.entries(schemas).map(([name, schema]) => ({
					name,
					description: name.replaceAll("_", " "),
					inputSchema: z.toJSONSchema(schema, { unrepresentable: "any" }),
				})),
			});
		}
		if (call.method !== "tools/call") {
			return json({
				jsonrpc: "2.0",
				id: call.id,
				error: { code: -32601, message: "Unknown method" },
			});
		}
		try {
			let name = String(call.params?.name);
			if (!Object.hasOwn(schemas, name)) fail("tool-forbidden");
			let args = schemas[name].parse(call.params?.arguments ?? {});
			if (name === "read_investigation") name = "read_experiment";
			if (name === "submit_investigation_result") name = "submit_experiment_result";
			let value: unknown;
			if (name === "disconnect_workspace") {
				connections.revoke(connection.id);
				for (let active of await work(connection, ["queued", "running", "publishing"])) {
					await service.stop(active.id, "interrupted", "Workspace disconnected.");
				}
				value = { disconnected: true };
			} else if (name === "wait_for_work") {
				// A build in an archived document cannot be claimed; its expiry fails it in the sweep.
				let build = async () => {
					let offered = await implementation!.waiting(connection);
					let documentId = connections.assigned(connection.id);
					let channel = offered && documentId
						? await auth.storage.channels.get(documentId)
						: undefined;
					return channel && !channel.archivedAt ? offered : undefined;
				};
				let queued = async () =>
					await build()
						?? (await implementation!.busy(connection)
							? undefined
							: (await work(connection, ["queued"])).map(item => ({
								id: item.id,
								kind: "experiment",
							}))[0]);
				value = await queued();
				if (!value) {
					await connections.wait(connection.source.repositoryId, request.signal);
					await connector(token);
					value = await queued();
				}
				value ??= { waiting: true };
			} else if (implementationRun || Object.hasOwn(implementationSchemas(false), name)) {
				if (!implementation) fail("tool-forbidden");
				let documentId = grant.run?.documentId ?? connections.assigned(connection.id);
				if (documentId) await target(session, connection, documentId);
				if (name === "claim_implementation_build") {
					// A build queued behind a spike on this connection must start with its findings.
					if (documentId) await options.settleSpikes?.(documentId);
					value = await connections.locked(connection.id, async () => {
						if ((await work(connection, ["running", "publishing"])).length) {
							fail("workspace-busy");
						}
						return implementation.call(connection, grant, name, args);
					});
				} else value = await implementation.call(connection, grant, name, args);
			} else if (name === "wait_for_experiment") {
				let queued = async () => (await work(connection, ["queued"]))[0];
				value = await queued();
				if (!value) {
					await connections.wait(connection.source.repositoryId, request.signal);
					await connector(token);
					value = await queued();
				}
				value = value ? { id: (value as { id: string }).id } : { waiting: true };
			} else if (name === "claim_experiment") {
				let id = z.string().uuid().parse(args.id);
				value = await connections.locked(connection.id, async () => {
					let active = (await work(connection, ["running", "publishing"]))[0];
					if (active && active.id !== id || await implementation?.busy(connection)) {
						fail("workspace-busy");
					}
					let offered = await service.store.get(id);
					if (!offered || offered.connectionId !== connection.id) fail("connection-forbidden");
					try {
						await target(session, connection, offered.documentId);
						await mutationAllowed(offered.documentId);
					} catch (error) {
						// One archived or building document must not stall the repository's connector.
						if (
							!(error instanceof ExperimentError)
							|| !["document-archived", "document-locked"].includes(error.code)
						) throw error;
						await service.stop(
							id,
							"interrupted",
							"The document changed before your local agent started. Propose a retry.",
						);
						fail("invalid-state");
					}
					let claimed = await service.claim(id, connection.id);
					return {
						input: claimed.input,
						generation: claimed.generation,
						...(claimed.spike ? { spike: true } : {}),
						runToken: connections.runToken(
							connection.id,
							claimed.documentId,
							id,
							claimed.generation,
						),
					};
				});
			} else {
				let id = grant.run?.id ?? z.string().uuid().parse(args.id);
				let generation = grant.run?.generation
					?? z.number().int().positive().parse(args.generation);
				let current = await service.store.get(id);
				if (
					!current || current.connectionId !== connection.id
					|| grant.run && current.documentId !== grant.run.documentId
				) fail("connection-forbidden");
				if (!grant.run) await target(session, connection, current.documentId);
				if (name === "complete_experiment") {
					value = await service.complete(id, connection.id, generation);
				} else {
					service.assertClaim(current, connection.id, generation);
					if (name === "read_experiment") value = { input: current.input, capabilities };
					else if (name === "renew_experiment") {
						value = await service.renew(
							id,
							connection.id,
							generation,
							args.progress === undefined ? undefined : z.string().max(2000).parse(args.progress),
						);
					} else if (name === "fail_experiment") {
						value = await service.stop(id, "failed", z.string().max(2000).parse(args.error));
					} else if (name === "upload_investigation_image") {
						if (!current.spike) fail("tool-forbidden");
						let prepared = prepareImage({ id: current.documentId, ...args });
						if (!prepared) fail("invalid-image");
						if ("refusal" in prepared) fail(prepared.refusal);
						let { bytes, mimeType } = prepared.input;
						let sha256 = createHash("sha256").update(bytes).digest("hex");
						// Parallel uploads share one set and reserve their slot before awaiting storage,
						// so neither overwrites the other's record nor slips past the cap.
						let uploaded = uploads.get(id);
						if (!uploaded) uploads.set(id, uploaded = new Set<string>());
						let reserved = !uploaded.has(sha256);
						if (reserved && uploaded.size >= MAX_SPIKE_IMAGES) {
							fail("image-limit", `A spike may upload at most ${MAX_SPIKE_IMAGES} images.`);
						}
						uploaded.add(sha256);
						try {
							await auth.storage.images.put({
								channelId: current.documentId,
								sha256,
								mimeType,
								bytes,
								uploadedBy: session.user.id,
								now: new Date(),
							});
						} catch (err) {
							if (reserved) uploaded.delete(sha256);
							throw err;
						}
						value = { path: imagePath(sha256, mimeType) };
					} else if (name === "submit_spike_result") {
						if (!current.spike) fail("tool-forbidden");
						let input = spikeSubmissionSchema.parse(args);
						for (let path of input.images) {
							let sha256 = path.slice("/images/".length).split(".")[0];
							if (
								!uploads.get(id)?.has(sha256)
								|| !await auth.storage.images.get(current.documentId, sha256)
							) fail("missing-image", `Upload ${path} with upload_investigation_image first.`);
						}
						let report = canonicalReport(spikeReport(input));
						if ("issues" in report) {
							fail("invalid-report", report.issues.map(issue => issue.message).join("; "));
						}
						value = await service.candidate(id, connection.id, generation, {
							schemaVersion: 1,
							report: report.source,
							datasets: [],
							views: [],
							evidence: [],
							provenance: {
								environment: "Throwaway prototype by the editor's local coding agent.",
								checks: [],
								limitations: [],
							},
						});
					} else if (name === "submit_experiment_result") {
						let result = args.result as { report?: unknown };
						if (!result || typeof result.report !== "string") fail("invalid-result");
						let source = canonicalReport(result.report);
						if ("issues" in source) {
							fail(
								"invalid-report",
								source.issues.map(issue => issue.message).join("; ").slice(0, 4000),
							);
						}
						if (
							JSON.stringify(parse(source.source)).match(
								/"name":"(Questionnaire|Question|Decision|Research|Experiment)"/,
							)
						) fail("protected-report");
						value = await service.candidate(id, connection.id, generation, {
							...result,
							report: source.source,
						});
					} else fail("unknown-tool");
				}
				value = {
					accepted: true,
					state: (value as { state?: string }).state,
					...(name === "read_experiment" || name === "upload_investigation_image"
						? value as object
						: {}),
				};
			}
			return respond({ content: [{ type: "text", text: JSON.stringify(value) }] });
		} catch (error) {
			return respond({
				isError: true,
				content: [{
					type: "text",
					text: error instanceof ExperimentError
						? `${error.code}: ${error.message}`
						: error instanceof z.ZodError
						? error.message.slice(0, 4000)
						: "invalid-request",
				}],
			});
		}
	});
	async function sweep() {
		connections.sweep();
		await service.recover();
		await options.implementations?.()?.sweep();
		let active = await service.store.active();
		for (let id of uploads.keys()) {
			if (!active.some(value => value.id === id)) uploads.delete(id);
		}
		for (let value of active) {
			if (value.connectionId && !connections.get(value.connectionId)) {
				await service.stop(
					value.id,
					"interrupted",
					"Workspace connection expired. Propose a new attempt to retry.",
				);
			}
		}
	}
	return { service, connections, access, mutationAllowed, route, body, json, sweep };
}
