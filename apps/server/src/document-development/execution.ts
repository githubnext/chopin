import { locksEditing } from "../tasks/builds";
import { restore } from "./state";
import { parseDocumentDevelopmentInput } from "./schema";
import type { BackgroundJob } from "../storage/model";

/** The persisted user pause also gates owner recovery, including unopened documents. */
export function executionAllowed(
	value: unknown,
	job: Pick<BackgroundJob, "id" | "input">,
): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	let sidecar = value as {
		documentDevelopment?: unknown;
		execution?: unknown;
		claiming?: unknown;
		builds?: Array<{ state: string; kind?: string }>;
	};
	if (sidecar.execution || sidecar.claiming || sidecar.builds?.some(locksEditing)) return false;
	let state = restore(sidecar.documentDevelopment);
	let pending = state?.pending;
	return !!pending && !state!.paused && (!pending.jobId || pending.jobId === job.id)
		&& JSON.stringify(pending.input) === JSON.stringify(parseDocumentDevelopmentInput(job.input));
}
