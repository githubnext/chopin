#!/usr/bin/env bun
import { dirname, join } from "node:path";

import { readExceptions } from "./design-contract/exceptions";
import { applyExceptions, scan } from "./design-contract/scan";

let root = dirname(import.meta.dir);
let result = scan(root);
if (process.argv.includes("--inventory")) {
	console.log(JSON.stringify({ files: result.files, findings: result.findings }, null, 2));
} else {
	let exceptions = readExceptions(join(root, "scripts/design-contract/exceptions.json"));
	let errors = applyExceptions(result.findings, exceptions);
	if (errors.length) {
		console.error(errors.join("\n"));
		process.exit(1);
	}
	console.log(
		`design contract ok — ${result.files} sources; ${result.findings.length} exact reviewed exceptions`,
	);
}
