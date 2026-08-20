import { deterministicChannelId } from "../channels/id";
import { GitHubError } from "../github/client";
import * as Plan from "../plan/service";
import * as Rooms from "../rooms";
import { claimImplementation, reportImplementationLifecycle } from "../tasks/plan-graphs";
import { StorageError } from "../storage/errors";
import { implementationLifecycle } from "../tasks/lifecycle";

import type { HostedAuth } from "../auth/routes";
import type { GitHubUser } from "../github/client";
import type { Implementation, ImplementationInput, McpOptions, RenameDocumentInput } from "../mcp";
import type { LifecycleArguments } from "./lifecycle";
import type { ChannelRecord, Lease } from "../storage/model";
import type { ClaimResult, Run } from "../tasks/graphs";

export type HostedCaller = {
	oauthToken: string;
	user: GitHubUser;
};

export type ImplementationPersistence = { lease(): Lease };
export type HostedCallbacks = { onChannelRenamed?: (channel: ChannelRecord) => void };

const BEARER = new RegExp("^Bearer ([A-Za-z0-9._~+/-]+=*)$", "i");

type Document = {
	id: string;
	title: string;
	creation?: Plan.CreationMetadata;
	source: string;
	revision: number;
	url?: string;
};

type PublicDocument = Omit<Document, "creation" | "url"> & {
	brief?: Plan.CreationMetadata["brief"];
};

/** Strip durable idempotency and repository provenance from MCP responses. */
function document(value: Document & { url: string }): PublicDocument & { url: string };
function document(value: Document): PublicDocument;
function document(value: Document): PublicDocument & { url?: string } {
	return {
		id: value.id,
		title: value.title,
		...(value.creation ? { brief: value.creation.brief } : {}),
		source: value.source,
		revision: value.revision,
		...(value.url ? { url: value.url } : {}),
	};
}

function exposed(
	channel: ChannelRecord,
	state: Awaited<ReturnType<typeof Plan.readStored>>,
): Implementation | undefined {
	let version = state.graph?.versions.at(-1);
	if (
		!state.creation
		|| !version
		|| (version.state !== "approved" && version.state !== "locked")
	) {
		return undefined;
	}
	let lifecycle = state.graph && state.lifecycle
		? implementationLifecycle({
			graph: state.graph,
			execution: state.execution,
			lifecycle: state.lifecycle,
		})
		: undefined;
	return {
		document: document({
			id: channel.id,
			title: channel.title,
			creation: state.creation,
			source: state.source,
			revision: state.revision,
		}),
		repository: {
			name: state.creation.origin.repository,
			baseBranch: state.creation.origin.baseBranch,
			baseCommit: state.creation.origin.baseCommit,
		},
		graph: version,
		execution: state.execution
			? { state: "active", run: state.execution }
			: { state: "idle" },
		activity: lifecycle?.activity,
		history: lifecycle?.history ?? [],
	};
}

function claimResult(value: ClaimResult) {
	return value.kind === "started"
		? { kind: "started" as const, run: value.run }
		: value;
}

/** Bind the backend-neutral MCP surface to hosted GitHub authentication. */
export function hosted(
	auth: HostedAuth,
	persistence?: ImplementationPersistence,
	callbacks: HostedCallbacks = {},
): McpOptions<HostedCaller> {
	async function directRepository(caller: HostedCaller, owner: string, name: string) {
		try {
			return await auth.github.repository(caller.oauthToken, owner, name);
		} catch (err) {
			if (err instanceof GitHubError && (err.status === 403 || err.status === 404)) {
				return undefined;
			}
			throw err;
		}
	}

	function run(caller: HostedCaller, input: ImplementationInput): Run {
		return {
			id: crypto.randomUUID(),
			user: caller.user.login,
			client: { name: input.client.name, version: input.client.version },
			session: input.client.session,
			planRevision: input.planRevision,
			graphVersion: input.graphVersion,
			graphRevision: input.graphRevision,
			repository: input.repository,
			branch: input.branch,
			commit: input.commit,
			startedAt: auth.clock().toISOString(),
		};
	}

	return {
		async caller(request) {
			let match = request.headers.get("authorization")?.match(BEARER);
			if (!match) return undefined;
			let oauthToken = match[1]!;
			try {
				return { oauthToken, user: await auth.admission.user(oauthToken) };
			} catch (err) {
				if (err instanceof GitHubError && err.status === 401) return undefined;
				throw err;
			}
		},
		documents: {
			async list(caller, repository) {
				let parts = repository.split("/");
				if (parts.length !== 2 || !parts[0] || !parts[1]) return "forbidden";
				let resolved = await directRepository(caller, parts[0], parts[1]);
				if (!resolved?.permissions.pull) return "forbidden";

				let documents = [];
				let cursor;
				do {
					let page = await auth.storage.channels.scan(resolved.id, 100, cursor);
					documents.push(...page.channels.map(channel => ({
						id: channel.id,
						title: channel.title,
					})));
					cursor = page.next;
				} while (cursor);
				return documents;
			},
			async read(caller, id) {
				let channel = await auth.storage.channels.get(id);
				if (!channel) return undefined;
				let repository = await directRepository(
					caller,
					channel.repositoryOwner,
					channel.repositoryName,
				);
				if (
					!repository?.permissions.pull
					|| repository.id !== channel.repositoryId
				) return undefined;

				let live = Rooms.get(channel.id)?.plan;
				if (live) {
					try {
						return document({
							id: channel.id,
							title: channel.title,
							creation: live.creation,
							source: Plan.source(live),
							revision: live.revision,
						});
					} catch {
						return undefined;
					}
				}

				let stored = await auth.storage.collaboration.load(channel.id, auth.clock());
				if (
					!stored
					|| stored.channel.id !== channel.id
					|| stored.channel.repositoryId !== channel.repositoryId
					|| stored.channel.repositoryOwner !== channel.repositoryOwner
					|| stored.channel.repositoryName !== channel.repositoryName
				) return undefined;
				try {
					let projected = await Plan.readStored(stored);
					return document({
						id: channel.id,
						title: channel.title,
						creation: projected.creation,
						source: projected.source,
						revision: projected.revision,
					});
				} catch {
					return undefined;
				}
			},
		},
		rename: {
			async rename(caller, input: RenameDocumentInput) {
				let channel = await auth.storage.channels.get(input.id);
				if (!channel) return { kind: "missing" as const };
				let repository = await directRepository(
					caller,
					channel.repositoryOwner,
					channel.repositoryName,
				);
				if (
					!repository
					|| repository.id !== channel.repositoryId
					|| !repository.permissions.pull
				) return { kind: "missing" as const };
				if (!repository.permissions.push && !repository.permissions.admin) {
					return { kind: "forbidden" as const };
				}
				try {
					let result = await auth.storage.channels.rename({
						id: channel.id,
						title: input.title,
						now: auth.clock(),
					});
					if (result.changed) callbacks.onChannelRenamed?.(result.channel);
					return {
						kind: result.changed ? "renamed" as const : "unchanged" as const,
						document: { id: result.channel.id, title: result.channel.title },
					};
				} catch (err) {
					if (err instanceof StorageError && err.failure === "conflict") {
						return { kind: "conflict" as const };
					}
					if (err instanceof StorageError && err.failure === "missing") {
						return { kind: "missing" as const };
					}
					throw err;
				}
			},
		},
		create: {
			async create(caller, input) {
				let parts = input.repository.split("/");
				if (parts.length !== 2 || !parts[0] || !parts[1]) return { kind: "forbidden" };
				let repository = await directRepository(caller, parts[0], parts[1]);
				if (!repository || (!repository.permissions.push && !repository.permissions.admin)) {
					return { kind: "forbidden" };
				}
				await auth.storage.users.put({
					id: caller.user.id,
					login: caller.user.login,
					avatarUrl: caller.user.avatarUrl,
					now: auth.clock(),
				});
				let { brief, plan, ...origin } = input;
				let creation: Plan.CreationMetadata = { brief, origin };
				let initial = await Plan.initial(plan, creation);
				let id = deterministicChannelId(repository.id, input.idempotencyKey);
				try {
					await auth.storage.channels.create({
						id,
						repositoryId: repository.id,
						repositoryOwner: repository.owner,
						repositoryName: repository.name,
						title: input.title,
						createdBy: caller.user.id,
						now: auth.clock(),
						initial,
					});
				} catch (err) {
					if (!(err instanceof StorageError) || err.failure !== "conflict") throw err;
					let stored = await auth.storage.collaboration.load(id, auth.clock());
					if (!stored || stored.channel.repositoryId !== repository.id) {
						return { kind: "conflict" };
					}
					let restored = await Plan.readStored(stored);
					if (
						!restored.creation
						|| restored.creation.origin.idempotencyKey !== input.idempotencyKey
						|| restored.creation.origin.fingerprint !== input.fingerprint
					) return { kind: "conflict" };
					return {
						kind: "replayed",
						document: document({
							id,
							title: stored.channel.title,
							creation: restored.creation,
							source: restored.source,
							revision: restored.revision,
							url: `/channels/${id}`,
						}),
					};
				}
				return {
					kind: "created",
					document: document({
						id,
						title: input.title,
						creation,
						source: initial.source,
						revision: 0,
						url: `/channels/${id}`,
					}),
				};
			},
		},
		...(persistence
			? {
				implementations: {
					async readImplementation(caller: HostedCaller, id: string) {
						let channel = await auth.storage.channels.get(id);
						if (!channel) return undefined;
						let repository = await directRepository(
							caller,
							channel.repositoryOwner,
							channel.repositoryName,
						);
						if (!repository?.permissions.pull || repository.id !== channel.repositoryId) {
							return "forbidden" as const;
						}
						let live = Rooms.get(id)?.plan;
						if (live) {
							return exposed(channel, {
								source: Plan.source(live),
								revision: live.revision,
								...(live.creation ? { creation: live.creation } : {}),
								...(live.graph ? { graph: live.graph } : {}),
								...(live.execution ? { execution: live.execution } : {}),
								lifecycle: live.lifecycle,
							});
						}
						let stored = await auth.storage.collaboration.load(id, auth.clock());
						return stored ? exposed(channel, await Plan.readStored(stored)) : undefined;
					},
					async startImplementation(caller: HostedCaller, input: ImplementationInput) {
						let channel = await auth.storage.channels.get(input.id);
						if (
							!channel
							|| `${channel.repositoryOwner}/${channel.repositoryName}` !== input.repository
						) {
							return { kind: "forbidden" as const };
						}
						let repository = await directRepository(
							caller,
							channel.repositoryOwner,
							channel.repositoryName,
						);
						if (
							!repository
							|| repository.id !== channel.repositoryId
							|| (!repository.permissions.push && !repository.permissions.admin)
						) return { kind: "forbidden" as const };
						let claimRun = run(caller, input);
						let live = Rooms.get(input.id)?.plan;
						if (live) {
							return claimResult(
								await claimImplementation(live, {
									planRevision: input.planRevision,
									graphRevision: input.graphRevision,
									run: claimRun,
								}),
							);
						}
						for (let attempt = 0; attempt < 2; attempt++) {
							let stored = await auth.storage.collaboration.load(input.id, auth.clock());
							if (!stored?.snapshot) return { kind: "refused" as const, reason: "missing" };
							let prepared = Plan.claimStored(stored, {
								planRevision: input.planRevision,
								graphRevision: input.graphRevision,
								run: claimRun,
							});
							if (prepared.result.kind !== "started" || !prepared.sidecar) {
								return claimResult(prepared.result);
							}
							try {
								await auth.storage.collaboration.commit({
									channelId: input.id,
									lease: persistence.lease(),
									expectedRevision: stored.channel.revision,
									operationId: `implementation:${claimRun.id}`,
									epoch: stored.snapshot.epoch,
									sidecar: prepared.sidecar,
									events: [],
									now: auth.clock(),
								});
								return claimResult(prepared.result);
							} catch (err) {
								if (!(err instanceof StorageError) || err.failure !== "conflict") throw err;
							}
						}
						return { kind: "refused" as const, reason: "conflict" };
					},
					async reportLifecycle(caller: HostedCaller, input: LifecycleArguments) {
						let channel = await auth.storage.channels.get(input.id);
						if (!channel) return { kind: "forbidden" as const };
						let repository = await directRepository(
							caller,
							channel.repositoryOwner,
							channel.repositoryName,
						);
						if (
							!repository
							|| repository.id !== channel.repositoryId
							|| (!repository.permissions.push && !repository.permissions.admin)
						) return { kind: "forbidden" as const };
						let { id: _id, ...event } = input;
						let live = Rooms.get(input.id)?.plan;
						if (live) {
							let result = await reportImplementationLifecycle(live, event);
							if (result.kind === "refused") return result;
							return {
								kind: result.kind,
								lifecycle: implementationLifecycle({
									graph: result.state.graph,
									execution: result.state.execution,
									lifecycle: result.state.lifecycle,
								}),
							};
						}
						for (let attempt = 0; attempt < 2; attempt++) {
							let stored = await auth.storage.collaboration.load(input.id, auth.clock());
							if (!stored?.snapshot) return { kind: "refused" as const, reason: "inactive" };
							let prepared = Plan.lifecycleStored(stored, event);
							if (prepared.result.kind === "refused") return prepared.result;
							if (prepared.result.kind === "replayed") {
								return {
									kind: "replayed" as const,
									lifecycle: implementationLifecycle({
										graph: prepared.result.state.graph,
										execution: prepared.result.state.execution,
										lifecycle: prepared.result.state.lifecycle,
									}),
								};
							}
							if (!prepared.sidecar) return { kind: "refused" as const, reason: "inactive" };
							try {
								await auth.storage.collaboration.commit({
									channelId: input.id,
									lease: persistence.lease(),
									expectedRevision: stored.channel.revision,
									operationId: `lifecycle:${input.idempotencyKey}`,
									epoch: stored.snapshot.epoch,
									sidecar: prepared.sidecar,
									events: [],
									now: auth.clock(),
								});
								return {
									kind: "accepted" as const,
									lifecycle: implementationLifecycle({
										graph: prepared.result.state.graph,
										execution: prepared.result.state.execution,
										lifecycle: prepared.result.state.lifecycle,
									}),
								};
							} catch (err) {
								if (!(err instanceof StorageError) || err.failure !== "conflict") throw err;
							}
						}
						return { kind: "refused" as const, reason: "conflict" };
					},
				},
			}
			: {}),
	};
}
