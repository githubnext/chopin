import { DEFAULT_AGENT } from "./experiments/agents";
import { agentArguments, quote } from "./experiments/setup-commands";

/** The terminal alternative to attaching a Planner directly in its client. */
export function plannerConnectCommand(documentURL: string, backend: string): string {
	if (!backend.trim()) return "";
	let origin = new URL(documentURL).origin;
	let arguments_ = [
		"chopin",
		"connect",
		".",
		"--planner",
		documentURL,
		"--planner-command",
		backend.trim(),
		...agentArguments(DEFAULT_AGENT),
	];
	return `CHOPIN_URL=${quote(origin, "sh")} ${arguments_.map(word => quote(word, "sh")).join(" ")}`;
}
