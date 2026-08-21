import type {
	BackgroundJob,
	BackgroundJobArtifact,
	BackgroundJobCursor,
	BackgroundJobDetail,
	BackgroundJobOrigin,
	BackgroundJobState,
	BackgroundJobTarget,
	ClaimedBackgroundJob,
	JsonValue,
	Lease,
} from "../storage/model";
import type { StorageAdapter } from "../storage/port";
import type { JobDefinition, JobRegistry } from "./registry";

export type JobServiceErrorCode =
	| "invalid-request"
	| "origin-forbidden"
	| "unknown-job-type"
	| "unregistered-version";

export class JobServiceError extends Error {
	readonly code: JobServiceErrorCode;

	constructor(code: JobServiceErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "JobServiceError";
		this.code = code;
	}
}

export type EnqueueJob = {
	channelId: string;
	type: string;
	targetKey: string;
	idempotencyKey: string;
	input: JsonValue;
	availableAt?: Date;
};

export type JobMutation = {
	channelId: string;
	jobId: string;
	expectedRevision: number;
};

export type SettleJob = Omit<ClaimedBackgroundJob, "lease" | "now"> & { artifact: JsonValue };

export type JobView = {
	id: string;
	channelId: string;
	type: string;
	version: number;
	origin: BackgroundJobOrigin;
	targetKey: string;
	targetGeneration: number;
	state: BackgroundJobState;
	revision: number;
	attempts: number;
	availableAt: Date;
	reason: string | undefined;
	createdAt: Date;
	updatedAt: Date;
};

export type JobPage = {
	revision: number;
	jobs: JobView[];
	next?: BackgroundJobCursor;
};

export type JobDetail = {
	revision: number;
	target: BackgroundJobTarget;
	job: JobView;
	artifact: BackgroundJobArtifact | undefined;
};

export type JobServiceOptions = {
	storage: StorageAdapter;
	registry: JobRegistry;
	lease: () => Lease;
	now?: () => Date;
	id?: () => string;
	publish?: (channelId: string) => void | Promise<void>;
	publishTimeoutMs?: number;
	hookTimeoutMs?: number;
};

const MAX_TARGET_KEY = 512;
const MAX_IDEMPOTENCY_KEY = 128;
const MAX_REASON = 512;
const MAX_JSON_DEPTH = 64;

function requestText(value: unknown, field: string, maximum: number): asserts value is string {
	if (typeof value !== "string" || !value || value.length > maximum) {
		throw new JobServiceError(
			"invalid-request",
			`Background job ${field} must contain between 1 and ${maximum} characters.`,
		);
	}
}

function canonical(
	value: unknown,
	maximum: number,
	field: string,
): { value: JsonValue; source: string } {
	let chunks: string[] = [];
	let size = 0;
	let encoder = new TextEncoder();
	let ancestors = new Set<object>();
	let append = (part: string) => {
		size += encoder.encode(part).byteLength;
		if (size > maximum) {
			throw new JobServiceError("invalid-request", `Background job ${field} is too large.`);
		}
		chunks.push(part);
	};
	let visit = (current: unknown, depth: number): void => {
		if (depth > MAX_JSON_DEPTH) {
			throw new JobServiceError("invalid-request", `Background job ${field} is nested too deeply.`);
		}
		if (typeof current === "string") {
			if (current.length > maximum) {
				throw new JobServiceError("invalid-request", `Background job ${field} is too large.`);
			}
			append(JSON.stringify(current));
			return;
		}
		if (current === null || typeof current === "boolean") {
			append(JSON.stringify(current));
			return;
		}
		if (typeof current === "number") {
			if (!Number.isFinite(current)) {
				throw new JobServiceError(
					"invalid-request",
					`Background job ${field} contains a non-finite number.`,
				);
			}
			append(JSON.stringify(current));
			return;
		}
		if (!current || typeof current !== "object") {
			throw new JobServiceError("invalid-request", `Background job ${field} is not plain JSON.`);
		}
		if (ancestors.has(current)) {
			throw new JobServiceError("invalid-request", `Background job ${field} is cyclic.`);
		}
		ancestors.add(current);
		if (Array.isArray(current)) {
			if (current.length > maximum) {
				throw new JobServiceError("invalid-request", `Background job ${field} is too large.`);
			}
			append("[");
			for (let index = 0; index < current.length; index++) {
				if (!(index in current)) {
					throw new JobServiceError(
						"invalid-request",
						`Background job ${field} contains a sparse array.`,
					);
				}
				if (index > 0) append(",");
				visit(current[index], depth + 1);
			}
			append("]");
		} else {
			let prototype = Object.getPrototypeOf(current);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new JobServiceError("invalid-request", `Background job ${field} is not plain JSON.`);
			}
			let keys = Reflect.ownKeys(current);
			if (keys.length > maximum || keys.some(key => typeof key !== "string")) {
				throw new JobServiceError("invalid-request", `Background job ${field} is not plain JSON.`);
			}
			let entries = keys.map(key => {
				let descriptor = Object.getOwnPropertyDescriptor(current, key)!;
				if (!descriptor.enumerable || !("value" in descriptor)) {
					throw new JobServiceError(
						"invalid-request",
						`Background job ${field} is not plain JSON.`,
					);
				}
				return [key as string, descriptor.value] as const;
			}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
			append("{");
			for (let index = 0; index < entries.length; index++) {
				if (index > 0) append(",");
				let [key, child] = entries[index]!;
				if (key.length > maximum) {
					throw new JobServiceError("invalid-request", `Background job ${field} is too large.`);
				}
				append(JSON.stringify(key));
				append(":");
				visit(child, depth + 1);
			}
			append("}");
		}
		ancestors.delete(current);
	};
	visit(value, 0);
	let source = chunks.join("");
	return { value: JSON.parse(source) as JsonValue, source };
}

function reason(value: string): string {
	let normalized = value.trim();
	requestText(normalized, "reason", MAX_REASON);
	return normalized;
}

function view(value: BackgroundJob): JobView {
	return {
		id: value.id,
		channelId: value.channelId,
		type: value.type,
		version: value.version,
		origin: value.origin,
		targetKey: value.targetKey,
		targetGeneration: value.targetGeneration,
		state: value.state,
		revision: value.revision,
		attempts: value.attempts,
		availableAt: new Date(value.availableAt),
		reason: value.reason,
		createdAt: new Date(value.createdAt),
		updatedAt: new Date(value.updatedAt),
	};
}

function detail(value: BackgroundJobDetail): JobDetail {
	return {
		revision: value.revision,
		target: { ...value.target },
		job: view(value.job),
		artifact: value.artifact && {
			...value.artifact,
			value: structuredClone(value.artifact.value),
			createdAt: new Date(value.artifact.createdAt),
		},
	};
}

function fingerprint(
	definition: JobDefinition,
	origin: BackgroundJobOrigin,
	targetKey: string,
	inputSource: string,
	availableAt: Date | undefined,
): string {
	let request = canonical(
		{
			type: definition.type,
			version: definition.version,
			origin,
			targetKey,
			input: JSON.parse(inputSource) as JsonValue,
			availableAt: availableAt?.toISOString() ?? null,
		},
		Number.MAX_SAFE_INTEGER,
		"fingerprint",
	);
	return new Bun.CryptoHasher("sha256").update(request.source).digest("hex");
}

/** Validates registered requests and publishes only already-durable state. */
export class JobService {
	#storage: StorageAdapter;
	#registry: JobRegistry;
	#lease: () => Lease;
	#now: () => Date;
	#id: () => string;
	#publish?: (channelId: string) => void | Promise<void>;
	#publishTimeoutMs: number;
	#hookTimeoutMs: number;

	constructor(options: JobServiceOptions) {
		this.#storage = options.storage;
		this.#registry = options.registry;
		this.#lease = options.lease;
		this.#now = options.now ?? (() => new Date());
		this.#id = options.id ?? (() => crypto.randomUUID());
		this.#publish = options.publish;
		this.#publishTimeoutMs = options.publishTimeoutMs ?? 5_000;
		this.#hookTimeoutMs = options.hookTimeoutMs ?? 10_000;
		if (!Number.isSafeInteger(this.#publishTimeoutMs) || this.#publishTimeoutMs < 1) {
			throw new Error("Background job publication timeout must be a positive integer.");
		}
		if (!Number.isSafeInteger(this.#hookTimeoutMs) || this.#hookTimeoutMs < 1) {
			throw new Error("Background job hook timeout must be a positive integer.");
		}
	}

	enqueueScheduler(request: EnqueueJob): Promise<{ job: JobView; repeated: boolean }> {
		return this.#enqueue("scheduler", request);
	}

	enqueuePlanner(request: EnqueueJob): Promise<{ job: JobView; repeated: boolean }> {
		return this.#enqueue("planner", request);
	}

	enqueueUser(request: EnqueueJob): Promise<{ job: JobView; repeated: boolean }> {
		return this.#enqueue("user", request);
	}

	async pause(request: JobMutation, why: string): Promise<JobView> {
		let saved = await this.#storage.jobs.pause({
			...request,
			reason: reason(why),
			now: this.#time(),
			lease: this.#lease(),
		});
		await this.#changed(request.channelId);
		return view(saved);
	}

	async resume(request: JobMutation, availableAt?: Date): Promise<JobView> {
		let persisted = await this.#storage.jobs.get(request.channelId, request.jobId);
		if (persisted && !this.#registry.get(persisted.job.type, persisted.job.version)) {
			throw new JobServiceError(
				"unregistered-version",
				`Background job ${persisted.job.type}@${persisted.job.version} is not registered.`,
			);
		}
		let now = this.#time();
		let scheduled = availableAt ? new Date(availableAt) : now;
		if (Number.isNaN(scheduled.getTime())) {
			throw new JobServiceError("invalid-request", "Background job availability is invalid.");
		}
		let saved = await this.#storage.jobs.resume({
			...request,
			availableAt: scheduled,
			now,
			lease: this.#lease(),
		});
		await this.#changed(request.channelId);
		return view(saved);
	}

	async cancel(request: JobMutation): Promise<JobView> {
		let saved = await this.#storage.jobs.cancel({
			...request,
			now: this.#time(),
			lease: this.#lease(),
		});
		await this.#changed(request.channelId);
		return view(saved);
	}

	async settle(request: SettleJob): Promise<JobDetail> {
		let persisted = await this.#storage.jobs.get(request.channelId, request.jobId);
		if (!persisted) {
			throw new JobServiceError(
				"invalid-request",
				`Background job ${request.jobId} does not exist.`,
			);
		}
		let definition = this.#registry.get(persisted.job.type, persisted.job.version);
		if (!definition) {
			throw new JobServiceError(
				"unregistered-version",
				`Background job ${persisted.job.type}@${persisted.job.version} is not registered.`,
			);
		}
		let validated = this.#artifact(definition, request.artifact);
		let commitResult: Promise<BackgroundJobDetail> | undefined;
		let acceptingCommit = true;
		let commit = () => {
			if (!acceptingCommit || commitResult) {
				throw new Error(`Background job ${request.jobId} settlement was attempted twice.`);
			}
			commitResult = this.#storage.jobs.settle({
				...request,
				artifact: structuredClone(validated),
				now: this.#time(),
				lease: this.#lease(),
			});
			let exposed = commitResult.then(() => {});
			void exposed.catch(() => {});
			return exposed;
		};
		let hookError: unknown;
		if (definition.publish) {
			try {
				await this.#bounded(
					Promise.resolve().then(() =>
						definition.publish!({
							job: structuredClone(persisted.job),
							artifact: structuredClone(validated),
							commit,
						})
					),
					this.#hookTimeoutMs,
					"background job publication hook timed out",
				);
			} catch (err) {
				hookError = err;
			}
		} else {
			commit();
		}
		acceptingCommit = false;
		if (!commitResult) {
			if (hookError) throw hookError;
			throw new Error(`Background job ${request.jobId} publication did not commit.`);
		}
		let saved = await commitResult;
		if (hookError) {
			console.warn(
				`[jobs] background job ${request.jobId} committed after a publication hook error:`,
				hookError,
			);
		}
		await this.#changed(request.channelId);
		return detail(saved);
	}

	async list(
		channelId: string,
		limit: number,
		after?: BackgroundJobCursor,
	): Promise<JobPage | undefined> {
		let page = await this.#storage.jobs.list(channelId, limit, after);
		return page && {
			revision: page.revision,
			jobs: page.jobs.map(value => view(value as BackgroundJob)),
			next: page.next && { createdAt: new Date(page.next.createdAt), id: page.next.id },
		};
	}

	async get(channelId: string, jobId: string): Promise<JobDetail | undefined> {
		let found = await this.#storage.jobs.get(channelId, jobId);
		return found && detail(found);
	}

	definition(type: string, version: number): JobDefinition | undefined {
		return this.#registry.get(type, version);
	}

	async #enqueue(
		origin: BackgroundJobOrigin,
		request: EnqueueJob,
	): Promise<{ job: JobView; repeated: boolean }> {
		requestText(request.channelId, "channel id", 255);
		requestText(request.targetKey, "target key", MAX_TARGET_KEY);
		requestText(request.idempotencyKey, "idempotency key", MAX_IDEMPOTENCY_KEY);
		let definition = this.#registry.current(request.type);
		if (!definition) {
			throw new JobServiceError(
				"unknown-job-type",
				`Background job ${request.type} is not registered.`,
			);
		}
		if (!definition.origins.includes(origin)) {
			throw new JobServiceError(
				"origin-forbidden",
				`Background job ${definition.type} cannot be enqueued by ${origin}.`,
			);
		}
		let supplied = canonical(request.input, definition.limits.maxInputBytes, "input").value;
		let parsed: JsonValue;
		try {
			parsed = definition.input.parse(supplied);
		} catch (err) {
			throw new JobServiceError(
				"invalid-request",
				`Background job ${definition.type} input is invalid.`,
				{
					cause: err,
				},
			);
		}
		let normalized = canonical(parsed, definition.limits.maxInputBytes, "input");
		let requestedAt = request.availableAt && new Date(request.availableAt);
		if (requestedAt && Number.isNaN(requestedAt.getTime())) {
			throw new JobServiceError("invalid-request", "Background job availability is invalid.");
		}
		let now = this.#time();
		let targetKey = `${definition.type}:${request.targetKey}`;
		let saved = await this.#storage.jobs.enqueue({
			id: this.#id(),
			channelId: request.channelId,
			type: definition.type,
			version: definition.version,
			origin,
			targetKey,
			idempotencyKey: request.idempotencyKey,
			fingerprint: fingerprint(
				definition,
				origin,
				targetKey,
				normalized.source,
				requestedAt,
			),
			input: normalized.value,
			availableAt: requestedAt ?? now,
			now,
			lease: this.#lease(),
		});
		if (!saved.repeated) await this.#changed(request.channelId);
		return { job: view(saved.job), repeated: saved.repeated };
	}

	#artifact(definition: JobDefinition, value: JsonValue): JsonValue {
		let supplied = canonical(value, definition.limits.maxArtifactBytes, "artifact").value;
		let parsed: JsonValue;
		try {
			parsed = definition.artifact.parse(supplied);
		} catch (err) {
			throw new JobServiceError(
				"invalid-request",
				`Background job ${definition.type} artifact is invalid.`,
				{
					cause: err,
				},
			);
		}
		return canonical(parsed, definition.limits.maxArtifactBytes, "artifact").value;
	}

	#time(): Date {
		let now = this.#now();
		if (Number.isNaN(now.getTime())) {
			throw new Error("Background job clock returned an invalid time.");
		}
		return new Date(now);
	}

	#bounded<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			operation.then(
				value => {
					clearTimeout(timer);
					resolve(value);
				},
				err => {
					clearTimeout(timer);
					reject(err);
				},
			);
		});
	}

	async #changed(channelId: string): Promise<void> {
		if (!this.#publish) return;
		try {
			await this.#bounded(
				Promise.resolve().then(() => this.#publish!(channelId)),
				this.#publishTimeoutMs,
				"background job publication timed out",
			);
		} catch (err) {
			console.warn(`[jobs] could not publish channel ${channelId}:`, err);
		}
	}
}
