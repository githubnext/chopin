#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { designRecordProblems } from "./design-contract/record";

if (import.meta.main) {
	try {
		let root = join(import.meta.dir, "..");
		let read = (path: string) => readFileSync(join(root, path), "utf8");
		let problems = designRecordProblems(
			read("packages/visuals/theme.css"),
			read("apps/web/DESIGN.md"),
			read("apps/web/.impeccable/design.json"),
			{ web: read("apps/web/src/theme.css"), editor: read("packages/editor/src/styles.css") },
		);
		if (problems.length) {
			console.error(problems.join("\n"));
			process.exitCode = 1;
		} else console.log("Design record agrees with the shared theme.");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
