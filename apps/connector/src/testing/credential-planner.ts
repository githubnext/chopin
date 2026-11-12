import { writeFileSync } from "node:fs";

/**
 * A Planner backend that writes what it was given, by name, in its own worktree, and then waits to
 * be stopped, so a test can look at every process's command line while it runs.
 */
let names = (process.env.CHOPIN_TEST_HELD_NAMES ?? "").split(",").filter(Boolean);
writeFileSync(
	`${process.env.CHOPIN_WORKTREE}/held.json`,
	JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name] ?? null]))),
);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
