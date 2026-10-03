import { JOB_TOOLS, WRITE_TOOLS } from "../agent/job-scope";
import type { TextStreamPart, ToolSet } from "ai";
import type { Room } from "./service";

/** Background stream content stays private; only the live own-tool wrapper records output. */
export function translateJob(context: Room, part: TextStreamPart<ToolSet>): void {
	let { chat } = context;
	let job = chat.job;
	if (!job) return;
	let own = JOB_TOOLS[job.kind];
	function interrupt(reason: string) {
		chat.interruption ??= reason;
		chat.turnController?.abort();
	}
	switch (part.type) {
		case "tool-call": {
			if (
				!chat.jobToolNames?.has(part.toolName)
				|| WRITE_TOOLS.has(part.toolName) && part.toolName !== own
				|| chat.jobCalls?.has(part.toolCallId)
			) {
				console.error(`[chat] boundary failure: inactive job tool ${part.toolName}`);
				interrupt(`Planner tool boundary failure: ${part.toolName}`);
				return;
			}
			chat.jobCalls?.set(part.toolCallId, part.toolName);
			return;
		}
		case "tool-result":
		case "tool-error":
		case "tool-output-denied": {
			let name = chat.jobCalls?.get(part.toolCallId);
			chat.jobCalls?.delete(part.toolCallId);
			if (!name || "toolName" in part && part.toolName !== name) {
				interrupt("Planner tool boundary failure: unrecognized job tool result");
				return;
			}
			if (part.type === "tool-output-denied") {
				interrupt("Planner tool permission was denied.");
				return;
			}
			if (name !== own) return;
			let content = part.type === "tool-result" ? part.output : part.error;
			chat.jobFailureCode = name === "refine_decision" && part.type === "tool-result"
					&& content === "Error: source-shape"
				? "source-shape"
				: undefined;
			if (
				part.type === "tool-error" || typeof content === "string" && content.startsWith("Error:")
			) {
				chat.jobFailures = (chat.jobFailures ?? 0) + 1;
				if (chat.jobFailures >= 2) {
					interrupt(chat.jobFailureCode ?? `The Planner's ${own} failed twice.`);
				}
			}
			return;
		}
		case "tool-approval-request":
			interrupt("Planner tool approval was denied.");
			return;
		case "error":
			interrupt(part.error instanceof Error ? part.error.message : String(part.error));
			return;
		default:
			return;
	}
}
