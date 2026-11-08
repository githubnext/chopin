import { planFromEnvironment, report, sandboxChecks } from "./sandbox-checks";

/**
 * A Planner backend that does what the sandbox tests ask of one: it finds the worktree of the
 * checkout it runs in that the connector made for it, tries each thing from inside the sandbox,
 * writes what happened in that worktree (the one place it was given) and waits to be stopped.
 */
let plan = planFromEnvironment();
plan.worktree = process.env.CHOPIN_WORKTREE!;
let checks = await sandboxChecks(plan, process.env.CHOPIN_CHECKOUT);
report(`${process.env.CHOPIN_WORKTREE}/report.json`, checks);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
