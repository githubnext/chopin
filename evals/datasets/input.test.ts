import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { listDevelopment, listProposals, loadInput, loadProposal } from "./input";
import registry from "./registry.json";
import sources from "./sources.json";

describe("historical development registry", () => {
	test("keeps the original source partitions and registry bytes", async () => {
		let cases = listDevelopment();
		expect(cases.filter((entry) => entry.kind === "synthetic-chat")).toHaveLength(19);
		expect(cases.filter((entry) => entry.kind === "async-discussion")).toHaveLength(7);
		expect(registry.reserved.count).toBe(12);
		expect(registry.reserved.access).toBe("archive-only");
		expect(registry.realSourcePartitions).toMatchObject({ validation: 5, reserved: 3 });
		let bytes = await readFile(new URL("registry.json", import.meta.url));
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(sources.registrySha256);
		cases[0].checkpoints.length = 0;
		expect(listDevelopment()[0].checkpoints.length).toBeGreaterThan(0);
		expect(listProposals()).toHaveLength(2);
	});

	test("rejects reserved, validation, unknown IDs and paths before reading", async () => {
		let reads = 0;
		let read = async () => {
			reads++;
			return new Uint8Array();
		};
		for (let id of ["H01", "sealed-final", "vue-mounted-cleanup", "../synthetic/D01.json"]) {
			await expect(loadInput(id, "c1", read)).rejects.toThrow("Unsupported development case");
		}
		await expect(loadInput("D01", "../held-out/H01.json", read)).rejects.toThrow(
			"Unsupported checkpoint",
		);
		expect(reads).toBe(0);
	});

	test("rejects changed historical bytes", async () => {
		await expect(loadInput("D01", "c2", async () => new TextEncoder().encode("{}")))
			.rejects.toThrow("Dataset bytes changed");
		await expect(loadProposal("proposal-rust-async-await", async () => new Uint8Array()))
			.rejects.toThrow("Dataset bytes changed");
	});
});
