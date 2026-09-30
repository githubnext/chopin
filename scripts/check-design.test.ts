import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { designProblems, scanDesign } from "./check-design.mjs";

let root = resolve(import.meta.dir, "..");
let entry = {
	rule: "side-tab",
	file: "packages/editor/src/styles.css",
	snippet: "border-inline-start: 3px solid",
	count: 1,
	reason: "The accepted quote edge.",
};
let baseline = { schemaVersion: 1, findings: [entry] };
let finding = {
	antipattern: entry.rule,
	file: join(root, entry.file),
	snippet: entry.snippet,
};
let scan = (findings: unknown = [finding]) => ({ status: 2, stdout: JSON.stringify(findings) });

describe("Impeccable design gate", () => {
	it("retains design context and disables inline waivers in the scanner invocation", () => {
		let calls: unknown[][] = [];
		scanDesign(root, (...args: unknown[]) => {
			calls.push(args);
			return scan();
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]![0]).toBe(join(root, "node_modules/.bin/impeccable"));
		expect(calls[0]![1]).toContain("--no-inline-ignores");
		expect(calls[0]![1]).not.toContain("--no-config");
		expect(calls[0]![1]).not.toContain("--no-design-system");
		expect(calls[0]![2]).toMatchObject({ cwd: join(root, "apps/web") });
	});

	it("fails closed for scanner errors, partial scans, and termination", () => {
		for (
			let failed of [
				{ ...scan(), status: 1, stderr: "Target could not be scanned" },
				{ ...scan(), status: null },
				{ ...scan(), status: 0, error: new Error("spawn failed") },
			]
		) {
			expect(() => designProblems(failed, baseline, root)).toThrow("Impeccable scan failed");
		}
	});

	it("rejects malformed scanner JSON and findings instead of treating them as empty", () => {
		expect(() => designProblems({ status: 0, stdout: "invalid" }, baseline, root))
			.toThrow("invalid JSON");
		for (
			let invalid of [{}, null, [null], [{}], [{ ...finding, antipattern: 1 }], [
				{ ...finding, file: "relative.css" },
			], [{ ...finding, snippet: "" }]]
		) {
			expect(() => designProblems(scan(invalid), baseline, root)).toThrow();
		}
	});

	it("rejects findings outside the repository boundary", () => {
		expect(() =>
			designProblems(
				scan([{ ...finding, file: resolve(root, "../elsewhere.css") }]),
				baseline,
				root,
			)
		).toThrow("outside the repository");
	});

	it("accepts only the exact baseline identity and count", () => {
		expect(designProblems(scan(), baseline, root)).toEqual({ changes: [], count: 1 });
		expect(designProblems({ ...scan([]), status: 0 }, { schemaVersion: 1, findings: [] }, root))
			.toEqual({ changes: [], count: 0 });
		expect(designProblems(scan([finding, finding]), baseline, root).changes)
			.toEqual([`NEW ${entry.rule} in ${entry.file}: ${entry.snippet} (1)`]);
		expect(designProblems(scan([]), baseline, root).changes)
			.toEqual([`STALE baseline ${entry.rule} in ${entry.file}: ${entry.snippet}`]);
		for (
			let change of [
				{ snippet: "border-inline-start: 4px solid" },
				{ file: join(root, "apps/web/src/new.css") },
				{ antipattern: "different-rule" },
			]
		) {
			let result = designProblems(scan([{ ...finding, ...change }]), baseline, root);
			expect(result.changes).toHaveLength(2);
			expect(result.changes[0]).toStartWith("NEW ");
			expect(result.changes[1]).toStartWith("STALE ");
		}
	});

	it("requires valid baseline schema, unique exact entries, and an explanation", () => {
		for (let invalid of [null, {}, { schemaVersion: 2, findings: [] }]) {
			expect(() => designProblems(scan(), invalid, root)).toThrow("baseline file");
		}
		for (
			let change of [
				{ reason: "" },
				{ reason: undefined },
				{ count: 0 },
				{ count: 1.5 },
				{ rule: 7 },
				{ file: "../elsewhere.css" },
				{ file: "./packages/editor/src/styles.css" },
				{ file: join(root, entry.file) },
			]
		) {
			expect(() =>
				designProblems(scan(), { ...baseline, findings: [{ ...entry, ...change }] }, root)
			).toThrow("baseline entry");
		}
		expect(() => designProblems(scan(), { ...baseline, findings: [entry, entry] }, root))
			.toThrow("Repeated");
	});

	it("the installed detector reports an inline-disabled finding when the gate flag is set", () => {
		let directory = mkdtempSync(join(tmpdir(), "chopin-design-inline-"));
		try {
			let file = join(directory, "fixture.css");
			writeFileSync(
				file,
				"/* impeccable-disable side-tab: regression fixture */\n"
					+ ".quote { border-inline-start: 3px solid var(--color-border); }\n",
			);
			let command = join(root, "node_modules/.bin/impeccable");
			let options = { cwd: join(root, "apps/web"), encoding: "utf8" as const };
			let waived = spawnSync(command, ["detect", "--json", file], options);
			let checked = spawnSync(command, ["detect", "--json", "--no-inline-ignores", file], options);
			expect(waived.error).toBeUndefined();
			expect(checked.error).toBeUndefined();
			expect(waived.status).toBe(0);
			expect(JSON.parse(waived.stdout)).toEqual([]);
			expect(checked.status).toBe(2);
			expect(JSON.parse(checked.stdout)).toEqual([
				expect.objectContaining({ antipattern: "side-tab", file }),
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
