import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import manifest from "./decisions-v1/manifest.json";

let root = new URL("./decisions-v1/", import.meta.url);

// The leak check needs the collector's git-ignored raw cache, so CI runs the
// structural checks only.
function validate(script: string) {
	let run = Bun.spawnSync(["python3", "-I", new URL(script, root).pathname, "--no-leaks"]);
	return { code: run.exitCode, output: run.stdout.toString() + run.stderr.toString() };
}

describe("decisions-v1 corpus", () => {
	test("passes its validator", () => {
		let result = validate("validate.py");
		expect(result.output).toContain(" 0 problems");
		expect(result.code).toBe(0);
	});

	test("passes the document-record validator", () => {
		let result = validate("documents/validate.py");
		expect(result.output).toContain(" 0 problems");
		expect(result.code).toBe(0);
	});

	test("cuts every case at its checkpoints the way v2 does", async () => {
		expect(manifest.cases.length).toBeGreaterThan(0);
		for (let entry of manifest.cases) {
			let bytes = await readFile(new URL(entry.file.path, root));
			expect(bytes.byteLength).toBe(entry.file.bytes);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.file.sha256);
			let document = JSON.parse(new TextDecoder().decode(bytes));
			expect(document).toMatchObject({ schemaVersion: 2, origin: "adapted", id: entry.id });
			expect(document.cutoffs.map((cutoff: { id: string }) => cutoff.id)).toEqual(
				entry.checkpoints,
			);
			for (let cutoff of document.cutoffs) {
				let at = Date.parse(cutoff.at);
				let visible = document.events.filter(
					(event: { createdAt: string; visibleAt?: string }) =>
						Date.parse(event.visibleAt ?? event.createdAt) <= at,
				);
				expect(visible[0]?.kind).toBe("opening");
			}
		}
	});
});
