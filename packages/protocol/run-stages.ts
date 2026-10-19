import type { Chat } from "./index";

const ENDED = new Set<Chat.RunStage["status"]>([
	"completed",
	"failed",
	"blocked",
	"skipped",
	"stopped",
]);

/**
 * Stages as Chat shows them: an unfinished stage under a stopped, failed, blocked or skipped
 * ancestor shows as stopped, and with `runStopped` every unfinished stage does. Applying it
 * again changes nothing, so a server can apply it before it keeps only the latest stages.
 */
export function settledStages(
	stages: readonly Chat.RunStage[],
	runStopped = false,
): Chat.RunStage[] {
	let stopped = new Set(
		stages.filter(stage => stage.status !== "completed" && ENDED.has(stage.status)).map(stage =>
			stage.id
		),
	);
	let changed = true;
	while (changed) {
		changed = false;
		for (let stage of stages) {
			if (!stopped.has(stage.id) && stage.parentIds?.some(id => stopped.has(id))) {
				stopped.add(stage.id);
				changed = true;
			}
		}
	}
	return stages.map(stage =>
		!ENDED.has(stage.status) && (runStopped || stopped.has(stage.id))
			? { ...stage, status: "stopped" }
			: stage
	);
}
