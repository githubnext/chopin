import { conflict, missing } from "../errors";
import { documentSlug, documentSlugCandidate } from "../../channels/slug";
import { MemoryBackgroundJobStore } from "./jobs";

import type {
	AddUserProject,
	AddUserProjectResult,
	AgentState,
	ChannelCursor,
	ChannelPage,
	ChannelRecord,
	ChannelScanCursor,
	ChannelScanPage,
	ChannelSnapshot,
	ChannelUpdate,
	CommitChannel,
	CommitResult,
	CreateChannel,
	JsonValue,
	Lease,
	RecordNavigationVisit,
	RenameChannel,
	RenameResult,
	ReplaceChannel,
	SaveCheckpoint,
	StoredChannel,
	StoredEvent,
	UpdateAgentContext,
	UserNavigation,
	UserProject,
	UserRecord,
	WebSession,
} from "../model";
import type {
	BackgroundJobStore,
	ChannelStore,
	CollaborationStore,
	LeaseStore,
	NavigationStore,
	SessionStore,
	StorageAdapter,
	UserStore,
} from "../port";

function bytes(value: Uint8Array): Uint8Array {
	return new Uint8Array(value);
}

function json(value: JsonValue): JsonValue {
	return structuredClone(value);
}

function user(value: UserRecord): UserRecord {
	return { ...value, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) };
}

function session(value: WebSession): WebSession {
	return {
		...value,
		expiresAt: new Date(value.expiresAt),
		createdAt: new Date(value.createdAt),
	};
}

function project(value: UserProject): UserProject {
	return { ...value, addedAt: new Date(value.addedAt) };
}

function navigation(value: UserNavigation): UserNavigation {
	return { ...value, updatedAt: new Date(value.updatedAt) };
}

function channel(value: ChannelRecord): ChannelRecord {
	return { ...value, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt) };
}

function snapshot(value: ChannelSnapshot): ChannelSnapshot {
	return {
		...value,
		document: bytes(value.document),
		sidecar: json(value.sidecar),
		createdAt: new Date(value.createdAt),
	};
}

function agent(value: AgentState): AgentState {
	return { ...value, updatedAt: new Date(value.updatedAt) };
}

function lease(value: Lease): Lease {
	return { ...value, expiresAt: new Date(value.expiresAt) };
}

type Operation = CommitResult;

/** A strict in-memory adapter used by domain tests, not a production fallback. */
export class MemoryStorage implements StorageAdapter {
	readonly driver = "memory";

	#users = new Map<string, UserRecord>();
	#sessions = new Map<string, WebSession>();
	#projects = new Map<string, UserProject[]>();
	#navigation = new Map<string, UserNavigation>();
	#channels = new Map<string, ChannelRecord>();
	#channelSlugs = new Map<string, Map<string, string>>();
	#snapshots = new Map<string, ChannelSnapshot>();
	#sequences = new Map<string, number>();
	#updates = new Map<string, ChannelUpdate[]>();
	#events = new Map<string, StoredEvent[]>();
	#sidecars = new Map<string, JsonValue>();
	#operations = new Map<string, Map<string, Operation>>();
	#agents = new Map<string, AgentState>();
	#leases = new Map<string, Lease>();

	readonly users: UserStore = {
		put: input => {
			let previous = this.#users.get(input.id);
			let saved: UserRecord = {
				id: input.id,
				login: input.login,
				avatarUrl: input.avatarUrl,
				createdAt: previous?.createdAt ?? input.now,
				updatedAt: input.now,
			};
			this.#users.set(saved.id, saved);
			return Promise.resolve(user(saved));
		},
		get: id => Promise.resolve(this.#users.get(id)).then(value => value && user(value)),
	};

	readonly sessions: SessionStore = {
		create: input => {
			if (!this.#users.has(input.userId)) throw missing(`user ${input.userId} does not exist`);
			if (this.#sessions.has(input.id)) throw conflict(`session ${input.id} already exists`);
			this.#sessions.set(input.id, session(input));
			return Promise.resolve();
		},
		get: (id, now) => {
			let found = this.#sessions.get(id);
			return Promise.resolve(found && found.expiresAt > now ? session(found) : undefined);
		},
		delete: id => {
			let deleted = this.#sessions.delete(id);
			if (deleted) this.#expireOwners(new Set([id]), new Date());
			return Promise.resolve(deleted);
		},
		deleteExpired: now => {
			let expired = new Set<string>();
			for (let [id, value] of this.#sessions) {
				if (value.expiresAt <= now) {
					this.#sessions.delete(id);
					expired.add(id);
				}
			}
			this.#expireOwners(expired, now);
			return Promise.resolve(expired.size);
		},
		deleteAll: async (now, held, ttlMs) => {
			this.#assertLease(held);
			let deleted = new Set(this.#sessions.keys());
			this.#sessions.clear();
			this.#expireOwners(deleted, now);
			let renewed = await this.#renew(held, ttlMs);
			if (!renewed) throw conflict(`storage lease ${held.name} is no longer held`);
			return { deleted: deleted.size, lease: renewed };
		},
	};

	readonly navigation: NavigationStore = {
		projects: userId => {
			this.#requireUser(userId);
			return Promise.resolve((this.#projects.get(userId) ?? []).map(project));
		},
		addProject: input => this.#addProject(input),
		get: userId => {
			this.#requireUser(userId);
			let found = this.#navigation.get(userId);
			return Promise.resolve(found && navigation(found));
		},
		setLastDocument: (userId, documentId, now) => this.#setLastDocument(userId, documentId, now),
		recordVisit: input => this.#recordVisit(input),
	};

	readonly channels: ChannelStore = {
		create: input => this.#createChannel(input),
		get: id => Promise.resolve(this.#channels.get(id)).then(value => value && channel(value)),
		resolve: (repositoryId, slug) => {
			let id = this.#channelSlugs.get(repositoryId)?.get(slug);
			let found = id ? this.#channels.get(id) : undefined;
			return Promise.resolve(found && channel(found));
		},
		rename: input => this.#renameChannel(input),
		list: (repositoryId, limit, after, query) =>
			this.#listChannels(repositoryId, limit, after, query),
		scan: (repositoryId, limit, after) => this.#scanChannels(repositoryId, limit, after),
		claimAgentOwner: (channelId, sessionId, now) =>
			this.#claimAgentOwner(channelId, sessionId, now),
		clearAgentOwner: (channelId, expectedSessionId, expectedGeneration, now) =>
			this.#clearAgentOwner(channelId, expectedSessionId, expectedGeneration, now),
		updateAgentContext: context => this.#updateAgentContext(context),
		readAgent: (channelId, now) => this.#readAgent(channelId, now),
	};

	readonly collaboration: CollaborationStore = {
		load: (channelId, now) => this.#load(channelId, now),
		commit: input => this.#commit(input),
		replace: input => this.#replace(input),
		checkpoint: input => this.#checkpoint(input),
	};

	readonly jobs: BackgroundJobStore = new MemoryBackgroundJobStore({
		channelExists: channelId => this.#channels.has(channelId),
		assertLease: held => this.#assertLease(held),
	});

	readonly leases: LeaseStore = {
		acquire: (name, owner, ttlMs) => this.#acquire(name, owner, ttlMs),
		renew: (held, ttlMs) => this.#renew(held, ttlMs),
		release: held => this.#release(held),
	};

	async migrate(): Promise<void> {}

	async health(): Promise<void> {}

	async close(): Promise<void> {}

	#expireOwners(expired: Set<string>, now: Date): void {
		if (expired.size === 0) return;
		for (let [id, state] of this.#agents) {
			if (state.ownerSessionId && expired.has(state.ownerSessionId)) {
				this.#agents.set(id, {
					...state,
					ownerSessionId: undefined,
					status: "unavailable",
					updatedAt: now,
				});
			}
		}
	}

	#requireUser(userId: string): void {
		if (!this.#users.has(userId)) throw missing(`user ${userId} does not exist`);
	}

	#addProject(input: AddUserProject): Promise<AddUserProjectResult> {
		this.#requireUser(input.userId);
		let projects = this.#projects.get(input.userId) ?? [];
		let existing = projects.find(project => project.repositoryId === input.repositoryId);
		if (existing) return Promise.resolve({ project: project(existing), added: false });
		let saved: UserProject = {
			userId: input.userId,
			repositoryId: input.repositoryId,
			repositoryOwner: input.repositoryOwner,
			repositoryName: input.repositoryName,
			position: Math.max(-1, ...projects.map(project => project.position)) + 1,
			addedAt: input.now,
		};
		this.#projects.set(input.userId, [...projects, saved]);
		return Promise.resolve({ project: project(saved), added: true });
	}

	async #setLastDocument(
		userId: string,
		documentId: string | undefined,
		now: Date,
	): Promise<UserNavigation> {
		this.#requireUser(userId);
		if (documentId && !this.#channels.has(documentId)) {
			throw missing(`channel ${documentId} does not exist`);
		}
		let saved: UserNavigation = { userId, lastDocumentId: documentId, updatedAt: now };
		this.#navigation.set(userId, saved);
		return navigation(saved);
	}

	async #recordVisit(input: RecordNavigationVisit): Promise<UserNavigation> {
		this.#requireUser(input.userId);
		let document = this.#channels.get(input.documentId);
		if (!document || document.repositoryId !== input.repositoryId) {
			throw missing(
				`channel ${input.documentId} does not exist in repository ${input.repositoryId}`,
			);
		}
		await this.#addProject(input);
		return this.#setLastDocument(input.userId, input.documentId, input.now);
	}

	async #createChannel(input: CreateChannel): Promise<ChannelRecord> {
		if (!this.#users.has(input.createdBy)) throw missing(`user ${input.createdBy} does not exist`);
		if (this.#channels.has(input.id)) throw conflict(`channel ${input.id} already exists`);
		if (
			[...this.#channels.values()].some(channel =>
				channel.repositoryId === input.repositoryId
				&& channel.title.toLowerCase() === input.title.toLowerCase()
			)
		) throw conflict(`channel title ${input.title} already exists in this repository`);
		let { initial, now, ...record } = input;
		let slug = this.#reserveSlug(input.repositoryId, input.id, input.title);
		let saved: ChannelRecord = {
			...record,
			slug,
			revision: 0,
			createdAt: now,
			updatedAt: now,
		};
		this.#channels.set(saved.id, saved);
		this.#sequences.set(saved.id, 1);
		this.#sidecars.set(saved.id, initial ? json(initial.sidecar) : null);
		if (initial) {
			this.#snapshots.set(saved.id, {
				channelId: saved.id,
				...initial,
				revision: 0,
				throughSequence: 0,
				document: bytes(initial.document),
				sidecar: json(initial.sidecar),
				createdAt: now,
			});
		}
		return channel(saved);
	}

	async #renameChannel(input: RenameChannel): Promise<RenameResult> {
		let found = this.#channels.get(input.id);
		if (!found) throw missing(`channel ${input.id} does not exist`);
		if (found.title === input.title) return { channel: channel(found), changed: false };
		if (
			[...this.#channels.values()].some(value =>
				value.id !== found.id
				&& value.repositoryId === found.repositoryId
				&& value.title.toLowerCase() === input.title.toLowerCase()
			)
		) throw conflict(`channel title ${input.title} already exists in this repository`);
		let updatedAt = input.now > found.updatedAt
			? input.now
			: new Date(found.updatedAt.getTime() + 1);
		let slug = this.#reserveSlug(found.repositoryId, found.id, input.title);
		let saved = { ...found, title: input.title, slug, updatedAt };
		this.#channels.set(saved.id, saved);
		return { channel: channel(saved), changed: true };
	}

	#reserveSlug(repositoryId: string, channelId: string, title: string): string {
		let aliases = this.#channelSlugs.get(repositoryId);
		if (!aliases) {
			aliases = new Map();
			this.#channelSlugs.set(repositoryId, aliases);
		}
		let base = documentSlug(title);
		for (let index = 1;; index++) {
			let candidate = documentSlugCandidate(base, index);
			let owner = aliases.get(candidate);
			if (owner && owner !== channelId) continue;
			aliases.set(candidate, channelId);
			return candidate;
		}
	}

	#listChannels(
		repositoryId: string,
		limit: number,
		after?: ChannelCursor,
		query?: string,
	): Promise<ChannelPage> {
		let count = Math.min(100, Math.max(1, limit));
		let ordered = [...this.#channels.values()]
			.filter(value => value.repositoryId === repositoryId)
			.filter(value => !query || value.title.toLowerCase().includes(query.toLowerCase()))
			.sort((left, right) =>
				right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id)
			);
		if (after) {
			ordered = ordered.filter(value =>
				value.updatedAt < after.updatedAt
				|| (value.updatedAt.getTime() === after.updatedAt.getTime() && value.id > after.id)
			);
		}
		let page = ordered.slice(0, count);
		let last = page.at(-1);
		return Promise.resolve({
			channels: page.map(channel),
			next: ordered.length > page.length && last
				? { updatedAt: new Date(last.updatedAt), id: last.id }
				: undefined,
		});
	}

	#scanChannels(
		repositoryId: string,
		limit: number,
		after?: ChannelScanCursor,
	): Promise<ChannelScanPage> {
		let count = Math.min(100, Math.max(1, limit));
		let ordered = [...this.#channels.values()]
			.filter(value => value.repositoryId === repositoryId)
			.sort((left, right) =>
				right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id)
			);
		if (after) {
			ordered = ordered.filter(value =>
				value.createdAt < after.createdAt
				|| (value.createdAt.getTime() === after.createdAt.getTime() && value.id > after.id)
			);
		}
		let page = ordered.slice(0, count);
		let last = page.at(-1);
		return Promise.resolve({
			channels: page.map(channel),
			next: ordered.length > page.length && last
				? { createdAt: new Date(last.createdAt), id: last.id }
				: undefined,
		});
	}

	#claimAgentOwner(channelId: string, sessionId: string, now: Date): Promise<AgentState> {
		if (!this.#channels.has(channelId)) throw missing(`channel ${channelId} does not exist`);
		let owner = this.#sessions.get(sessionId);
		if (!owner || owner.expiresAt <= now) throw missing(`session ${sessionId} is not active`);
		let existing = this.#agents.get(channelId);
		if (existing?.ownerSessionId) return Promise.resolve(agent(existing));
		let saved: AgentState = {
			channelId,
			ownerSessionId: sessionId,
			generation: (existing?.generation ?? 0) + 1,
			summary: existing?.summary ?? "",
			transcriptCursor: existing?.transcriptCursor ?? 0,
			status: "ready",
			updatedAt: now,
		};
		this.#agents.set(channelId, saved);
		return Promise.resolve(agent(saved));
	}

	#clearAgentOwner(
		channelId: string,
		expectedSessionId: string,
		expectedGeneration: number,
		now: Date,
	): Promise<boolean> {
		let existing = this.#agents.get(channelId);
		if (
			!existing
			|| existing.ownerSessionId !== expectedSessionId
			|| existing.generation !== expectedGeneration
		) return Promise.resolve(false);
		this.#agents.set(channelId, {
			...existing,
			ownerSessionId: undefined,
			status: "unavailable",
			updatedAt: now,
		});
		return Promise.resolve(true);
	}

	#updateAgentContext(input: UpdateAgentContext): Promise<AgentState> {
		let existing = this.#agents.get(input.channelId);
		let owner = this.#sessions.get(input.ownerSessionId);
		if (
			!existing
			|| existing.ownerSessionId !== input.ownerSessionId
			|| existing.generation !== input.generation
			|| !owner
			|| owner.expiresAt <= input.now
		) {
			throw conflict(`agent owner changed for channel ${input.channelId}`);
		}
		let saved: AgentState = {
			channelId: input.channelId,
			ownerSessionId: input.ownerSessionId,
			generation: input.generation,
			summary: input.summary,
			transcriptCursor: input.transcriptCursor,
			status: input.status,
			updatedAt: input.now,
		};
		this.#agents.set(input.channelId, saved);
		return Promise.resolve(agent(saved));
	}

	#readAgent(channelId: string, now: Date) {
		let found = this.#channels.get(channelId);
		if (!found) return Promise.resolve(undefined);
		let state = this.#agents.get(channelId);
		let saved = state && agent(state);
		if (saved?.ownerSessionId) {
			let owner = this.#sessions.get(saved.ownerSessionId);
			if (!owner || owner.expiresAt <= now) {
				saved = { ...saved, ownerSessionId: undefined, status: "unavailable" };
			}
		}
		return Promise.resolve({ channel: channel(found), agent: saved });
	}

	#load(channelId: string, now: Date): Promise<StoredChannel | undefined> {
		let found = this.#channels.get(channelId);
		if (!found) return Promise.resolve(undefined);
		let storedAgent = this.#agents.get(channelId) ? agent(this.#agents.get(channelId)!) : undefined;
		if (storedAgent?.ownerSessionId) {
			let owner = this.#sessions.get(storedAgent.ownerSessionId);
			if (!owner || owner.expiresAt <= now) {
				storedAgent = { ...storedAgent, ownerSessionId: undefined, status: "unavailable" };
			}
		}
		return Promise.resolve({
			channel: channel(found),
			latestSequence: (this.#sequences.get(channelId) ?? 1) - 1,
			snapshot: this.#snapshots.get(channelId)
				? snapshot(this.#snapshots.get(channelId)!)
				: undefined,
			updates: (this.#updates.get(channelId) ?? []).map(value => ({
				...value,
				update: bytes(value.update),
			})),
			events: (this.#events.get(channelId) ?? []).map(value => ({
				...value,
				payload: json(value.payload),
				createdAt: new Date(value.createdAt),
			})),
			sidecar: json(this.#sidecars.get(channelId) ?? null),
			agent: storedAgent,
		});
	}

	#commit(input: CommitChannel): Promise<CommitResult> {
		this.#assertLease(input.lease);
		let found = this.#channels.get(input.channelId);
		if (!found) throw missing(`channel ${input.channelId} does not exist`);
		let operations = this.#operations.get(input.channelId) ?? new Map<string, Operation>();
		this.#operations.set(input.channelId, operations);
		let repeated = operations.get(input.operationId);
		if (repeated) return Promise.resolve({ ...repeated, repeated: true });
		if (found.revision !== input.expectedRevision) {
			throw conflict(
				`channel ${input.channelId} is at revision ${found.revision}, expected ${input.expectedRevision}`,
			);
		}
		let existingEvents = this.#events.get(input.channelId) ?? [];
		let eventIds = new Set(existingEvents.map(value => value.id));
		for (let item of input.events) {
			if (eventIds.has(item.id)) {
				throw conflict(`channel ${input.channelId} already has event ${item.id}`);
			}
			eventIds.add(item.id);
		}

		let sequence = this.#sequences.get(input.channelId) ?? 1;
		let revision = found.revision + 1;
		if (input.update) {
			let updates = this.#updates.get(input.channelId) ?? [];
			updates.push({
				channelId: input.channelId,
				sequence,
				revision,
				epoch: input.epoch,
				update: bytes(input.update),
			});
			this.#updates.set(input.channelId, updates);
		}
		if (input.sidecar !== undefined) this.#sidecars.set(input.channelId, json(input.sidecar));
		if (input.events.length > 0) {
			existingEvents.push(...input.events.map((event, ordinal) => ({
				...event,
				channelId: input.channelId,
				sequence,
				ordinal,
				payload: json(event.payload),
				createdAt: new Date(event.createdAt),
			})));
			this.#events.set(input.channelId, existingEvents);
		}
		this.#channels.set(input.channelId, {
			...found,
			revision,
			updatedAt: new Date(Math.max(found.updatedAt.getTime(), input.now.getTime())),
		});
		this.#sequences.set(input.channelId, sequence + 1);
		let result = { revision, sequence, repeated: false };
		operations.set(input.operationId, result);
		return Promise.resolve(result);
	}

	#checkpoint(input: SaveCheckpoint): Promise<void> {
		this.#assertLease(input.lease);
		let found = this.#channels.get(input.channelId);
		if (!found) throw missing(`channel ${input.channelId} does not exist`);
		if (found.revision !== input.expectedRevision || input.revision !== input.expectedRevision) {
			throw conflict(`channel ${input.channelId} changed before its checkpoint`);
		}
		let previous = this.#snapshots.get(input.channelId);
		if (previous && previous.throughSequence > input.throughSequence) {
			throw conflict(`channel ${input.channelId} already has a newer checkpoint`);
		}
		let lastSequence = (this.#sequences.get(input.channelId) ?? 1) - 1;
		if (input.throughSequence > lastSequence) {
			throw conflict(`checkpoint for channel ${input.channelId} is ahead of its journal`);
		}
		this.#snapshots.set(input.channelId, snapshot(input));
		this.#updates.set(
			input.channelId,
			(this.#updates.get(input.channelId) ?? []).filter(
				value => value.sequence > input.throughSequence,
			),
		);
		return Promise.resolve();
	}

	#replace(input: ReplaceChannel): Promise<CommitResult> {
		this.#assertLease(input.lease);
		let found = this.#channels.get(input.channelId);
		if (!found) throw missing(`channel ${input.channelId} does not exist`);
		let operations = this.#operations.get(input.channelId) ?? new Map<string, Operation>();
		this.#operations.set(input.channelId, operations);
		let repeated = operations.get(input.operationId);
		if (repeated) return Promise.resolve({ ...repeated, repeated: true });
		if (found.revision !== input.expectedRevision) {
			throw conflict(
				`channel ${input.channelId} is at revision ${found.revision}, expected ${input.expectedRevision}`,
			);
		}
		let sequence = this.#sequences.get(input.channelId) ?? 1;
		let revision = found.revision + 1;
		this.#sidecars.set(input.channelId, json(input.sidecar));
		this.#snapshots.set(input.channelId, {
			channelId: input.channelId,
			generation: input.generation,
			revision,
			throughSequence: sequence,
			epoch: input.epoch,
			source: input.source,
			sourceHash: input.sourceHash,
			document: bytes(input.document),
			sidecar: json(input.sidecar),
			createdAt: input.now,
		});
		this.#updates.set(input.channelId, []);
		this.#channels.set(input.channelId, {
			...found,
			revision,
			updatedAt: new Date(Math.max(found.updatedAt.getTime(), input.now.getTime())),
		});
		this.#sequences.set(input.channelId, sequence + 1);
		let result = { revision, sequence, repeated: false };
		operations.set(input.operationId, result);
		return Promise.resolve(result);
	}

	#acquire(name: string, owner: string, ttlMs: number): Promise<Lease | undefined> {
		let now = new Date();
		let existing = this.#leases.get(name);
		if (existing && existing.expiresAt > now && existing.owner !== owner) {
			return Promise.resolve(undefined);
		}
		let saved: Lease = {
			name,
			owner,
			fencing: existing && existing.owner === owner && existing.expiresAt > now
				? existing.fencing
				: (existing?.fencing ?? 0) + 1,
			expiresAt: new Date(now.getTime() + ttlMs),
		};
		this.#leases.set(name, saved);
		return Promise.resolve(lease(saved));
	}

	#renew(held: Lease, ttlMs: number): Promise<Lease | undefined> {
		let now = new Date();
		let existing = this.#leases.get(held.name);
		if (
			!existing
			|| existing.owner !== held.owner
			|| existing.fencing !== held.fencing
			|| existing.expiresAt <= now
		) return Promise.resolve(undefined);
		let saved = { ...existing, expiresAt: new Date(now.getTime() + ttlMs) };
		this.#leases.set(held.name, saved);
		return Promise.resolve(lease(saved));
	}

	#release(held: Lease): Promise<boolean> {
		let existing = this.#leases.get(held.name);
		if (!existing || existing.owner !== held.owner || existing.fencing !== held.fencing) {
			return Promise.resolve(false);
		}
		this.#leases.set(held.name, { ...existing, expiresAt: new Date(0) });
		return Promise.resolve(true);
	}

	#assertLease(held: Lease): void {
		let now = new Date();
		let existing = this.#leases.get(held.name);
		if (
			!existing
			|| existing.owner !== held.owner
			|| existing.fencing !== held.fencing
			|| existing.expiresAt <= now
		) throw conflict(`storage lease ${held.name} is no longer held`);
	}
}
