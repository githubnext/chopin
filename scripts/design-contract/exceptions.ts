import { createHash } from "node:crypto";

import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import type { Exception } from "./scan";

/** Group shared explanations without broadening each exact, counted exception. */
export function readExceptions(path: string, root = resolve(dirname(path), "../..")): Exception[] {
	let index = JSON.parse(readFileSync(path, "utf8"));
	if (index?.schemaVersion !== 1 || !Array.isArray(index.files) || !index.files.length) {
		throw new Error("Invalid design exception index");
	}
	let entries: Exception[] = [];
	let seen = new Set<string>();
	for (let file of index.files) {
		if (typeof file !== "string" || seen.has(file)) throw new Error("Invalid exception path");
		seen.add(file);
		let target = resolve(dirname(path), file);
		if (!target.startsWith(resolve(dirname(path), "exceptions") + sep)) {
			throw new Error("Exception outside manifest directory");
		}
		let groups = JSON.parse(readFileSync(target, "utf8"));
		if (!Array.isArray(groups)) throw new Error("Invalid exception groups");
		for (let group of groups) {
			if (
				typeof group?.file !== "string" || !group.file || typeof group.reason !== "string"
				|| !group.reason.trim() || !Array.isArray(group.cases) || !group.cases.length
			) {
				throw new Error("Invalid exception group");
			}
			if (
				group.sourceHash && group.cases.some((entry: unknown[]) => entry[0] === "typography")
				&& !group.producers?.length
			) {
				throw new Error("Dynamic typography needs explicit reviewed producer provenance");
			}
			for (let producer of group.producers ?? []) {
				if (
					typeof producer?.file !== "string" || !/^(apps|packages)\//.test(producer.file)
					|| typeof producer.sourceHash !== "string"
				) throw new Error("Invalid dynamic producer");
				let source = resolve(root, producer.file);
				if (!source.startsWith(resolve(root) + sep)) throw new Error("Producer outside repository");
				let hash = createHash("sha256").update(readFileSync(source)).digest("hex");
				if (hash !== producer.sourceHash) {
					throw new Error(`Reviewed dynamic producer changed: ${producer.file}`);
				}
			}
			for (let entry of group.cases) {
				if (
					!Array.isArray(entry) || entry.length !== 5 || !entry.slice(0, 4).every(value =>
						typeof value === "string"
					) || !Number.isInteger(entry[4]) || entry[4] < 1
				) {
					throw new Error("Invalid exact exception case");
				}
				let [family, property, value, context, count] = entry;
				entries.push({
					...(group.sourceHash ? { sourceHash: group.sourceHash } : {}),
					file: group.file,
					reason: group.reason,
					family,
					property,
					value,
					context,
					count,
				});
			}
		}
	}
	return entries;
}
