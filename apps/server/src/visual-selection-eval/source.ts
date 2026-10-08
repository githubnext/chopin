import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import type { SourceCase } from "./experiment";

type CaseRef = { id: string; checkpoint: string };
type Cases = { version: 1; registrySha256: string; cases: CaseRef[] };
type RegistryFile = { checkpoint: string; cutoff: string; path: string; sha256: string };
type RegistryEntry = { id: string; kind: string; files?: RegistryFile[] };
type Registry = { development: RegistryEntry[] };

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export async function loadCases(manifestPath: string, registryPath: string): Promise<SourceCase[]> {
	let manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Cases;
	if (manifest.version !== 1 || manifest.cases.length < 1 || manifest.cases.length > 20) {
		throw new Error("Expected 1–20 selected development cases");
	}
	let registryBytes = await readFile(registryPath);
	if (digest(registryBytes) !== manifest.registrySha256) {
		throw new Error("Frozen development registry hash differs from case manifest");
	}
	let registry = JSON.parse(registryBytes.toString("utf8")) as Registry;
	let seen = new Set<string>();
	let cases: SourceCase[] = [];
	for (let selection of manifest.cases) {
		if (seen.has(selection.id)) throw new Error(`Repeated discussion cluster: ${selection.id}`);
		seen.add(selection.id);
		let entry = registry.development.find(item => item.id === selection.id);
		if (entry?.kind !== "async-discussion") {
			throw new Error(`Not a registered real development discussion: ${selection.id}`);
		}
		let file = entry.files?.find(item => item.checkpoint === selection.checkpoint);
		if (!file) throw new Error(`Unregistered checkpoint: ${selection.id}/${selection.checkpoint}`);
		let path = resolve(dirname(registryPath), file.path);
		if (relative(dirname(registryPath), path).startsWith("..")) {
			throw new Error("Checkpoint path escapes frozen development directory");
		}
		let bytes = await readFile(path);
		if (digest(bytes) !== file.sha256) {
			throw new Error(`Frozen checkpoint hash differs: ${selection.id}/${selection.checkpoint}`);
		}
		let snapshot = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
		let snapshotId = snapshot.episodeId ?? snapshot.episode;
		let checkpoint = snapshot.checkpointId ?? snapshot.checkpoint;
		if (typeof checkpoint === "number") checkpoint = `c${checkpoint}`;
		if (
			snapshotId !== selection.id || checkpoint !== selection.checkpoint
			|| snapshot.cutoff !== file.cutoff || !Array.isArray(snapshot.events)
		) {
			throw new Error(
				`Frozen checkpoint identity differs: ${selection.id}/${selection.checkpoint}`,
			);
		}
		let cutoff = Date.parse(file.cutoff);
		if (!Number.isFinite(cutoff)) throw new Error(`Invalid cutoff: ${selection.id}`);
		let events = snapshot.events.map(raw => {
			let event = raw as Record<string, unknown>;
			for (let field of ["createdAt", "lastEditedAt", "created_at", "edited_at", "visible_at"]) {
				let value = event[field];
				if (
					value != null && (typeof value !== "string" || !Number.isFinite(Date.parse(value))
						|| Date.parse(value) > cutoff)
				) {
					throw new Error(`Event outside cutoff: ${String(event.id)}`);
				}
			}
			return Object.fromEntries(
				[
					"id",
					"kind",
					"type",
					"actor",
					"actorType",
					"parentId",
					"createdAt",
					"lastEditedAt",
					"body",
					"event",
					"stateReason",
				].filter(key => event[key] !== undefined).map(key => [key, event[key]]),
			);
		});
		let input = {
			kind: "async-discussion",
			id: selection.id,
			checkpoint: selection.checkpoint,
			cutoff: file.cutoff,
			links: "inert",
			events,
		};
		if (JSON.stringify(input).length > 24_000) {
			throw new Error(`Jev source limit exceeded: ${selection.id}/${selection.checkpoint}`);
		}
		cases.push({
			id: `${selection.id}/${selection.checkpoint}`,
			cluster: selection.id,
			checkpoint: selection.checkpoint,
			input,
		});
	}
	return cases;
}
