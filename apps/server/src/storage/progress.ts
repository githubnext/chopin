import { BACKGROUND_JOB_PROGRESS_LABEL_LIMIT, BACKGROUND_JOB_PROGRESS_LIMIT } from "./model";
import { conflict, corrupt } from "./errors";

import type {
	AppendBackgroundJobProgress,
	BackgroundJobProgress,
	BackgroundJobProgressState,
} from "./model";

const STAGE = /^[a-z][a-z0-9-]{0,63}$/;
const REASON = /^[a-z][a-z0-9-]{0,63}$/;

function entry(value: unknown, jobId: string): BackgroundJobProgress {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw corrupt(`background job ${jobId} has invalid progress`);
	}
	let found = value as Record<string, unknown>;
	let keys = Object.keys(found).sort();
	let fields = keys.join(",");
	if (
		fields !== "attempt,createdAt,label,revision,stage,state"
		&& fields !== "attempt,createdAt,label,reason,revision,stage,state"
	) {
		throw corrupt(`background job ${jobId} has invalid progress fields`);
	}
	let revision = found.revision;
	let attempt = found.attempt;
	let stage = found.stage;
	let label = found.label;
	let state = found.state;
	let reason = found.reason;
	let createdAt = found.createdAt instanceof Date
		? new Date(found.createdAt)
		: new Date(String(found.createdAt));
	if (
		!Number.isSafeInteger(revision) || (revision as number) < 1
		|| !Number.isSafeInteger(attempt) || (attempt as number) < 1
		|| typeof stage !== "string" || !STAGE.test(stage)
		|| typeof label !== "string" || !label.trim()
		|| label.length > BACKGROUND_JOB_PROGRESS_LABEL_LIMIT
		|| state !== "started" && state !== "completed" && state !== "interrupted"
		|| (state === "interrupted"
			? typeof reason !== "string" || !REASON.test(reason)
			: reason !== undefined)
		|| Number.isNaN(createdAt.getTime())
	) throw corrupt(`background job ${jobId} has invalid progress values`);
	return {
		revision: revision as number,
		attempt: attempt as number,
		stage,
		label,
		state: state as BackgroundJobProgressState,
		...(typeof reason === "string" ? { reason } : {}),
		createdAt,
	};
}

export function progress(value: unknown, jobId: string): BackgroundJobProgress[] {
	let parsed: unknown;
	try {
		parsed = typeof value === "string" ? JSON.parse(value) : value;
	} catch (err) {
		throw corrupt(`background job ${jobId} has invalid progress JSON`, err);
	}
	if (!Array.isArray(parsed) || parsed.length > BACKGROUND_JOB_PROGRESS_LIMIT) {
		throw corrupt(`background job ${jobId} has invalid progress length`);
	}
	return parsed.map(value => entry(value, jobId));
}

export function appendProgress(
	current: readonly BackgroundJobProgress[],
	input: AppendBackgroundJobProgress,
	revision: number,
	attempt: number,
): BackgroundJobProgress[] {
	let label = input.label.trim();
	if (
		!STAGE.test(input.stage)
		|| !label
		|| label.length > BACKGROUND_JOB_PROGRESS_LABEL_LIMIT
		|| input.state !== "started" && input.state !== "completed" && input.state !== "interrupted"
		|| (input.state === "interrupted" ? !input.reason : input.reason !== undefined)
		|| input.reason !== undefined
			&& (typeof input.reason !== "string" || !REASON.test(input.reason))
	) throw conflict("background job progress is invalid");
	let createdAt = new Date(input.now);
	if (Number.isNaN(createdAt.getTime())) throw conflict("background job progress time is invalid");
	return [...current, {
		revision,
		attempt,
		stage: input.stage,
		label,
		state: input.state,
		...(input.reason ? { reason: input.reason } : {}),
		createdAt,
	}].slice(-BACKGROUND_JOB_PROGRESS_LIMIT).map(value => ({
		...value,
		createdAt: new Date(value.createdAt),
	}));
}
