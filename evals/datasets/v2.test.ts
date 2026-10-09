import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { listCases, loadCase } from "./v2";
import manifest from "./v2/manifest.json";

let root = new URL("./v2/", import.meta.url);

describe("committed development inputs v2", () => {
	test("loads and verifies every committed input offline", async () => {
		expect(manifest.version).toBe(2);
		let cases = listCases();
		expect(cases.filter((entry) => entry.origin === "synthetic")).toHaveLength(19);
		expect(cases.filter((entry) => entry.origin === "adapted")).toHaveLength(7);
		expect(cases.filter((entry) => entry.origin === "original-source")).toHaveLength(1);
		expect(cases.reduce((count, entry) => count + entry.checkpoints.length, 0)).toBe(95);
		for (let entry of manifest.cases) {
			let bytes = await readFile(new URL(entry.file.path, root));
			expect(bytes.byteLength).toBe(entry.file.bytes);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.file.sha256);
			for (let checkpoint of entry.checkpoints ?? [undefined]) {
				let input = await loadCase(entry.id, checkpoint);
				expect(input.id).toBe(entry.id);
				expect(input.origin).toBe(entry.origin);
				expect(input).not.toHaveProperty("expectations");
				expect(input).not.toHaveProperty("labels");
				if (input.kind === "synthetic-chat") {
					expect(input.steps.at(-1)).toMatchObject({ id: checkpoint, kind: "checkpoint" });
				} else if (input.kind === "async-discussion") {
					expect(input.events.length).toBeGreaterThan(0);
					for (let event of input.events) {
						expect(Date.parse(event.visibleAt ?? event.createdAt)).toBeLessThanOrEqual(
							Date.parse(input.cutoff),
						);
						expect(event.summary.length).toBeGreaterThan(0);
					}
				} else {
					expect(input.text.length).toBeGreaterThan(5_000);
					expect(input.links).toBe("inert");
				}
			}
		}
	});

	test("does not load unknown or reserved cases, checkpoints, or changed bytes", async () => {
		let reads = 0;
		let read = async () => {
			reads++;
			return new Uint8Array();
		};
		for (let id of ["H01", "sealed-final", "../synthetic/D01.json"]) {
			await expect(loadCase(id, "c2", read)).rejects.toThrow("Unsupported development case");
		}
		await expect(loadCase("D01", "H01", read)).rejects.toThrow("Unsupported checkpoint");
		await expect(loadCase("proposal-rust-async-await", "c1", read)).rejects.toThrow(
			"Unsupported checkpoint",
		);
		expect(reads).toBe(0);
		await expect(loadCase("D01", "c2", read)).rejects.toThrow("Dataset bytes changed");
	});
});
