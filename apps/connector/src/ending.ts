/** How a build ended, as Chopin says in its answer to the build's last report. */

export type BuildEnding =
	| { kind: "stopped"; by: string }
	| { kind: "blocked"; task?: string; reason: string }
	| { kind: "failed"; error: string }
	| { kind: "finished"; pullRequests: string[]; tasks: number }
	| { kind: "returned"; reason: string }
	| { kind: "unfinished" };

/** The ending in Chopin's answer, when a server that says one sent it. */
export function endingOf(answer: unknown): BuildEnding | undefined {
	let ending = (answer as { ending?: unknown } | undefined)?.ending as BuildEnding | undefined;
	if (!ending || typeof ending !== "object" || typeof ending.kind !== "string") return;
	return ending;
}

/** A blocked build's reason, naming its task when Chopin did. */
export function blockedText(ending: { task?: string; reason: string }): string {
	return `${ending.task ? `“${ending.task}” is blocked: ` : ""}${ending.reason}`.replace(
		/[.\s]+$/,
		"",
	);
}
