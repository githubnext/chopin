import { conflict, missing } from "../errors";

import type {
	BackgroundJob,
	BackgroundJobArtifact,
	BackgroundJobCursor,
	BackgroundJobDetail,
	BackgroundJobPage,
	BackgroundJobState,
	BackgroundJobSummary,
	BackgroundJobTarget,
	ClaimBackgroundJobs,
	ClaimedBackgroundJob,
	ControlBackgroundJob,
	EnqueueBackgroundJob,
	FailBackgroundJob,
	JsonValue,
	Lease,
	PauseBackgroundJob,
	RenewBackgroundJob,
	RequeueBackgroundJob,
	ResumeBackgroundJob,
	SettleBackgroundJob,
	SupersedeBackgroundJob,
} from "../model";
import type { BackgroundJobStore } from "../port";

type Options = {
	channelExists: (channelId: string) => boolean;
	assertLease: (lease: Lease) => void;
};

function json(value: JsonValue): JsonValue {
	return structuredClone(value);
}

function job(value: BackgroundJob): BackgroundJob {
	return {
		...value,
		input: json(value.input),
		claimBinding: value.claimBinding === undefined ? undefined : json(value.claimBinding),
		claimExpiresAt: value.claimExpiresAt && new Date(value.claimExpiresAt),
		availableAt: new Date(value.availableAt),
		createdAt: new Date(value.createdAt),
		updatedAt: new Date(value.updatedAt),
	};
}

function summary(value: BackgroundJob): BackgroundJobSummary {
	let { claimBinding: _, fingerprint: _fingerprint, idempotencyKey: _key, input: _input, ...rest } =
		job(value);
	return rest;
}

function artifact(value: BackgroundJobArtifact): BackgroundJobArtifact {
	return { ...value, value: json(value.value), createdAt: new Date(value.createdAt) };
}

function active(state: BackgroundJobState): boolean {
	return state === "pending" || state === "paused" || state === "running";
}

function key(channelId: string, value: string): string {
	return `${channelId}\u0000${value}`;
}

function compareId(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Provider-independent job state machine used by the memory contract adapter. */
export class MemoryBackgroundJobStore implements BackgroundJobStore {
	#options: Options;
	#revisions = new Map<string, number>();
	#targets = new Map<string, BackgroundJobTarget>();
	#jobs = new Map<string, BackgroundJob>();
	#idempotency = new Map<string, string>();
	#artifacts = new Map<string, BackgroundJobArtifact>();

	constructor(options: Options) {
		this.#options = options;
	}

	readonly enqueue = async (
		input: EnqueueBackgroundJob,
	): Promise<{ job: BackgroundJob; repeated: boolean }> => {
		this.#write(input.channelId, input.lease);
		let idempotency = key(input.channelId, input.idempotencyKey);
		let repeatedId = this.#idempotency.get(idempotency);
		if (repeatedId !== undefined) {
			let repeated = this.#jobs.get(repeatedId)!;
			if (repeated.fingerprint !== input.fingerprint) {
				throw conflict(`background job idempotency key ${input.idempotencyKey} was reused`);
			}
			return { job: job(repeated), repeated: true };
		}
		if (
			!input.id || !input.type || !input.targetKey || !input.idempotencyKey || !input.fingerprint
		) {
			throw conflict("background job durable identifiers must not be empty");
		}
		if (this.#jobs.has(input.id)) throw conflict(`background job ${input.id} already exists`);
		if (!Number.isSafeInteger(input.version) || input.version < 1) {
			throw conflict("background job version must be a positive integer");
		}
		let targetKey = key(input.channelId, input.targetKey);
		let previousTarget = this.#targets.get(targetKey);
		let targetGeneration = (previousTarget?.generation ?? 0) + 1;
		let revision = this.#bump(input.channelId);
		this.#targets.set(targetKey, {
			channelId: input.channelId,
			targetKey: input.targetKey,
			generation: targetGeneration,
		});
		for (let previous of this.#jobs.values()) {
			if (
				previous.channelId === input.channelId
				&& previous.targetKey === input.targetKey
				&& previous.targetGeneration < targetGeneration
				&& active(previous.state)
			) {
				this.#jobs.set(previous.id, {
					...previous,
					state: "superseded",
					revision,
					claimOwner: undefined,
					claimBinding: undefined,
					claimExpiresAt: undefined,
					reason: undefined,
					updatedAt: new Date(input.now),
				});
			}
		}
		let saved: BackgroundJob = {
			id: input.id,
			channelId: input.channelId,
			type: input.type,
			version: input.version,
			origin: input.origin,
			targetKey: input.targetKey,
			targetGeneration,
			idempotencyKey: input.idempotencyKey,
			fingerprint: input.fingerprint,
			input: json(input.input),
			state: "pending",
			revision,
			attempts: 0,
			claimGeneration: 0,
			claimOwner: undefined,
			claimBinding: undefined,
			claimExpiresAt: undefined,
			availableAt: new Date(input.availableAt),
			reason: undefined,
			createdAt: new Date(input.now),
			updatedAt: new Date(input.now),
		};
		this.#jobs.set(saved.id, saved);
		this.#idempotency.set(idempotency, saved.id);
		return { job: job(saved), repeated: false };
	};

	readonly claim = async (input: ClaimBackgroundJobs): Promise<BackgroundJob[]> => {
		this.#options.assertLease(input.lease);
		if (input.channelId !== undefined && !input.channelId) {
			throw conflict("background job claim channel must not be empty");
		}
		if (!input.claimOwner) throw conflict("background job claim owner must not be empty");
		if (!Number.isSafeInteger(input.count) || input.count < 1) {
			throw conflict("background job claim count must be a positive integer");
		}
		if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1) {
			throw conflict("background job claim ttl must be a positive integer");
		}
		let count = Math.min(100, input.count);
		let eligible = [...this.#jobs.values()].filter(value => {
			if (input.channelId !== undefined && value.channelId !== input.channelId) return false;
			let target = this.#targets.get(key(value.channelId, value.targetKey));
			if (target?.generation !== value.targetGeneration) return false;
			return value.state === "pending" && value.availableAt <= input.now
				|| value.state === "running"
					&& !!value.claimExpiresAt && value.claimExpiresAt <= input.now;
		}).sort((left, right) => {
			let leftDue = left.state === "pending" ? left.availableAt : left.claimExpiresAt!;
			let rightDue = right.state === "pending" ? right.availableAt : right.claimExpiresAt!;
			return leftDue.getTime() - rightDue.getTime()
				|| left.createdAt.getTime() - right.createdAt.getTime()
				|| compareId(left.id, right.id);
		}).slice(0, count);
		let revisions = new Map<string, number>();
		for (let value of eligible) {
			revisions.set(value.channelId, revisions.get(value.channelId) ?? this.#bump(value.channelId));
		}
		return eligible.map(value => {
			let saved: BackgroundJob = {
				...value,
				state: "running",
				revision: revisions.get(value.channelId)!,
				attempts: value.attempts + 1,
				claimGeneration: value.claimGeneration + 1,
				claimOwner: input.claimOwner,
				claimBinding: undefined,
				claimExpiresAt: new Date(input.now.getTime() + input.ttlMs),
				reason: undefined,
				updatedAt: new Date(input.now),
			};
			this.#jobs.set(saved.id, saved);
			return job(saved);
		});
	};

	readonly renew = async (input: RenewBackgroundJob): Promise<BackgroundJob> => {
		this.#options.assertLease(input.lease);
		if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1) {
			throw conflict("background job claim ttl must be a positive integer");
		}
		let found = this.#claimed(input);
		let expiresAt = new Date(input.now.getTime() + input.ttlMs);
		if (
			found.revision !== input.expectedRevision
			|| input.now < found.updatedAt
			|| expiresAt <= found.claimExpiresAt!
		) throw conflict(`background job ${found.id} changed before its claim renewal`);
		let saved = {
			...found,
			revision: this.#bump(found.channelId),
			claimBinding: input.claimBinding === undefined ? undefined : json(input.claimBinding),
			claimExpiresAt: expiresAt,
			updatedAt: new Date(input.now),
		};
		this.#jobs.set(saved.id, saved);
		return job(saved);
	};

	readonly requeue = async (input: RequeueBackgroundJob): Promise<BackgroundJob> => {
		this.#options.assertLease(input.lease);
		let found = this.#claimed(input);
		return this.#claimTransition(found, "pending", input.now, input.reason, input.availableAt);
	};

	readonly settle = async (input: SettleBackgroundJob): Promise<BackgroundJobDetail> => {
		this.#options.assertLease(input.lease);
		let found = this.#claimed(input);
		if (this.#artifacts.has(found.id)) throw conflict(`background job ${found.id} already settled`);
		let revision = this.#bump(found.channelId);
		let saved = this.#clearClaim({
			...found,
			state: "completed",
			revision,
			reason: undefined,
			updatedAt: new Date(input.now),
		});
		let savedArtifact: BackgroundJobArtifact = {
			jobId: found.id,
			revision,
			value: json(input.artifact),
			createdAt: new Date(input.now),
		};
		this.#jobs.set(saved.id, saved);
		this.#artifacts.set(saved.id, savedArtifact);
		return this.#detail(saved)!;
	};

	readonly pause = async (input: PauseBackgroundJob): Promise<BackgroundJob> => {
		this.#options.assertLease(input.lease);
		let found = this.#controlled(input, ["pending", "running"]);
		return this.#controlTransition(found, "paused", input.now, input.reason);
	};

	readonly resume = async (input: ResumeBackgroundJob): Promise<BackgroundJob> => {
		this.#options.assertLease(input.lease);
		let found = this.#controlled(input, ["paused"]);
		return this.#controlTransition(found, "pending", input.now, undefined, input.availableAt);
	};

	readonly fail = async (input: FailBackgroundJob): Promise<BackgroundJob> => {
		this.#options.assertLease(input.lease);
		let found = this.#claimed(input);
		return this.#claimTransition(found, "failed", input.now, input.reason);
	};

	readonly cancel = async (input: ControlBackgroundJob): Promise<BackgroundJob> => {
		this.#options.assertLease(input.lease);
		let found = this.#controlled(input, ["pending", "paused", "running"]);
		return this.#controlTransition(found, "cancelled", input.now);
	};

	readonly supersede = async (input: SupersedeBackgroundJob): Promise<BackgroundJob> => {
		this.#options.assertLease(input.lease);
		let found = this.#controlled(input, ["pending", "paused", "running"]);
		return this.#controlTransition(found, "superseded", input.now, input.reason);
	};

	readonly list = async (
		channelId: string,
		limit: number,
		after?: BackgroundJobCursor,
	): Promise<BackgroundJobPage | undefined> => {
		if (!this.#options.channelExists(channelId)) return undefined;
		let count = Math.min(100, Math.max(1, limit));
		let ordered = [...this.#jobs.values()].filter(value => value.channelId === channelId).sort(
			(left, right) =>
				right.createdAt.getTime() - left.createdAt.getTime() || compareId(left.id, right.id),
		);
		if (after) {
			ordered = ordered.filter(value =>
				value.createdAt < after.createdAt
				|| value.createdAt.getTime() === after.createdAt.getTime() && value.id > after.id
			);
		}
		let page = ordered.slice(0, count);
		let last = page.at(-1);
		return {
			revision: this.#revisions.get(channelId) ?? 0,
			jobs: page.map(summary),
			next: ordered.length > page.length && last
				? { createdAt: new Date(last.createdAt), id: last.id }
				: undefined,
		};
	};

	readonly get = async (
		channelId: string,
		jobId: string,
	): Promise<BackgroundJobDetail | undefined> => {
		if (!this.#options.channelExists(channelId)) return undefined;
		let found = this.#jobs.get(jobId);
		return found?.channelId === channelId ? this.#detail(found) : undefined;
	};

	#write(channelId: string, held: Lease): void {
		this.#options.assertLease(held);
		if (!this.#options.channelExists(channelId)) {
			throw missing(`channel ${channelId} does not exist`);
		}
	}

	#bump(channelId: string): number {
		let revision = (this.#revisions.get(channelId) ?? 0) + 1;
		this.#revisions.set(channelId, revision);
		return revision;
	}

	#claimed(input: ClaimedBackgroundJob): BackgroundJob {
		let found = this.#require(input.channelId, input.jobId);
		let target = this.#targets.get(key(found.channelId, found.targetKey));
		if (
			found.state !== "running"
			|| found.claimOwner !== input.claimOwner
			|| found.claimGeneration !== input.claimGeneration
			|| !found.claimExpiresAt
			|| found.claimExpiresAt <= input.now
			|| target?.generation !== found.targetGeneration
		) throw conflict(`background job ${found.id} claim is no longer active`);
		return found;
	}

	#controlled(input: ControlBackgroundJob, allowed: BackgroundJobState[]): BackgroundJob {
		let found = this.#require(input.channelId, input.jobId);
		let target = this.#targets.get(key(found.channelId, found.targetKey));
		if (
			found.revision !== input.expectedRevision
			|| !allowed.includes(found.state)
			|| target?.generation !== found.targetGeneration
		) throw conflict(`background job ${found.id} changed`);
		return found;
	}

	#require(channelId: string, jobId: string): BackgroundJob {
		let found = this.#jobs.get(jobId);
		if (!found || found.channelId !== channelId) {
			throw missing(`background job ${jobId} does not exist`);
		}
		return found;
	}

	#claimTransition(
		found: BackgroundJob,
		state: BackgroundJobState,
		now: Date,
		reason?: string,
		availableAt = found.availableAt,
	): BackgroundJob {
		let saved = this.#clearClaim({
			...found,
			state,
			revision: this.#bump(found.channelId),
			availableAt: new Date(availableAt),
			reason,
			updatedAt: new Date(now),
		});
		this.#jobs.set(saved.id, saved);
		return job(saved);
	}

	#controlTransition(
		found: BackgroundJob,
		state: BackgroundJobState,
		now: Date,
		reason?: string,
		availableAt = found.availableAt,
	): BackgroundJob {
		return this.#claimTransition(found, state, now, reason, availableAt);
	}

	#clearClaim(value: BackgroundJob): BackgroundJob {
		return {
			...value,
			claimOwner: undefined,
			claimBinding: undefined,
			claimExpiresAt: undefined,
		};
	}

	#detail(value: BackgroundJob): BackgroundJobDetail | undefined {
		let target = this.#targets.get(key(value.channelId, value.targetKey));
		if (!target) return undefined;
		let savedArtifact = this.#artifacts.get(value.id);
		return {
			revision: this.#revisions.get(value.channelId) ?? 0,
			target: { ...target },
			job: job(value),
			artifact: savedArtifact && artifact(savedArtifact),
		};
	}
}
