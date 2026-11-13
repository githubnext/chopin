import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * A Planner backend for the connector's tests that takes spare mode (spare protocol 1). Started
 * with CHOPIN_PLANNER_SPARE=1 it records how it was started, prints the ready line and waits on its
 * stdin, recording each `assign`, `github` and `stop` line with what its credential files held at
 * that moment; started cold, it records that and waits to be stopped. Every record is a JSON line
 * in CHOPIN_TEST_SPARE_LOG. CHOPIN_TEST_SPARE picks a misbehaviour: `silent` never prints ready,
 * `old` is a command from before spare mode (with no document it exits at once), `crash` exits 4
 * a moment after it printed ready.
 */
let log = process.env.CHOPIN_TEST_SPARE_LOG!;
let mode = process.env.CHOPIN_TEST_SPARE ?? "";
let record = (event: Record<string, unknown>) =>
	appendFileSync(log, `${JSON.stringify({ pid: process.pid, at: Date.now(), ...event })}\n`);
let read = (name: string) => {
	let path = process.env[name];
	return path && existsSync(path) ? readFileSync(path, "utf8").trim() : null;
};
const NAMES = [
	"CHOPIN_URL",
	"CHOPIN_DOCUMENT",
	"CHOPIN_PLANNER_TOKEN",
	"CHOPIN_PLANNER_TOKEN_FILE",
	"CHOPIN_MCP_TOKEN_FILE",
	"CHOPIN_GITHUB_TOKEN",
	"CHOPIN_GITHUB_TOKEN_FILE",
	"CHOPIN_CHECKOUT",
	"CHOPIN_WORKTREE",
	"CHOPIN_PLANNER_SPARE",
	"GH_CONFIG_DIR",
	"GIT_AUTHOR_NAME",
	"SOME_FLAG",
];
let env = Object.fromEntries(NAMES.map(name => [name, process.env[name] ?? null]));
let spare = process.env.CHOPIN_PLANNER_SPARE === "1" && !process.env.CHOPIN_DOCUMENT;
process.on("SIGTERM", () => {
	record({ event: "sigterm" });
	process.exit(0);
});
if (mode === "old" && !process.env.CHOPIN_DOCUMENT) {
	record({ event: "start", spare: false, env });
	process.exit(2);
}
record({ event: "start", spare, env });
if (spare && mode !== "silent") {
	process.stdout.write(`chopin-planner-spare: ready ${JSON.stringify({ protocol: 1 })}\n`);
	if (mode === "crash") setTimeout(() => process.exit(4), 150);
}
if (spare) {
	let lines = createInterface({ input: process.stdin });
	lines.on("line", line => {
		let message = JSON.parse(line) as { type: string };
		record({
			event: message.type,
			line,
			planner: read("CHOPIN_PLANNER_TOKEN_FILE"),
			mcp: read("CHOPIN_MCP_TOKEN_FILE"),
			github: read("CHOPIN_GITHUB_TOKEN_FILE"),
		});
		if (message.type === "assign") process.stdout.write("Attached as its Planner.\n");
		if (message.type === "stop") process.exit(0);
	});
	lines.on("close", () => {
		record({ event: "end" });
		process.exit(0);
	});
}
setInterval(() => {}, 1000);
