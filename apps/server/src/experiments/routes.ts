import { z } from "zod";
import { capabilities, ExperimentError, limits, sourceSchema } from "@chopin/experiment";
import { publicInvestigation } from "@chopin/experiment/records";
import type { HostedAuth } from "../auth/routes";
import type { AuthenticatedSession } from "../auth/session";
import type { Router } from "../http/router";
import { canonical as canonicalReport } from "../mcp/create";
import { parse } from "@chopin/dialect";
import { childDocumentPath, documentPath } from "@chopin/protocol/document-url";
import { Connections } from "./connections";
import { Experiments, fail } from "./service";
import type { Lease } from "../storage/model";

export type ExperimentRuntime = ReturnType<typeof registerExperimentRoutes>;
type Options = {
	lease: () => Lease;
	context: (id: string) => Promise<{ source: string; revision: number } | undefined>;
	changed: (id: string) => void;
	canMutate?: (id: string) => Promise<boolean>;
};
const pairingSchema = sourceSchema.omit({ repositoryId: true }).extend({
	label: z.string().trim().min(1).max(100),
}).strict();

async function body(request: Request) {
	let size = 0;
	let chunks: Uint8Array[] = [];
	if (!request.body) fail("invalid-request");
	for await (let chunk of request.body) {
		size += chunk.length;
		if (size > limits.resultBytes + 64 * 1024) fail("request-too-large");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
		connections.wake(id);
		options.changed(id);
	};
	let service = new Experiments(auth.storage.experiments, options.lease, changed);
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
		let [owner, name] = pending.input.repository.split("/");
		let { value: repository } = await auth.sessions.use(
			session,
			token => auth.github.repositoryAccess(token, owner, name),
		);
		if (!repository || !(repository.permissions.push || repository.permissions.admin)) {
			fail("repository-forbidden");
		}
		let documents = await auth.storage.channels.list(repository.id, 100);
		return json({ input: pending.input, documents: documents.channels, owner: session.user.login });
	});
	route("POST", "/api/connector/pairings/:id/approve", async (request, params) => {
		let { documentId } = z.object({ documentId: z.string().uuid() }).strict().parse(
			await body(request),
		);
		let { session, channel } = await access(
			await auth.sessions.authenticate(request),
			documentId,
			true,
		);
		let pending = connections.pending(params.id);
		if (
			pending.input.repository.toLowerCase()
				!== `${channel.repositoryOwner}/${channel.repositoryName}`.toLowerCase()
		) fail("repository-forbidden");
		let connection = connections.approve(
			params.id,
			{ id: session.user.id, login: session.user.login, sessionId: session.session.id },
			documentId,
			channel.repositoryId,
		);
		changed(documentId);
		let parent = channel.parentChannelId
			? await auth.storage.channels.get(channel.parentChannelId)
			: undefined;
		let url = parent
			? childDocumentPath(
				channel.repositoryOwner,
				channel.repositoryName,
				parent.slug,
				channel.slug,
			)
			: documentPath(channel.repositoryOwner, channel.repositoryName, channel.slug);
		return json({ id: connection.id, documentId, url });
	});
	route("POST", "/api/connector/pairings/:id/claim", async (request, params) => {
		let { secret } = z.object({ secret: z.string().min(32).max(100) }).strict().parse(
			await body(request),
		);
		return json(connections.claim(params.id, secret));
	});
	route("GET", "/api/documents/:id/experiments", async (request, params) => {
		await access(await auth.sessions.authenticate(request), params.id, false);
		connections.sweep();
		return json({
			connections: connections.list(params.id).map(({ sessionId: _session, ...value }) => value),
			experiments: (await service.store.list(params.id)).map(value => ({
				id: value.id,
				brief: value.brief,
				state: value.state,
				revision: value.revision,
				requester: value.requester,
				progress: value.progress,
				createdAt: value.createdAt,
			})),
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
		let { session } = await access(await auth.sessions.authenticate(request), params.id, true);
		await mutationAllowed(params.id);
		let { connectionId } = z.object({ connectionId: z.string().uuid() }).strict().parse(
			await body(request),
		);
		let connection = connections.get(connectionId);
		if (
			!connection || connection.owner !== session.user.id || connection.documentId !== params.id
		) fail("connection-forbidden");
		let value = await service.store.get(params.experiment);
		if (!value || value.documentId !== params.id) fail("not-found");
		let context = await options.context(params.id);
		if (!context) fail("not-found");
		let previous = (await service.store.list(params.id)).toReversed().find(item => item.input);
		let result = await service.authorize(value.id, connectionId, {
			id: value.id,
			documentId: params.id,
			requester: value.requester,
			authorizer: session.user.id,
			brief: value.brief,
			source: previous?.input?.source ?? connection.source,
			context: `Document revision ${context.revision}\n${context.source}`,
		});
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

	async function connector(token: string) {
		let found = connections.lookup(token);
		await access(
			await auth.sessions.resolve(found.connection.sessionId),
			found.connection.documentId,
			true,
		);
		if (!connections.get(found.connection.id)) fail("connection-unavailable");
		connections.touch(found.connection);
		return found;
	}
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
	let toolNames = [
		"disconnect_workspace",
		"wait_for_experiment",
		"claim_experiment",
		"renew_experiment",
		"read_experiment",
		"submit_experiment_result",
		"complete_experiment",
		"fail_experiment",
	];
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
		let { connection, grant } = await connector(token);
		let call = z.object({
			jsonrpc: z.literal("2.0"),
			id: z.union([z.string(), z.number()]).optional(),
			method: z.string(),
			params: z.record(z.string(), z.unknown()).optional(),
		}).parse(await body(request));
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
				tools: toolNames.map(name => ({
					name,
					description: name.replaceAll("_", " "),
					inputSchema: { type: "object" },
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
			let args = z.record(z.string(), z.unknown()).parse(call.params?.arguments ?? {});
			if (grant.run && !["read_experiment", "submit_experiment_result"].includes(name)) {
				fail("tool-forbidden");
			}
			let value: unknown;
			if (name === "disconnect_workspace") {
				connections.revoke(connection.id);
				for (let active of await service.store.list(connection.documentId)) {
					if (
						active.connectionId === connection.id
						&& ["queued", "running", "publishing"].includes(active.state)
					) await service.stop(active.id, "interrupted", "Workspace disconnected.");
				}
				value = { disconnected: true };
			} else if (name === "wait_for_experiment") {
				let queued = async () =>
					(await service.store.list(connection.documentId)).find(item =>
						item.connectionId === connection.id && item.state === "queued"
					);
				value = await queued();
				if (!value) {
					await connections.wait(connection.documentId, request.signal);
					await connector(token);
					value = await queued();
				}
				value = value ? { id: (value as { id: string }).id } : { waiting: true };
			} else if (name === "claim_experiment") {
				let id = z.string().uuid().parse(args.id);
				value = await connections.locked(connection.id, async () => {
					let active = (await service.store.list(connection.documentId)).find(item =>
						item.connectionId === connection.id && ["running", "publishing"].includes(item.state)
					);
					if (active && active.id !== id) fail("workspace-busy");
					let claimed = await service.claim(id, connection.id);
					return {
						input: claimed.input,
						generation: claimed.generation,
						runToken: connections.runToken(connection.id, id, claimed.generation),
					};
				});
			} else {
				let id = grant.run?.id ?? z.string().uuid().parse(args.id);
				let generation = grant.run?.generation
					?? z.number().int().positive().parse(args.generation);
				let current = await service.store.get(id);
				if (
					!current || current.documentId !== connection.documentId
					|| current.connectionId !== connection.id
				) fail("connection-forbidden");
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
					} else if (name === "submit_experiment_result") {
						let result = args.result as { report?: unknown };
						if (!result || typeof result.report !== "string") fail("invalid-result");
						let source = canonicalReport(result.report);
						if ("issues" in source) fail("invalid-report");
						if (
							JSON.stringify(parse(source.source)).match(
								/"name":"(Questionnaire|Question|Decision|Research)"/,
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
					...(name === "read_experiment" ? value as object : {}),
				};
			}
			return respond({ content: [{ type: "text", text: JSON.stringify(value) }] });
		} catch (error) {
			return respond({
				isError: true,
				content: [{
					type: "text",
					text: error instanceof ExperimentError ? error.code : "invalid-request",
				}],
			});
		}
	});
	return { service, connections, access, mutationAllowed, route, body, json };
}
