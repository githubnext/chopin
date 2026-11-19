import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { READY_LINE } from "../planner-spare";

/**
 * A Planner backend that writes to `ai-report.json` in its worktree what its environment holds and
 * what came of reading each of AI_AGENT_PEEK, once it has its document: at once when started cold,
 * or, started as a spare, once it is assigned one. It then waits to be stopped.
 */
function read(path: string): { text: string } | { error: string } {
	try {
		return { text: readFileSync(path, "utf8") };
	} catch (error) {
		return { error: (error as NodeJS.ErrnoException).code ?? String(error) };
	}
}

function report() {
	let path = join(process.env.CHOPIN_WORKTREE!, "ai-report.json");
	writeFileSync(
		`${path}.tmp`,
		JSON.stringify({
			env: process.env,
			peeked: Object.fromEntries(
				(process.env.AI_AGENT_PEEK ?? "").split(",").filter(Boolean).map(
					path => [path, read(path)],
				),
			),
		}),
	);
	renameSync(`${path}.tmp`, path);
}

if (process.env.CHOPIN_PLANNER_SPARE) {
	console.log(READY_LINE);
	for await (let line of console) {
		if (!line.trim()) continue;
		let message = JSON.parse(line) as { type?: string };
		if (message.type === "assign") report();
		if (message.type === "stop") process.exit(0);
	}
	process.exit(0);
} else {
	report();
	await new Promise(() => {});
}
