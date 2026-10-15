import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Chopin never joins inline information with a middle dot, bullet or dot operator.
 * Separate the pieces with layout (sibling elements with a gap, weight, colour or a line
 * break), or cut the metadata. See "Words" in apps/web/DESIGN.md.
 */
let root = dirname(import.meta.dir);
let self = "scripts/no-middot.test.ts";
// Built from code points so this file never contains what it forbids.
let glyphs = [0xb7, 0x22c5, 0x2022].map(point => String.fromCodePoint(point));
let escapes = [
	/\\u0*(?:00b7|22c5|2022)\b/i,
	/\\u\{0*(?:b7|22c5|2022)\}/i,
	/\\x[bB]7/,
	/\\0*(?:b7|22c5|2022)\b/i,
	/&(?:middot|bull|sdot);/,
	/&#(?:183|8901|8226|x0*(?:b7|22c5|2022));/i,
];

function tracked(): string[] {
	let listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "apps", "packages", "e2e"], {
		cwd: root,
	});
	if (listed.exitCode !== 0) throw new Error(listed.stderr.toString());
	return listed.stdout.toString().split("\0").filter(file =>
		file && file !== self && !/(^|\/)(node_modules|\.lane|design-jig)\//.test(file)
	);
}

test("no middle-dot separators in tracked source", () => {
	let problems: string[] = [];
	for (let file of tracked()) {
		let bytes: Buffer;
		try {
			bytes = readFileSync(join(root, file));
		} catch {
			continue; // Deleted in the working tree but still in the index.
		}
		if (bytes.includes(0)) continue; // Binary: images, video, fonts.
		bytes.toString("utf8").split("\n").forEach((line, index) => {
			if (glyphs.some(glyph => line.includes(glyph)) || escapes.some(re => re.test(line))) {
				problems.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
			}
		});
	}
	expect(
		problems,
		"Never separate inline information with a middle dot. Use layout (a gap between sibling "
			+ "elements, weight, colour, a line break) or cut the metadata; see apps/web/DESIGN.md.",
	).toEqual([]);
}, 30_000);
