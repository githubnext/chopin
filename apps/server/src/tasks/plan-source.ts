import { z } from "zod";

/**
 * Where a plan revision's files are on GitHub: a branch the Planner pushed and the commit on it
 * that holds them. A build of that revision starts from this commit instead of the builder's own
 * checkout, which never has files the Planner wrote in its own worktree.
 */
export type PlanSource = { revision: number; branch: string; commit: string };

/** How many revisions' sources a document keeps; a build copies the one it used. */
export const PLAN_SOURCES = 20;

/**
 * A branch name git accepts (`git check-ref-format --branch`), without a `refs/` prefix: no
 * component starting with a dot or ending in `.lock`, no `..`, `@{`, `//`, control or special
 * characters, and no leading or trailing slash or trailing dot.
 */
export function validBranch(name: string): boolean {
	return name.length > 0 && name.length <= 255
		&& name !== "@" && name !== "HEAD"
		&& !name.startsWith("refs/") && !name.startsWith("-")
		&& ![...name].some(char => char <= " " || char === "\x7f" || "~^:?*[\\".includes(char))
		&& !name.includes("..") && !name.includes("@{") && !name.includes("//")
		&& !name.startsWith("/") && !name.endsWith("/") && !name.endsWith(".")
		&& name.split("/").every(part => !part.startsWith(".") && !part.endsWith(".lock"));
}

export let planSourceSchema = z.object({
	revision: z.number().int().nonnegative(),
	branch: z.string().refine(validBranch, "invalid branch"),
	commit: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();

/** Restore the stored sources: oldest revision first, one per revision, none newer than `revision`. */
export function restorePlanSources(value: unknown, revision: number): PlanSource[] {
	if (value === undefined) return [];
	let sources = z.array(planSourceSchema).min(1).max(PLAN_SOURCES).parse(value);
	if (
		sources.some((item, index) => index > 0 && item.revision <= sources[index - 1]!.revision)
		|| sources.at(-1)!.revision > revision
	) throw new Error("invalid plan sources");
	return sources;
}

/**
 * Record `source` for its revision, replacing any earlier one for the same revision, and keep the
 * newest `PLAN_SOURCES`. The same source again changes nothing.
 */
export function withPlanSource(
	sources: readonly PlanSource[],
	source: PlanSource,
): { sources: PlanSource[]; changed: boolean } {
	let same = sources.find(item => item.revision === source.revision);
	if (same && same.branch === source.branch && same.commit === source.commit) {
		return { sources: [...sources], changed: false };
	}
	let next = [...sources.filter(item => item.revision !== source.revision), { ...source }]
		.sort((a, b) => a.revision - b.revision)
		.slice(-PLAN_SOURCES);
	return { sources: next, changed: true };
}

/** The source a build of plan revision `revision` starts from: the newest recorded at or before it. */
export function planSourceFor(
	sources: readonly PlanSource[],
	revision: number,
): PlanSource | undefined {
	let found = sources.findLast(item => item.revision <= revision);
	return found && { ...found };
}
