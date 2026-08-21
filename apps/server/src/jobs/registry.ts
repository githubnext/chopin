import type { BackgroundJob, BackgroundJobOrigin, JsonValue } from "../storage/model";

export type JobCodec<T extends JsonValue = JsonValue> = {
	parse: (value: JsonValue) => T;
};

export type JobCredential = "active-planner" | "none";

export type JobExecutionCredential =
	| { readonly kind: "none" }
	| {
		readonly kind: "active-planner";
		readonly token: string;
		readonly ownerSessionId: string;
		readonly ownerGeneration: number;
		readonly credentialRevision: number;
		readonly expiresAt: Date;
		readonly authorize: () => Promise<boolean>;
	};

export type JobExecution<Input extends JsonValue = JsonValue> = {
	readonly job: Readonly<BackgroundJob>;
	readonly input: Input;
	readonly credential: JobExecutionCredential;
	readonly signal: AbortSignal;
	readonly deadline: Date;
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
	readonly input: Readonly<JobCodec<Input>>;
	readonly artifact: Readonly<JobCodec<Artifact>>;
	readonly execute: (execution: JobExecution<Input>) => Promise<Artifact>;
	readonly publish?: (publication: JobPublication) => Promise<void>;
};

const TYPE = /^[a-z][a-z0-9-]{0,63}$/;

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
