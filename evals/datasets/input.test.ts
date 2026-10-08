import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { listDevelopment, listProposals, loadInput, loadProposal } from "./input";
import proposals from "./proposals.json";
import registry from "./registry.json";
import sources from "./sources.json";

let snapshotRoot = new URL("../../data/visual-doc-corpus/development/", import.meta.url);
let localTest = existsSync(new URL("registry.json", snapshotRoot)) ? test : test.skip;

describe("development input registry", () => {
	test("keeps synthetic chat, async candidates, and archived partitions distinct", () => {
		let cases = listDevelopment();
		expect(cases.filter((entry) => entry.kind === "synthetic-chat").map((entry) => entry.id))
			.toEqual(Array.from({ length: 19 }, (_, index) => `D${String(index + 1).padStart(2, "0")}`));
		expect(cases.filter((entry) => entry.kind === "async-discussion")).toHaveLength(7);
		expect(
			cases.filter((entry) => entry.kind === "async-discussion")
				.reduce((sum, entry) => sum + entry.checkpoints.length, 0),
		).toBe(27);
		expect(registry.reserved.count).toBe(12);
		expect(registry.reserved.access).toBe("archive-only");
		expect(registry.realSourcePartitions).toMatchObject({ validation: 5, reserved: 3 });
		cases[0].checkpoints.length = 0;
		expect(listDevelopment()[0].checkpoints.length).toBeGreaterThan(0);
		expect(sources.registrySha256).toBe(
			"5cdc086840041f9b5c2140d90f9baa8355c7604b8b6fa46d991f09c9f3b889cb",
		);
		expect(sources.sources.map((entry) => entry.id)).toEqual(
			cases.filter((entry) => entry.kind === "async-discussion").map((entry) => entry.id),
		);
		expect(listProposals().map((entry) => entry.id)).toEqual([
			"proposal-rust-async-await",
			"proposal-eslint-per-rule-autofix",
		]);
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

	localTest("verifies every imported byte hash, including provenance", async () => {
		let manifest = await readFile(new URL("registry.json", import.meta.url));
		expect(createHash("sha256").update(manifest).digest("hex")).toBe(sources.registrySha256);
		for (let entry of registry.development) {
			for (let file of [entry.file, ...(entry.files ?? []), entry.provenance].filter(Boolean)) {
				let bytes = await readFile(new URL(file!.path, snapshotRoot));
				expect(createHash("sha256").update(bytes).digest("hex")).toBe(file!.sha256);
			}
		}
	});

	test("rejects changed bytes before parsing", async () => {
		await expect(loadInput("D01", "c2", async () => new TextEncoder().encode("{}")))
			.rejects.toThrow("Dataset bytes changed");
		await expect(loadProposal("proposal-rust-async-await", async () => new Uint8Array()))
			.rejects.toThrow("Dataset bytes changed");
	});

	localTest(
		"all 19 chats expose exact prefix inputs without expectations or later messages",
		async () => {
			for (let entry of registry.development.filter((entry) => entry.kind === "synthetic-chat")) {
				let raw = JSON.parse(await readFile(new URL(entry.file!.path, snapshotRoot), "utf8"));
				for (let checkpoint of entry.checkpoints!) {
					let input = await loadInput(entry.id, checkpoint);
					if (input.kind !== "synthetic-chat") throw new Error("Wrong input kind");
					let end = raw.input.steps.findIndex((step: { id: string }) => step.id === checkpoint);
					expect(input.steps).toEqual(raw.input.steps.slice(0, end + 1));
					expect(input).not.toHaveProperty("expectations");
					expect(input.steps.at(-1)?.id).toBe(checkpoint);
				}
			}
		},
	);

	localTest("preserves all chat step semantics for the bounded baseline", async () => {
		let counts = { say: 0, checkpoint: 0, "research-action": 0 };
		let waits: string[] = [];
		let actions: string[] = [];
		for (let entry of listDevelopment().filter((entry) => entry.kind === "synthetic-chat")) {
			let input = await loadInput(entry.id, entry.checkpoints.at(-1)!);
			if (input.kind !== "synthetic-chat") throw new Error("Wrong input kind");
			for (let step of input.steps) {
				counts[step.kind]++;
				if (step.kind === "checkpoint") waits.push(step.waitFor);
				if (step.kind === "research-action") actions.push(step.action);
			}
		}
		expect(counts).toEqual({ say: 119, checkpoint: 68, "research-action": 2 });
		expect([...new Set(waits)].sort()).toEqual(["analysis", "research-terminal", "settled"]);
		expect(actions.sort()).toEqual(["dismiss", "research"]);
	});

	localTest("every async checkpoint retains frozen metadata, cutoff, and inert links", async () => {
		for (let entry of registry.development.filter((entry) => entry.kind === "async-discussion")) {
			for (let file of entry.files!) {
				let paths: string[] = [];
				let input = await loadInput(entry.id, file.checkpoint, async (url) => {
					paths.push(url.pathname);
					return readFile(url);
				});
				if (input.kind !== "async-discussion") throw new Error("Wrong input kind");
				let raw = JSON.parse(await readFile(new URL(file.path, snapshotRoot), "utf8"));
				expect(input.events).toEqual(raw.events);
				expect(input.cutoff).toBe(file.cutoff);
				expect(input.links).toBe("inert");
				expect(input).not.toHaveProperty("labels");
				expect(input).not.toHaveProperty("annotations");
				expect(input).not.toHaveProperty("title");
				expect(input).not.toHaveProperty("save");
				expect(paths).toEqual([new URL(file.path, snapshotRoot).pathname]);
			}
		}
	});

	localTest("keeps pinned proposal text separate from discussion checkpoints", async () => {
		for (let entry of proposals.cases) {
			let input = await loadProposal(entry.id);
			expect(input.kind).toBe("authored-proposal");
			expect(input.links).toBe("inert");
			expect(input.cutoff).toBe(entry.cutoff);
			expect(input.text.length).toBeGreaterThan(5_000);
			expect(input).not.toHaveProperty("events");
			expect(input).not.toHaveProperty("annotations");
		}
		await expect(loadProposal("sealed-final", async () => new Uint8Array())).rejects.toThrow(
			"Unsupported proposal",
		);
		let discussion = await loadInput("eslint-per-rule-autofix", "c1");
		expect(discussion).not.toHaveProperty("text");
	});

	localTest("a process close remains evidence rather than a saved decision", async () => {
		let input = await loadInput("deno-run-task", "c2");
		if (input.kind !== "async-discussion") throw new Error("Wrong input kind");
		expect(input.events.some((event) => event.event === "closed")).toBe(true);
		expect(input).not.toHaveProperty("steps");
		expect(input).not.toHaveProperty("savedDecisions");
	});
});
