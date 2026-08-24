import { StorageError } from "../storage/errors";
import { JobExecutionError } from "./registry";

import type { BackgroundJob, BackgroundJobCursor, JsonValue, Lease } from "../storage/model";
import type { StorageAdapter } from "../storage/port";
import type { JobDefinition, JobExecutionCredential, JobRegistry } from "./registry";
import type { JobService, JobView } from "./service";

export type ResolvedJobCredential = {
	credential: JobExecutionCredential;
	ownerKey: string | undefined;
	binding: JsonValue | undefined;
	signal?: AbortSignal;
	active: () => Promise<boolean>;
	release: () => void;
};

export type RunnerScheduler = {
	now: () => Date;
	after: (delayMs: number, action: () => void) => () => void;
};

export type JobRunnerOptions = {
	storage: StorageAdapter;
	service: JobService;
	registry: JobRegistry;
	lease: () => Lease;
	resolveActivePlanner: (
		job: Readonly<BackgroundJob>,
		signal: AbortSignal,
	) => Promise<ResolvedJobCredential | undefined>;
	enabled: boolean;
	globalConcurrency: number;
	ownerConcurrency: number;
	pollMs?: number;
	claimTtlMs?: number;
	heartbeatMs?: number;
	retryBaseMs?: number;
	retryMaxMs?: number;
	shutdownGraceMs?: number;
	id?: () => string;
	scheduler?: RunnerScheduler;
	changed?: (channelId: string) => void | Promise<void>;
	attemptFailed?: (job: Readonly<BackgroundJob>, err: unknown) => void | Promise<void>;
	fatal?: (err: unknown) => void;
};

type Attempt = {
	job: BackgroundJob;
	controller: AbortController;
	accepting: boolean;
	mutation: Promise<void>;
	heartbeat?: () => void;
	credential?: ResolvedJobCredential;
	releaseOwner?: () => void;
	execution?: Promise<JsonValue>;
	recovery?: Promise<void>;
	done: Promise<void>;
};

function positive(value: number, field: string, maximum = Number.MAX_SAFE_INTEGER): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new Error(`Background job runner ${field} must be an integer between 1 and ${maximum}.`);
	}
}

function defaultScheduler(): RunnerScheduler {
	return {
		now: () => new Date(),
		after(delayMs, action) {
			let timer = setTimeout(action, delayMs);
			return () => clearTimeout(timer);
		},
	};
}

function retryDelay(attempt: number, base: number, maximum: number): number {
	return Math.min(maximum, base * 2 ** Math.min(Math.max(0, attempt - 1), 18));
}

function expected(err: unknown): boolean {
	return err instanceof StorageError && (err.failure === "conflict" || err.failure === "missing");
}

function noop(): void {}

/** Claims and executes registered work without sharing Planner sessions or transcript state. */
export class JobRunner {
	#options:
		& Required<
			Pick<
				JobRunnerOptions,
				| "claimTtlMs"
				| "globalConcurrency"
				| "heartbeatMs"
				| "ownerConcurrency"
				| "pollMs"
				| "retryBaseMs"
				| "retryMaxMs"
				| "shutdownGraceMs"
			>
		>
		& JobRunnerOptions;
	#scheduler: RunnerScheduler;
	#claimOwner: string;
	#active = new Map<string, Attempt>();
	#attempts = new Set<Attempt>();
	#owners = new Map<string, number>();
	#started = false;
	#stopped = false;
	#dirty = false;
	#pump?: Promise<void>;
	#poll?: () => void;
	#ownerRecovery = new Map<string, () => void>();
	#blockedChannels = new Set<string>();
	#shutdown?: Promise<void>;
	#pollFailures = 0;

	constructor(options: JobRunnerOptions) {
		let values = {
			pollMs: options.pollMs ?? 1_000,
			claimTtlMs: options.claimTtlMs ?? 30_000,
			heartbeatMs: options.heartbeatMs ?? 10_000,
			retryBaseMs: options.retryBaseMs ?? 1_000,
			retryMaxMs: options.retryMaxMs ?? 300_000,
			shutdownGraceMs: options.shutdownGraceMs ?? 10_000,
			globalConcurrency: options.globalConcurrency,
			ownerConcurrency: options.ownerConcurrency,
		};
		positive(values.globalConcurrency, "global concurrency", 100);
		positive(values.ownerConcurrency, "owner concurrency", values.globalConcurrency);
		positive(values.pollMs, "poll interval");
		positive(values.claimTtlMs, "claim ttl");
		positive(values.heartbeatMs, "heartbeat interval");
		positive(values.retryBaseMs, "retry base");
		positive(values.retryMaxMs, "retry maximum");
		positive(values.shutdownGraceMs, "shutdown grace");
		if (values.heartbeatMs * 2 >= values.claimTtlMs) {
			throw new Error("Background job runner heartbeat must be less than half the claim ttl.");
		}
		if (values.shutdownGraceMs + values.heartbeatMs >= values.claimTtlMs) {
			throw new Error(
				"Background job runner shutdown grace plus heartbeat must be less than the claim ttl.",
			);
		}
		this.#options = { ...options, ...values };
		this.#scheduler = options.scheduler ?? defaultScheduler();
		this.#claimOwner = `jobs:${options.id?.() ?? crypto.randomUUID()}`;
	}

	start(): void {
		if (this.#started || this.#stopped || !this.#options.enabled) return;
		this.#started = true;
		this.wake();
	}

	wake(): void {
		if (!this.#started || this.#stopped) return;
		this.#dirty = true;
		this.#poll?.();
		this.#poll = undefined;
		if (this.#pump) return;
		queueMicrotask(() => {
			if (!this.#pump && this.#dirty && !this.#stopped) void this.#drain();
		});
	}

	notify(job: JobView): void {
		if (job.state === "pending") this.wake();
		for (let attempt of this.#active.values()) {
			let same = attempt.job.id === job.id;
			let superseded = attempt.job.channelId === job.channelId
				&& attempt.job.targetKey === job.targetKey
				&& attempt.job.targetGeneration < job.targetGeneration;
			if (same && job.state !== "running" || superseded) this.#detach(attempt, "job-changed");
		}
	}

	async ownerRevoked(ownerSessionId: string): Promise<void> {
		await Promise.all(
			[...this.#active.values()].filter(attempt =>
				attempt.credential?.credential.kind === "active-planner"
				&& attempt.credential.credential.ownerSessionId === ownerSessionId
			).map(attempt => this.#pause(attempt, "owner-unavailable")),
		);
	}

	async credentialsWillRotate(ownerSessionId: string, revision: number): Promise<void> {
		await Promise.all(
			[...this.#active.values()].filter(attempt =>
				attempt.credential?.credential.kind === "active-planner"
				&& attempt.credential.credential.ownerSessionId === ownerSessionId
				&& attempt.credential.credential.credentialRevision === revision
			).map(attempt => this.#retry(attempt, "credential-rotated", false)),
		);
	}

	async channelOwnerReset(channelId: string): Promise<void> {
		await Promise.all(
			[...this.#active.values()].filter(attempt =>
				attempt.job.channelId === channelId
				&& attempt.credential?.credential.kind === "active-planner"
			).map(attempt => this.#pause(attempt, "owner-unavailable")),
		);
	}

	/** Fence and cancel every job owned by a document before that document is deleted. */
	async cancelChannel(channelId: string): Promise<void> {
		this.#blockedChannels.add(channelId);
		this.#ownerRecovery.get(channelId)?.();
		this.#ownerRecovery.delete(channelId);
		let attempts = [...this.#attempts].filter(attempt => attempt.job.channelId === channelId);
		for (let attempt of attempts) this.#detach(attempt, "document-deleted");

		let cursor: BackgroundJobCursor | undefined;
		do {
			let page = await this.#options.service.list(channelId, 100, cursor);
			if (!page) break;
			for (let job of page.jobs) {
				if (job.state !== "pending" && job.state !== "paused" && job.state !== "running") continue;
				try {
					await this.#options.service.cancel({ channelId, jobId: job.id }, true);
				} catch (err) {
					if (!expected(err)) throw err;
				}
			}
			cursor = page.next;
		} while (cursor);
		await this.#withinGrace(Promise.allSettled(attempts.map(attempt => attempt.done)));
	}

	/** Used only when deletion failed before the channel row was removed. */
	unblockChannel(channelId: string): void {
		this.#blockedChannels.delete(channelId);
		this.wake();
	}

	async ownerAvailable(channelId: string): Promise<void> {
		this.#ownerRecovery.get(channelId)?.();
		this.#ownerRecovery.delete(channelId);
		try {
			let cursor: BackgroundJobCursor | undefined;
			do {
				let page = await this.#options.service.list(channelId, 100, cursor);
				if (!page) return;
				for (let job of page.jobs) {
					let definition = this.#options.registry.get(job.type, job.version);
					if (
						job.state !== "paused"
						|| (job.reason !== "owner-unavailable" && job.reason !== "unregistered-type")
						|| definition?.credential !== "active-planner"
					) continue;
					try {
						await this.#options.service.resume({
							channelId,
							jobId: job.id,
							expectedRevision: job.revision,
						});
					} catch (err) {
						if (!expected(err)) throw err;
					}
				}
				cursor = page.next;
			} while (cursor);
			this.wake();
		} catch (err) {
			this.#options.fatal?.(err);
			if (!this.#stopped && !this.#ownerRecovery.has(channelId)) {
				let cancel = this.#scheduler.after(this.#options.pollMs, () => {
					this.#ownerRecovery.delete(channelId);
					void this.ownerAvailable(channelId);
				});
				this.#ownerRecovery.set(channelId, cancel);
			}
		}
	}

	shutdown(): Promise<void> {
		if (this.#shutdown) return this.#shutdown;
		this.#stopped = true;
		this.#dirty = false;
		this.#poll?.();
		this.#poll = undefined;
		for (let cancel of this.#ownerRecovery.values()) cancel();
		this.#ownerRecovery.clear();
		let attempts = [...this.#attempts];
		let requeue = attempts.filter(attempt => attempt.accepting);
		for (let attempt of attempts) {
			attempt.accepting = false;
			attempt.heartbeat?.();
			attempt.controller.abort(new Error("runner-shutdown"));
		}
		return this.#shutdown = (async () => {
			await this.#pump?.catch(() => {});
			await Promise.all(requeue.map(attempt => this.#requeueStopped(attempt, "runner-shutdown")));
			await Promise.allSettled(
				attempts.flatMap(attempt => attempt.recovery ? [attempt.recovery] : []),
			);
			await this.#withinGrace(Promise.allSettled(attempts.map(attempt => attempt.done)));
		})();
	}

	async #drain(): Promise<void> {
		if (this.#pump || this.#stopped) return;
		this.#pump = (async () => {
			while (this.#dirty && !this.#stopped) {
				this.#dirty = false;
				let capacity = this.#options.globalConcurrency - this.#attempts.size;
				if (capacity < 1) continue;
				try {
					let claimed = await this.#options.storage.jobs.claim({
						claimOwner: this.#claimOwner,
						count: capacity,
						ttlMs: this.#options.claimTtlMs,
						now: this.#scheduler.now(),
						lease: this.#options.lease(),
					});
					this.#pollFailures = 0;
					for (let channelId of new Set(claimed.map(job => job.channelId))) {
						await this.#changed(channelId);
					}
					if (this.#stopped) {
						await Promise.all(claimed.map(job => this.#requeueClaim(job, "runner-shutdown")));
					} else {
						let duplicates = claimed.map(job => this.#start(job)).filter(value => !!value);
						await Promise.all(duplicates);
					}
				} catch (err) {
					this.#pollFailures++;
					this.#options.fatal?.(err);
				}
			}
		})().finally(() => {
			this.#pump = undefined;
			if (this.#dirty && !this.#stopped) this.wake();
			else if (!this.#stopped) {
				let delay = this.#pollFailures
					? Math.min(30_000, this.#options.pollMs * 2 ** Math.min(this.#pollFailures - 1, 5))
					: this.#options.pollMs;
				this.#poll = this.#scheduler.after(delay, () => {
					this.#poll = undefined;
					this.wake();
				});
			}
		});
		await this.#pump;
	}

	#start(job: BackgroundJob): Promise<void> | undefined {
		if (this.#blockedChannels.has(job.channelId)) {
			return this.#options.service.cancel({ channelId: job.channelId, jobId: job.id }, true)
				.then(() => {}, err => {
					if (!expected(err)) this.#options.fatal?.(err);
				});
		}
		let previous = this.#active.get(job.id);
		if (previous) {
			this.#detach(previous, "claim-reclaimed");
			return this.#requeueClaim(job, "claim-reclaimed");
		}
		let attempt: Attempt = {
			job,
			controller: new AbortController(),
			accepting: true,
			mutation: Promise.resolve(),
			done: Promise.resolve(),
		};
		this.#active.set(job.id, attempt);
		this.#attempts.add(attempt);
		attempt.done = this.#execute(attempt).catch(err => {
			this.#options.fatal?.(err);
		}).finally(async () => {
			await attempt.recovery;
			await attempt.mutation;
			attempt.heartbeat?.();
			attempt.credential?.release();
			attempt.releaseOwner?.();
			this.#attempts.delete(attempt);
			if (this.#active.get(job.id) === attempt) this.#active.delete(job.id);
			if (!this.#stopped) this.wake();
		});
	}

	async #execute(attempt: Attempt): Promise<void> {
		let definition = this.#options.registry.get(attempt.job.type, attempt.job.version);
		if (!definition) {
			await this.#pause(attempt, "unregistered-type");
			return;
		}
		let input: JsonValue;
		try {
			input = definition.input.parse(structuredClone(attempt.job.input));
		} catch {
			await this.#fail(attempt, "invalid-persisted-input");
			return;
		}
		this.#heartbeat(attempt);
		let running: Promise<JsonValue> | undefined;
		try {
			let credential = definition.credential === "none"
				? {
					credential: { kind: "none" } as const,
					ownerKey: undefined,
					binding: undefined,
					active: async () => true,
					release: () => {},
				}
				: await this.#options.resolveActivePlanner(attempt.job, attempt.controller.signal);
			if (!attempt.accepting || attempt.controller.signal.aborted) {
				credential?.release();
				return;
			}
			if (!credential) {
				await this.#pause(attempt, "owner-unavailable");
				return;
			}
			attempt.credential = credential;
			if (credential.signal) {
				if (credential.signal.aborted) {
					await this.#pause(attempt, "owner-unavailable");
					return;
				}
				credential.signal.addEventListener("abort", () => {
					void this.#pause(attempt, "owner-unavailable");
				}, { once: true });
			}
			await this.#serial(attempt, async () => {
				attempt.job = await this.#options.storage.jobs.renew({
					channelId: attempt.job.channelId,
					jobId: attempt.job.id,
					claimOwner: this.#claimOwner,
					claimGeneration: attempt.job.claimGeneration,
					expectedRevision: attempt.job.revision,
					claimBinding: credential.binding,
					ttlMs: this.#options.claimTtlMs + this.#options.heartbeatMs + 1,
					now: this.#scheduler.now(),
					lease: this.#options.lease(),
				});
			});
			this.#heartbeat(attempt);
			if (!this.#accepted(attempt, credential)) return;
			attempt.releaseOwner = await this.#owner(credential.ownerKey);
			if (!attempt.releaseOwner) {
				await this.#retry(attempt, "owner-capacity", false);
				return;
			}
			if (!this.#accepted(attempt, credential)) return;
			let started = this.#scheduler.now();
			let deadline = new Date(started.getTime() + definition.limits.timeoutMs);
			let timeout: () => void = noop;
			let timedOut = new Promise<never>((_, reject) => {
				timeout = this.#scheduler.after(definition.limits.timeoutMs, () => {
					reject(new Error("attempt-timeout"));
				});
			});
			running = Promise.resolve().then(() =>
				definition.execute({
					job: structuredClone(attempt.job),
					input,
					credential: credential.credential,
					signal: attempt.controller.signal,
					deadline,
					progress: (stage, state) => this.#progress(attempt, definition, stage, state),
				})
			);
			attempt.execution = running;
			void running.catch(() => {});
			let artifact = await Promise.race([running, timedOut]).finally(timeout);
			if (!this.#accepted(attempt, credential)) return;
			if (!await credential.active()) {
				await this.#pause(attempt, "owner-unavailable");
				return;
			}
			if (!this.#accepted(attempt, credential)) return;
			await this.#options.service.settle({
				channelId: attempt.job.channelId,
				jobId: attempt.job.id,
				claimOwner: this.#claimOwner,
				claimGeneration: attempt.job.claimGeneration,
				artifact,
				guard: async () => {
					if (!this.#accepted(attempt, credential)) return false;
					let active = await credential.active();
					return active && this.#accepted(attempt, credential);
				},
			});
			attempt.accepting = false;
		} catch (err) {
			if (!attempt.accepting) return;
			if (err instanceof StorageError && err.failure === "unavailable") {
				this.#detach(attempt, "storage-unavailable");
				return;
			}
			if (expected(err)) {
				this.#detach(attempt, "claim-lost");
				return;
			}
			let timeout = err instanceof Error && err.message === "attempt-timeout";
			if (timeout && running) {
				await this.#timeout(attempt, running, definition.limits.maxAttempts);
				return;
			}
			if (attempt.credential && !await attempt.credential.active().catch(() => false)) {
				await this.#pause(attempt, "owner-unavailable");
				return;
			}
			try {
				let diagnostic = this.#options.attemptFailed?.(structuredClone(attempt.job), err);
				void Promise.resolve(diagnostic).catch(noop);
			} catch {
				// Diagnostics must not change durable retry behavior.
			}
			let reason = err instanceof JobExecutionError ? err.progressReason : "attempt-error";
			await this.#retry(attempt, timeout ? "attempt-timeout" : reason, true);
		}
	}

	async #progress(
		attempt: Attempt,
		definition: JobDefinition,
		stage: string,
		state: "started" | "completed",
	): Promise<void> {
		let label = definition.progress?.[stage];
		if (!label) {
			throw new Error(`Background job ${definition.type} reported an unknown progress stage.`);
		}
		if (!attempt.accepting || attempt.controller.signal.aborted) {
			throw new Error("Background job progress is no longer accepted.");
		}
		await this.#serial(attempt, async () => {
			if (!attempt.accepting || attempt.controller.signal.aborted) {
				throw new Error("Background job progress is no longer accepted.");
			}
			attempt.job = await this.#options.storage.jobs.appendProgress({
				channelId: attempt.job.channelId,
				jobId: attempt.job.id,
				claimOwner: this.#claimOwner,
				claimGeneration: attempt.job.claimGeneration,
				stage,
				label,
				state,
				now: this.#scheduler.now(),
				lease: this.#options.lease(),
			});
		});
		await this.#changed(attempt.job.channelId);
	}

	#heartbeat(attempt: Attempt): void {
		attempt.heartbeat?.();
		attempt.heartbeat = this.#scheduler.after(this.#options.heartbeatMs, () => {
			attempt.heartbeat = undefined;
			if (!attempt.accepting || this.#stopped) return;
			void this.#serial(attempt, async () => {
				attempt.job = await this.#options.storage.jobs.renew({
					channelId: attempt.job.channelId,
					jobId: attempt.job.id,
					claimOwner: this.#claimOwner,
					claimGeneration: attempt.job.claimGeneration,
					expectedRevision: attempt.job.revision,
					claimBinding: attempt.credential?.binding,
					ttlMs: this.#options.claimTtlMs + this.#options.heartbeatMs + 1,
					now: this.#scheduler.now(),
					lease: this.#options.lease(),
				});
			}).then(async () => {
				if (!attempt.accepting) return;
				try {
					if (
						attempt.credential
						&& !await this.#withinHeartbeat(attempt.credential.active())
					) {
						await this.#pause(attempt, "owner-unavailable");
						return;
					}
				} catch {
					this.#recoverHeartbeat(attempt);
					return;
				}
				if (attempt.accepting) this.#heartbeat(attempt);
			}, () => {
				this.#recoverHeartbeat(attempt);
			});
		});
	}

	async #heartbeatLost(attempt: Attempt): Promise<void> {
		if (!attempt.accepting) return;
		attempt.accepting = false;
		attempt.heartbeat?.();
		attempt.controller.abort(new Error("heartbeat-lost"));
		let settled = !attempt.execution || await this.#settledWithinGrace(attempt.execution);
		await this.#interrupt(attempt, "heartbeat-lost");
		let definition = this.#options.registry.get(attempt.job.type, attempt.job.version);
		if (!settled || !definition || attempt.job.failures + 1 >= definition.limits.maxAttempts) {
			await this.#failStopped(attempt, "attempts-exhausted:heartbeat-lost");
		} else await this.#requeueStopped(attempt, "heartbeat-lost", true);
	}

	#recoverHeartbeat(attempt: Attempt): void {
		if (attempt.recovery) return;
		attempt.recovery = this.#heartbeatLost(attempt).catch(err => {
			this.#options.fatal?.(err);
		});
	}

	async #interrupt(attempt: Attempt, reason: string): Promise<void> {
		let latest = new Map<string, BackgroundJob["progress"][number]>();
		for (let entry of attempt.job.progress) {
			if (entry.attempt === attempt.job.attempts) latest.set(entry.stage, entry);
		}
		let active = [...latest.values()].findLast(entry => entry.state === "started");
		if (!active) return;
		try {
			await this.#serial(attempt, async () => {
				attempt.job = await this.#options.storage.jobs.appendProgress({
					channelId: attempt.job.channelId,
					jobId: attempt.job.id,
					claimOwner: this.#claimOwner,
					claimGeneration: attempt.job.claimGeneration,
					stage: active.stage,
					label: active.label,
					state: "interrupted",
					reason,
					now: this.#scheduler.now(),
					lease: this.#options.lease(),
				});
			});
		} catch (err) {
			if (!expected(err)) this.#options.fatal?.(err);
		}
	}

	#serial<T>(attempt: Attempt, action: () => Promise<T>): Promise<T> {
		let result = attempt.mutation.then(action);
		attempt.mutation = result.then(() => {}, () => {});
		return result;
	}

	#accepted(attempt: Attempt, credential?: ResolvedJobCredential): boolean {
		return attempt.accepting
			&& !attempt.controller.signal.aborted
			&& !credential?.signal?.aborted
			&& !this.#stopped;
	}

	async #pause(attempt: Attempt, reason: string): Promise<void> {
		if (!attempt.accepting) return;
		attempt.accepting = false;
		attempt.heartbeat?.();
		attempt.controller.abort(new Error(reason));
		await this.#interrupt(attempt, reason);
		try {
			attempt.job = await this.#serial(attempt, () =>
				this.#options.storage.jobs.pause({
					channelId: attempt.job.channelId,
					jobId: attempt.job.id,
					expectedRevision: attempt.job.revision,
					reason,
					now: this.#scheduler.now(),
					lease: this.#options.lease(),
				}));
			await this.#changed(attempt.job.channelId);
		} catch (err) {
			if (!expected(err)) this.#options.fatal?.(err);
		}
	}

	async #fail(attempt: Attempt, reason: string): Promise<void> {
		if (!attempt.accepting) return;
		attempt.accepting = false;
		attempt.heartbeat?.();
		try {
			attempt.job = await this.#serial(attempt, () =>
				this.#options.storage.jobs.fail({
					channelId: attempt.job.channelId,
					jobId: attempt.job.id,
					claimOwner: this.#claimOwner,
					claimGeneration: attempt.job.claimGeneration,
					reason,
					now: this.#scheduler.now(),
					lease: this.#options.lease(),
				}));
			await this.#changed(attempt.job.channelId);
		} catch (err) {
			if (!expected(err)) this.#options.fatal?.(err);
		} finally {
			attempt.controller.abort(new Error(reason));
		}
	}

	async #retry(attempt: Attempt, reason: string, countFailure: boolean): Promise<void> {
		if (!attempt.accepting) return;
		let definition = this.#options.registry.get(attempt.job.type, attempt.job.version);
		let failures = attempt.job.failures + (countFailure ? 1 : 0);
		attempt.accepting = false;
		attempt.heartbeat?.();
		attempt.controller.abort(new Error(reason));
		await this.#interrupt(attempt, reason);
		if (countFailure && definition && failures >= definition.limits.maxAttempts) {
			await this.#failStopped(attempt, `attempts-exhausted:${reason}`);
			return;
		}
		try {
			let availableAt = new Date(
				this.#scheduler.now().getTime()
					+ (countFailure
						? retryDelay(failures, this.#options.retryBaseMs, this.#options.retryMaxMs)
						: this.#options.retryBaseMs),
			);
			attempt.job = await this.#serial(attempt, () =>
				this.#options.storage.jobs.requeue({
					channelId: attempt.job.channelId,
					jobId: attempt.job.id,
					claimOwner: this.#claimOwner,
					claimGeneration: attempt.job.claimGeneration,
					availableAt,
					reason,
					countFailure,
					now: this.#scheduler.now(),
					lease: this.#options.lease(),
				}));
			await this.#changed(attempt.job.channelId);
		} catch (err) {
			if (!expected(err)) this.#options.fatal?.(err);
		}
	}

	async #requeueStopped(attempt: Attempt, reason: string, countFailure = false): Promise<void> {
		try {
			attempt.job = await this.#serial(attempt, () =>
				this.#options.storage.jobs.requeue({
					channelId: attempt.job.channelId,
					jobId: attempt.job.id,
					claimOwner: this.#claimOwner,
					claimGeneration: attempt.job.claimGeneration,
					availableAt: new Date(this.#scheduler.now().getTime() + this.#options.retryBaseMs),
					reason,
					countFailure,
					now: this.#scheduler.now(),
					lease: this.#options.lease(),
				}));
			await this.#changed(attempt.job.channelId);
		} catch (err) {
			if (!expected(err)) this.#options.fatal?.(err);
		}
	}

	async #failStopped(attempt: Attempt, reason: string): Promise<void> {
		try {
			attempt.job = await this.#serial(attempt, () =>
				this.#options.storage.jobs.fail({
					channelId: attempt.job.channelId,
					jobId: attempt.job.id,
					claimOwner: this.#claimOwner,
					claimGeneration: attempt.job.claimGeneration,
					reason,
					now: this.#scheduler.now(),
					lease: this.#options.lease(),
				}));
			await this.#changed(attempt.job.channelId);
		} catch (err) {
			if (!expected(err)) this.#options.fatal?.(err);
		}
	}

	async #timeout(
		attempt: Attempt,
		execution: Promise<JsonValue>,
		maxAttempts: number,
	): Promise<void> {
		if (!attempt.accepting) return;
		attempt.accepting = false;
		attempt.heartbeat?.();
		attempt.controller.abort(new Error("attempt-timeout"));
		let cleanup = this.#withinGrace(execution.then(() => {}, () => {}));
		await this.#interrupt(attempt, "attempt-timeout");
		if (attempt.job.failures + 1 >= maxAttempts) {
			await this.#failStopped(attempt, "attempts-exhausted:attempt-timeout");
		} else {
			await this.#requeueStopped(attempt, "attempt-timeout", true);
		}
		await cleanup;
	}

	async #requeueClaim(job: BackgroundJob, reason: string): Promise<void> {
		try {
			await this.#options.storage.jobs.requeue({
				channelId: job.channelId,
				jobId: job.id,
				claimOwner: this.#claimOwner,
				claimGeneration: job.claimGeneration,
				availableAt: new Date(this.#scheduler.now().getTime() + this.#options.retryBaseMs),
				reason,
				countFailure: false,
				now: this.#scheduler.now(),
				lease: this.#options.lease(),
			});
			await this.#changed(job.channelId);
		} catch (err) {
			if (!expected(err)) this.#options.fatal?.(err);
		}
	}

	#detach(attempt: Attempt, reason: string): void {
		if (!attempt.accepting) return;
		attempt.accepting = false;
		attempt.heartbeat?.();
		attempt.controller.abort(new Error(reason));
	}

	#withinGrace(operation: Promise<unknown>): Promise<void> {
		return new Promise(resolve => {
			let cancel = this.#scheduler.after(this.#options.shutdownGraceMs, resolve);
			operation.then(
				() => {
					cancel();
					resolve();
				},
				() => {
					cancel();
					resolve();
				},
			);
		});
	}

	async #settledWithinGrace(operation: Promise<unknown>): Promise<boolean> {
		let settled = false;
		let observed = operation.then(
			() => settled = true,
			() => settled = true,
		);
		await this.#withinGrace(observed);
		return settled;
	}

	#withinHeartbeat<T>(operation: Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let cancel = this.#scheduler.after(this.#options.heartbeatMs, () => {
				reject(new Error("owner revalidation timed out"));
			});
			operation.then(
				value => {
					cancel();
					resolve(value);
				},
				err => {
					cancel();
					reject(err);
				},
			);
		});
	}

	#owner(key: string | undefined): Promise<(() => void) | undefined> {
		if (!key) return Promise.resolve(() => {});
		let active = this.#owners.get(key) ?? 0;
		if (active >= this.#options.ownerConcurrency) return Promise.resolve(undefined);
		this.#owners.set(key, active + 1);
		let released = false;
		return Promise.resolve(() => {
			if (released) return;
			released = true;
			this.#releaseOwner(key);
		});
	}

	#releaseOwner(key: string): void {
		let active = Math.max(0, (this.#owners.get(key) ?? 1) - 1);
		if (active === 0) this.#owners.delete(key);
		else this.#owners.set(key, active);
	}

	async #changed(channelId: string): Promise<void> {
		try {
			await this.#options.changed?.(channelId);
		} catch (err) {
			this.#options.fatal?.(err);
		}
	}
}
