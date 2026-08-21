import type { HostedAuth } from "../auth/routes";
import type { HostedRepository } from "./repository";

const EXPIRY_SKEW_MS = 60_000;

type State = {
	channelId: string;
	channelEpoch: number;
	ownerSessionId: string;
	ownerGeneration: number;
	credentialRevision: number;
	repositoryId: string;
	repositoryOwner: string;
	repositoryName: string;
	expiresAt: Date;
	userId: string;
	controller: AbortController;
	timer?: ReturnType<typeof setTimeout>;
};

export type ActiveOwnerBinding = {
	channelId: string;
	token: string;
	repository: HostedRepository;
	ownerSessionId: string;
	ownerGeneration: number;
	credentialRevision: number;
	expiresAt: Date;
	signal: AbortSignal;
	currentToken: () => string | undefined;
	revalidate: () => Promise<boolean>;
	release: () => void;
};

function credentialKey(sessionId: string, revision: number): string {
	return `${sessionId}\u0000${revision}`;
}

/** Resolves only an existing durable Planner owner; it can never claim ownership. */
export class ActiveOwnerBindings {
	#auth: Pick<HostedAuth, "admission" | "clock" | "github" | "sessions" | "storage">;
	#states = new Set<State>();
	#channelEpochs = new Map<string, number>();
	#revokedSessions = new Set<string>();
	#revokedCredentials = new Set<string>();
	#closed = false;

	constructor(auth: Pick<HostedAuth, "admission" | "clock" | "github" | "sessions" | "storage">) {
		this.#auth = auth;
	}

	async resolve(channelId: string): Promise<ActiveOwnerBinding | undefined> {
		if (this.#closed) return undefined;
		let channelEpoch = this.#channelEpochs.get(channelId) ?? 0;
		let now = this.#auth.clock();
		let stored = await this.#auth.storage.channels.readAgent(channelId, now);
		let ownerSessionId = stored?.agent?.ownerSessionId;
		if (!stored || !ownerSessionId || this.#revokedSessions.has(ownerSessionId)) return undefined;
		let ownerGeneration = stored.agent!.generation;
		let owner = await this.#auth.sessions.resolve(ownerSessionId);
		if (!owner || this.#revokedSessions.has(ownerSessionId)) return undefined;
		let checked = await this.#auth.sessions.use(
			owner,
			token =>
				this.#auth.github.repositoryAccess(
					token,
					stored.channel.repositoryOwner,
					stored.channel.repositoryName,
				),
		);
		owner = checked.authenticated;
		let repository = checked.value;
		if (
			!repository
			|| repository.id !== stored.channel.repositoryId
			|| (!repository.permissions.push && !repository.permissions.admin)
		) return undefined;
		if (!await this.#auth.admission.allowed(owner.access.token, owner.user.id)) return undefined;
		let expiresAt = new Date(
			Math.min(owner.access.expiresAt.getTime(), owner.session.expiresAt.getTime()),
		);
		if (expiresAt.getTime() <= this.#auth.clock().getTime() + EXPIRY_SKEW_MS) return undefined;
		let credentialRevision = owner.access.revision;
		let credential = credentialKey(ownerSessionId, credentialRevision);
		let current = await this.#auth.sessions.inspect(ownerSessionId);
		let latest = await this.#auth.storage.channels.readAgent(channelId, this.#auth.clock());
		if (
			!current
			|| current.access.revision !== credentialRevision
			|| !this.#auth.sessions.token(ownerSessionId, credentialRevision)
			|| latest?.agent?.ownerSessionId !== ownerSessionId
			|| latest.agent.generation !== ownerGeneration
			|| latest.channel.repositoryId !== repository.id
			|| this.#revokedSessions.has(ownerSessionId)
			|| this.#revokedCredentials.has(credential)
			|| this.#closed
			|| (this.#channelEpochs.get(channelId) ?? 0) !== channelEpoch
		) return undefined;

		let state: State = {
			channelId,
			channelEpoch,
			ownerSessionId,
			ownerGeneration,
			credentialRevision,
			repositoryId: repository.id,
			repositoryOwner: repository.owner,
			repositoryName: repository.name,
			expiresAt,
			userId: owner.user.id,
			controller: new AbortController(),
		};
		let delay = Math.max(0, expiresAt.getTime() - this.#auth.clock().getTime() - EXPIRY_SKEW_MS);
		state.timer = setTimeout(
			() => this.#abort(state, "credential-expired"),
			Math.min(delay, 2_147_483_647),
		);
		this.#states.add(state);
		let release = () => this.#abort(state, "released");
		return {
			channelId,
			token: owner.access.token,
			repository: {
				id: repository.id,
				owner: repository.owner,
				name: repository.name,
				defaultBranch: repository.defaultBranch,
			},
			ownerSessionId,
			ownerGeneration,
			credentialRevision,
			expiresAt: new Date(expiresAt),
			signal: state.controller.signal,
			currentToken: () => this.#currentToken(state),
			revalidate: () => this.#revalidate(state),
			release,
		};
	}

	revokeChannel(channelId: string): void {
		this.#channelEpochs.set(channelId, (this.#channelEpochs.get(channelId) ?? 0) + 1);
		for (let state of this.#states) {
			if (state.channelId === channelId) this.#abort(state, "owner-reset");
		}
	}

	revokeSession(sessionId: string): void {
		this.#revokedSessions.add(sessionId);
		for (let state of this.#states) {
			if (state.ownerSessionId === sessionId) this.#abort(state, "session-revoked");
		}
	}

	revokeCredential(sessionId: string, revision: number): void {
		this.#revokedCredentials.add(credentialKey(sessionId, revision));
		for (let state of this.#states) {
			if (state.ownerSessionId === sessionId && state.credentialRevision === revision) {
				this.#abort(state, "credential-rotated");
			}
		}
	}

	revokeAll(): void {
		this.#closed = true;
		for (let state of this.#states) this.#abort(state, "runtime-stopped");
	}

	#currentToken(state: State): string | undefined {
		if (!this.#locallyActive(state)) return undefined;
		return this.#auth.sessions.token(state.ownerSessionId, state.credentialRevision);
	}

	async #revalidate(state: State): Promise<boolean> {
		let token = this.#currentToken(state);
		if (!token) return false;
		let owner = await this.#auth.sessions.inspect(state.ownerSessionId);
		if (!owner || owner.access.revision !== state.credentialRevision) return false;
		if (!await this.#auth.admission.allowed(token, state.userId)) return false;
		let repository = await this.#auth.github.repositoryAccess(
			token,
			state.repositoryOwner,
			state.repositoryName,
		);
		if (
			!repository
			|| repository.id !== state.repositoryId
			|| (!repository.permissions.push && !repository.permissions.admin)
		) return false;
		let stored = await this.#auth.storage.channels.readAgent(state.channelId, this.#auth.clock());
		let current = await this.#auth.sessions.inspect(state.ownerSessionId);
		return this.#locallyActive(state)
			&& current?.access.revision === state.credentialRevision
			&& stored?.agent?.ownerSessionId === state.ownerSessionId
			&& stored.agent.generation === state.ownerGeneration
			&& stored.channel.repositoryId === state.repositoryId;
	}

	#locallyActive(state: State): boolean {
		return !this.#closed
			&& !state.controller.signal.aborted
			&& state.expiresAt.getTime() > this.#auth.clock().getTime() + EXPIRY_SKEW_MS
			&& !this.#revokedSessions.has(state.ownerSessionId)
			&& !this.#revokedCredentials.has(
				credentialKey(state.ownerSessionId, state.credentialRevision),
			)
			&& (this.#channelEpochs.get(state.channelId) ?? 0) === state.channelEpoch;
	}

	#abort(state: State, reason: string): void {
		if (state.timer) clearTimeout(state.timer);
		state.timer = undefined;
		this.#states.delete(state);
		if (!state.controller.signal.aborted) state.controller.abort(new Error(reason));
	}
}
