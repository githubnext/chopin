import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { loadCases } from "./source";

test("reads only registered development bytes at the selected cutoff", async () => {
	let root = await mkdtemp(join(tmpdir(), "visual-selection-"));
	try {
		await mkdir(join(root, "real-source"));
		let snapshot = JSON.stringify({
			episode: "case-a",
			checkpoint: "c1",
			cutoff: "2025-01-01T00:00:00Z",
			events: [{
				id: "e1",
				actor: "person",
				createdAt: "2024-12-31T00:00:00Z",
				body: "A depends on B.",
				linkedContext: "excluded annotation",
			}],
		});
		let snapshotPath = join(root, "real-source", "c1.json");
		await writeFile(snapshotPath, snapshot);
		let sha = (value: string | Uint8Array) =>
			createHash("sha256").update(value)
				.digest("hex");
		let registry = JSON.stringify({
			development: [{
				id: "case-a",
				kind: "async-discussion",
				files: [{
					checkpoint: "c1",
					cutoff: "2025-01-01T00:00:00Z",
					path: "real-source/c1.json",
					sha256: sha(snapshot),
				}],
			}],
			reserved: { id: "secret" },
		});
		let registryPath = join(root, "registry.json");
		let manifestPath = join(root, "cases.json");
		await writeFile(registryPath, registry);
		await writeFile(
			manifestPath,
			JSON.stringify({
				version: 1,
				registrySha256: sha(registry),
				cases: [{ id: "case-a", checkpoint: "c1" }],
			}),
		);
		let cases = await loadCases(manifestPath, registryPath);
		expect(cases).toHaveLength(1);
		expect(JSON.stringify(cases[0]!.input)).not.toContain("excluded annotation");
		expect(JSON.stringify(cases[0]!.input)).toContain("A depends on B.");
		await writeFile(snapshotPath, snapshot.replace("A depends on B.", "A depends on C."));
		await expect(loadCases(manifestPath, registryPath)).rejects.toThrow("hash differs");
		await writeFile(
			manifestPath,
			JSON.stringify({
				version: 1,
				registrySha256: sha(registry),
				cases: [{ id: "secret", checkpoint: "c1" }],
			}),
		);
		await expect(loadCases(manifestPath, registryPath)).rejects.toThrow("Not a registered");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
