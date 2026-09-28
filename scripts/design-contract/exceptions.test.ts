import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readExceptions } from "./exceptions";
import { applyExceptions, inspect } from "./scan";
import { extractSource } from "./source";

test("an explicitly reviewed imported typography producer cannot change behind an unchanged sink", () => {
	let root = mkdtempSync(join(tmpdir(), "chopin-dynamic-provenance-"));
	try {
		let dir = join(root, "scripts/design-contract");
		mkdirSync(join(dir, "exceptions"), { recursive: true });
		mkdirSync(join(root, "apps/web"), { recursive: true });
		let source = 'import {size} from "./sizes"; export const view = <p style={{fontSize:size}} />;';
		let producer = 'export const size = "var(--text-sm)";';
		let findings = inspect("apps/web/view.tsx", extractSource("view.tsx", source), {
			canonical: new Map([["--text-sm", "1rem"]]),
			aliases: new Map(),
		});
		let finding = findings[0]!;
		let group = {
			file: finding.file,
			sourceHash: finding.sourceHash,
			reason: "Reviewed imported specimen role.",
			producers: [{
				file: "apps/web/sizes.ts",
				sourceHash: createHash("sha256").update(producer).digest("hex"),
			}],
			cases: [[finding.family, finding.property, finding.value, finding.context, 1]],
		};
		let index = join(dir, "exceptions.json");
		writeFileSync(index, JSON.stringify({ schemaVersion: 1, files: ["exceptions/specimen.json"] }));
		writeFileSync(join(dir, "exceptions/specimen.json"), JSON.stringify([group]));
		writeFileSync(join(root, "apps/web/sizes.ts"), producer);
		expect(applyExceptions(findings, readExceptions(index))).toEqual([]);
		writeFileSync(join(root, "apps/web/sizes.ts"), 'export const size = "9px";');
		expect(() => readExceptions(index)).toThrow("Reviewed dynamic producer changed");
		writeFileSync(
			join(dir, "exceptions/specimen.json"),
			JSON.stringify([{ ...group, producers: [] }]),
		);
		expect(() => readExceptions(index)).toThrow("explicit reviewed producer provenance");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
