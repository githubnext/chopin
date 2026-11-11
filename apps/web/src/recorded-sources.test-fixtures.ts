import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The copied registry files (`components/sources.json`, absolute paths). The source scans in tests
 * police Chopin's own code and leave these out: they keep the registry's own classes, and the design
 * contract fails if one is edited or one is added unrecorded (docs/design-contract.md).
 */
export function recordedSources(root: string): Set<string> {
	let manifest = JSON.parse(
		readFileSync(join(root, "apps/web/src/components/sources.json"), "utf8"),
	);
	return new Set((manifest.files as { file: string }[]).map(entry => join(root, entry.file)));
}
