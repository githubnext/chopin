import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keepAssets } from "./keep-assets";

let roots: string[] = [];
afterEach(() => {
	for (let root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOW = new Date("2026-06-01T00:00:00.000Z");
const day = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

/** One image's built client or kept files, each file stamped with the build's time. */
function directory(files: Record<string, string>, builtAt = NOW): string {
	let root = mkdtempSync(join(tmpdir(), "chopin-keep-"));
	roots.push(root);
	for (let [name, content] of Object.entries(files)) {
		let path = join(root, name);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
		utimesSync(path, builtAt, builtAt);
	}
	return root;
}

function run(layout: {
	previous: Record<string, string>;
	builtAt?: Date;
	kept?: Record<string, string>;
	current?: Record<string, string>;
	builds?: number;
	days?: number;
}) {
	let out = directory({});
	let manifest = keepAssets({
		previous: directory(layout.previous, layout.builtAt),
		kept: directory(layout.kept ?? {}),
		current: directory(layout.current ?? {}),
		out,
		builds: layout.builds ?? 2,
		days: layout.days ?? 30,
		now: NOW,
	});
	return { manifest, files: readdirSync(join(out, "assets")).toSorted(), out };
}

describe("keeping the hashed files of earlier builds", () => {
	it("keeps the previous build's files and leaves out what the new build has itself", () => {
		let { manifest, files } = run({
			previous: {
				"index-AAAAAAAA.js": "old entry",
				"chunk-BBBBBBBB.js": "shared chunk",
				"style-CCCCCCCC.css": "old style",
				"favicon.svg": "not hashed",
			},
			current: { "index-DDDDDDDD.js": "new entry", "chunk-BBBBBBBB.js": "shared chunk" },
		});
		expect(files).toEqual(["index-AAAAAAAA.js", "style-CCCCCCCC.css"]);
		expect(manifest).toEqual({
			builds: [{
				builtAt: NOW.toISOString(),
				files: ["index-AAAAAAAA.js", "style-CCCCCCCC.css"],
			}],
		});
	});

	it("keeps the last two builds before this one, the older one from what the previous image kept", () => {
		let { manifest, files } = run({
			previous: { "index-AAAAAAAA.js": "one build ago" },
			builtAt: day(3),
			kept: {
				"assets/index-BBBBBBBB.js": "two builds ago",
				"assets/index-CCCCCCCC.js": "three builds ago",
				"manifest.json": JSON.stringify({
					builds: [
						{ builtAt: day(10).toISOString(), files: ["index-BBBBBBBB.js"] },
						{ builtAt: day(20).toISOString(), files: ["index-CCCCCCCC.js"] },
					],
				}),
			},
		});
		expect(files).toEqual(["index-AAAAAAAA.js", "index-BBBBBBBB.js"]);
		expect(manifest.builds.map(build => build.files)).toEqual([
			["index-AAAAAAAA.js"],
			["index-BBBBBBBB.js"],
		]);
	});

	it("drops a build that is older than the limit, and keeps nothing where there was no previous build", () => {
		expect(run({ previous: { "index-AAAAAAAA.js": "x" }, builtAt: day(31) }).files).toEqual([]);
		expect(run({ previous: { "index-AAAAAAAA.js": "x" }, builtAt: day(29) }).files)
			.toEqual(["index-AAAAAAAA.js"]);
		let empty = run({ previous: {} });
		expect(empty.files).toEqual([]);
		expect(empty.manifest).toEqual({ builds: [] });
	});

	it("carries on from a manifest it cannot read, and from a file the manifest names that is gone", () => {
		expect(
			run({
				previous: { "index-AAAAAAAA.js": "x" },
				kept: { "manifest.json": "not json" },
			}).files,
		).toEqual(["index-AAAAAAAA.js"]);
		let { manifest } = run({
			previous: { "index-AAAAAAAA.js": "x" },
			kept: {
				"manifest.json": JSON.stringify({
					builds: [{ builtAt: day(1).toISOString(), files: ["index-GONEGONE.js"] }],
				}),
			},
		});
		expect(manifest.builds.map(build => build.files)).toEqual([["index-AAAAAAAA.js"]]);
	});
});
