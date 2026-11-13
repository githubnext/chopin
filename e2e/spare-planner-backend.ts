/**
 * A Planner backend for planner-spare.e2e.ts that attaches as a real one does and reports a model
 * at once, so Chat shows its model selector. Started as a spare (CHOPIN_PLANNER_SPARE=1, no
 * document) it prints the ready line and attaches when its stdin hands it a document; started
 * cold it attaches at once. With CHOPIN_SPARE_STUB=old it is a command from before spare mode:
 * with no document it exits. What it did goes, a JSON line each, to CHOPIN_SPARE_STUB_LOG.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { connectAgent } from "../packages/agent-link/src/client";

let log = process.env.CHOPIN_SPARE_STUB_LOG;
let note = (event: string, detail: Record<string, unknown> = {}) => {
	if (log) {
		appendFileSync(
			log,
			`${JSON.stringify({ event, at: Date.now(), pid: process.pid, ...detail })}\n`,
		);
	}
};
const CATALOG = {
	models: {
		available: [{ id: "acme/small", name: "Small", provider: { id: "acme", name: "Acme" } }],
		default: { id: "acme/small" },
	},
};
async function attach(document: string) {
	let file = process.env.CHOPIN_PLANNER_TOKEN_FILE;
	let token = (file ? readFileSync(file, "utf8").trim().split("\n")[0] : undefined)
		|| process.env.CHOPIN_PLANNER_TOKEN!;
	await connectAgent({
		url: process.env.CHOPIN_URL!,
		token,
		document,
		capabilities: CATALOG,
		handlers: { turn() {} },
	});
	note("attached", { document });
}
process.on("SIGTERM", () => process.exit(0));
let document = process.env.CHOPIN_DOCUMENT;
if (!document && process.env.CHOPIN_SPARE_STUB === "old") {
	note("exited", { why: "no document" });
	process.exit(2);
}
if (!document && process.env.CHOPIN_PLANNER_SPARE === "1") {
	note("spare");
	process.stdout.write(`chopin-planner-spare: ready ${JSON.stringify({ protocol: 1 })}\n`);
	let lines = createInterface({ input: process.stdin });
	lines.on("line", line => {
		let message = JSON.parse(line) as { type: string; document?: string };
		if (message.type !== "assign" || !message.document) return;
		note("assign", { document: message.document });
		void attach(message.document);
	});
	lines.on("close", () => process.exit(0));
} else if (document) {
	note("cold", { document });
	await attach(document);
}
setInterval(() => {}, 1000);
