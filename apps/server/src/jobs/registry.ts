import { BACKGROUND_JOB_PROGRESS_LABEL_LIMIT } from "../storage/model";

import type { BackgroundJob, BackgroundJobOrigin, JsonValue } from "../storage/model";

export type JobCodec<T extends JsonValue = JsonValue> = {
	parse: (value: JsonValue) => T;
};

export type JobCredential = "active-planner" | "none";

export type JobExecutionDiagnostic = Readonly<Record<string, boolean | number | string>>;

export type JobExecutionErrorOptions = ErrorOptions & { diagnostic?: JobExecutionDiagnostic };

export class JobExecutionError extends Error {
	readonly progressReason: string;
	readonly diagnostic?: JobExecutionDiagnostic;

	constructor(progressReason: string, options: JobExecutionErrorOptions = {}) {
		if (typeof progressReason !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(progressReason)) {
			throw new Error("Background job execution failure reason is invalid.");
		}
		let suppliedDiagnostic = options.diagnostic;
		if (
			suppliedDiagnostic !== undefined
			&& (!suppliedDiagnostic
				|| typeof suppliedDiagnostic !== "object"
				|| Array.isArray(suppliedDiagnostic)
				|| Object.getPrototypeOf(suppliedDiagnostic) !== Object.prototype)
		) throw new Error("Background job execution diagnostic is invalid.");
		let entries = Object.entries(suppliedDiagnostic ?? {});
		if (
			entries.length > 16
			|| entries.some(([key, value]) =>
				!/^[a-z][a-zA-Z0-9]{0,31}$/.test(key)
				|| typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string"
				|| typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)
				|| typeof value === "string" && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(value)
			)
		) throw new Error("Background job execution diagnostic is invalid.");
		super(`Background job execution failed: ${progressReason}.`, { cause: options.cause });
		this.name = "JobExecutionError";
		this.progressReason = progressReason;
		if (entries.length > 0) this.diagnostic = Object.freeze(Object.fromEntries(entries));
	}
}

export type JobExecutionCredential =
	| { readonly kind: "none" }
	| {
		readonly kind: "active-planner";
		readonly token: string;
		readonly ownerSessionId: string;
		readonly ownerGeneration: number;
		readonly credentialRevision: number;
		readonly expiresAt: Date;
		readonly signal?: AbortSignal;
		readonly authorize: () => Promise<boolean>;
	};

export type JobExecution<Input extends JsonValue = JsonValue> = {
	readonly job: Readonly<BackgroundJob>;
	readonly input: Input;
	readonly credential: JobExecutionCredential;
	readonly signal: AbortSignal;
	readonly deadline: Date;
	readonly progress: (stage: string, state: "started" | "completed") => Promise<void>;
};

export type JobLimits = {
	timeoutMs: number;
	maxAttempts: number;
	maxAiCredits: number;
	maxInputBytes: number;
	maxArtifactBytes: number;
};

export type JobPublication = {
	job: BackgroundJob;
	artifact: JsonValue;
	commit: () => Promise<void>;
};

export type JobDefinition<
	Input extends JsonValue = JsonValue,
	Artifact extends JsonValue = JsonValue,
> = {
	readonly type: string;
	readonly version: number;
	readonly label: string;
	readonly description: string;
	readonly origins: readonly BackgroundJobOrigin[];
	readonly credential: JobCredential;
	readonly limits: Readonly<JobLimits>;
	readonly progress?: Readonly<Record<string, string>>;
	readonly input: Readonly<JobCodec<Input>>;
	readonly artifact: Readonly<JobCodec<Artifact>>;
	execute(execution: JobExecution<Input>): Promise<Artifact>;
	readonly publish?: (publication: JobPublication) => Promise<void>;
};

const TYPE = /^[a-z][a-z0-9-]{0,63}$/;
const STAGE = /^[a-z][a-z0-9-]{0,63}$/;

function positive(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`Background job ${field} must be a positive integer.`);
	}
}

function validate(definition: JobDefinition): void {
	if (!definition || typeof definition !== "object") {
		throw new Error("Invalid background job definition.");
	}
	if (typeof definition.type !== "string" || !TYPE.test(definition.type)) {
		throw new Error(`Invalid background job type ${String(definition.type)}.`);
	}
	positive(definition.version, "version");
	if (
		typeof definition.label !== "string"
		|| typeof definition.description !== "string"
		|| !definition.label.trim()
		|| !definition.description.trim()
	) {
		throw new Error(`Background job ${definition.type} must have a label and description.`);
	}
	if (
		!Array.isArray(definition.origins)
		|| definition.origins.length === 0
		|| new Set(definition.origins).size !== definition.origins.length
	) {
		throw new Error(`Background job ${definition.type} must declare distinct enqueue origins.`);
	}
	for (let origin of definition.origins) {
		if (origin !== "scheduler" && origin !== "planner" && origin !== "user") {
			throw new Error(`Background job ${definition.type} has an invalid enqueue origin.`);
		}
	}
	if (definition.credential !== "active-planner" && definition.credential !== "none") {
		throw new Error(`Background job ${definition.type} has an invalid credential mode.`);
	}
	if (
		typeof definition.input?.parse !== "function"
		|| typeof definition.artifact?.parse !== "function"
		|| typeof definition.execute !== "function"
	) {
		throw new Error(`Background job ${definition.type} must declare codecs and an executor.`);
	}
	if (definition.publish !== undefined && typeof definition.publish !== "function") {
		throw new Error(`Background job ${definition.type} has an invalid publication hook.`);
	}
	if (!definition.limits || typeof definition.limits !== "object") {
		throw new Error(`Background job ${definition.type} must declare resource limits.`);
	}
	positive(definition.limits.timeoutMs, "timeout");
	positive(definition.limits.maxAttempts, "attempt limit");
	positive(definition.limits.maxAiCredits, "AI credit limit");
	positive(definition.limits.maxInputBytes, "input limit");
	positive(definition.limits.maxArtifactBytes, "artifact limit");
	if (definition.progress !== undefined) {
		if (
			!definition.progress || typeof definition.progress !== "object"
			|| Array.isArray(definition.progress)
		) {
			throw new Error(`Background job ${definition.type} has invalid progress stages.`);
		}
		let stages = Object.entries(definition.progress);
		if (stages.length === 0 || stages.length > 32) {
			throw new Error(`Background job ${definition.type} has invalid progress stages.`);
		}
		for (let [stage, label] of stages) {
			if (
				!STAGE.test(stage)
				|| typeof label !== "string"
				|| !label.trim()
				|| label.length > BACKGROUND_JOB_PROGRESS_LABEL_LIMIT
			) throw new Error(`Background job ${definition.type} has invalid progress stage ${stage}.`);
		}
	}
}

function identity(type: string, version: number): string {
	return `${type}@${version}`;
}

/** Closed, code-owned catalog of durable job contracts. */
export class JobRegistry {
	#versions = new Map<string, JobDefinition>();
	#current = new Map<string, JobDefinition>();

	constructor(definitions: readonly JobDefinition[] = []) {
		for (let definition of definitions) this.register(definition);
	}

	register(definition: JobDefinition): void {
		validate(definition);
		let key = identity(definition.type, definition.version);
		if (this.#versions.has(key)) throw new Error(`Background job ${key} is already registered.`);
		let frozen = Object.freeze({
			...definition,
			origins: Object.freeze([...definition.origins]),
			limits: Object.freeze({ ...definition.limits }),
			input: Object.freeze({ ...definition.input }),
			artifact: Object.freeze({ ...definition.artifact }),
			...(definition.progress ? { progress: Object.freeze({ ...definition.progress }) } : {}),
		}) as JobDefinition;
		this.#versions.set(key, frozen);
		let current = this.#current.get(definition.type);
		if (!current || current.version < definition.version) {
			this.#current.set(definition.type, frozen);
		}
	}

	current(type: string): JobDefinition | undefined {
		return this.#current.get(type);
	}

	get(type: string, version: number): JobDefinition | undefined {
		return this.#versions.get(identity(type, version));
	}

	list(): JobDefinition[] {
		return [...this.#current.values()].sort((left, right) => left.type.localeCompare(right.type));
	}
}
