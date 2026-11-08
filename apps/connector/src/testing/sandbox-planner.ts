import { planFromEnvironment, report, sandboxChecks } from "./sandbox-checks";

/**
 * A Planner backend that does what the sandbox tests ask of one: it makes its own worktree of the
 * checkout it runs in, tries each thing from inside the sandbox, writes what happened beside that
 * worktree and waits to be stopped.
 */
let plan = planFromEnvironment();
plan.worktree = process.env.CHOPIN_WORKTREE!;
report(
	`${process.env.CHOPIN_WORKTREE}.report.json`,
	await sandboxChecks(plan, process.env.CHOPIN_CHECKOUT),
);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
