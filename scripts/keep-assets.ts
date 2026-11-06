/**
 * Keeps the hashed files of the builds before this one, so a tab left open across a deploy
 * still finds the chunks of the build it loaded.
 *
 * The image build runs it with the previous image's built client (`--previous`), the files that
 * image kept (`--kept`, with its `manifest.json`), and this build's own (`--current`), and writes
 * the files to keep and a manifest to `--out`. A build is kept while it is one of the last
 * `--builds` builds before this one and younger than `--days`. A build's age is the newest
 * modification time among its files, which a COPY from the previous image preserves. File names
 * carry their content hash, so one name is always one content and builds cannot collide.
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

/** Vite's default build names use an eight-character hash before the extension. */
const FINGERPRINTED = /^.+-[A-Za-z0-9_-]{8}\.[^/]+$/;
const DAY_MS = 86_400_000;

export type KeptBuild = { builtAt: string; files: string[] };
export type KeptManifest = { builds: KeptBuild[] };

export type KeepOptions = {
	/** The previous image's `assets` directory. */
	previous: string;
	/** The directory the previous image kept: `assets/` and `manifest.json`. */
	kept: string;
	/** This build's `assets` directory. */
	current: string;
	out: string;
	builds: number;
	days: number;
	now: Date;
};

function fingerprinted(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter(entry => entry.isFile())
		.map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1))
		.filter(name => FINGERPRINTED.test(name.split("/").at(-1)!))
		.toSorted();
}

function readManifest(kept: string): KeptBuild[] {
	try {
		let parsed = JSON.parse(readFileSync(join(kept, "manifest.json"), "utf8")) as KeptManifest;
		return parsed.builds.filter(build =>
			typeof build.builtAt === "string" && !Number.isNaN(Date.parse(build.builtAt))
			&& Array.isArray(build.files) && build.files.every(file => typeof file === "string")
		);
	} catch {
		return [];
	}
}

/** Writes `out/assets` and `out/manifest.json`; returns the manifest. */
export function keepAssets(options: KeepOptions): KeptManifest {
	let files = fingerprinted(options.previous);
	let builds: KeptBuild[] = files.length
		? [{
			builtAt: new Date(
				Math.max(...files.map(file => statSync(join(options.previous, file)).mtimeMs)),
			).toISOString(),
			files,
		}]
		: [];
	builds.push(...readManifest(options.kept));
	builds.sort((a, b) => Date.parse(b.builtAt) - Date.parse(a.builtAt));

	let current = new Set(fingerprinted(options.current));
	let written = new Set<string>();
	let manifest: KeptManifest = { builds: [] };
	let oldest = options.now.getTime() - options.days * DAY_MS;
	mkdirSync(join(options.out, "assets"), { recursive: true });
	for (let build of builds.slice(0, options.builds)) {
		if (Date.parse(build.builtAt) < oldest) continue;
		let kept: string[] = [];
		for (let file of build.files) {
			// A file this build has too is served from it, so keeping a second copy would add size only.
			if (current.has(file)) continue;
			let source = [join(options.previous, file), join(options.kept, "assets", file)]
				.find(existsSync);
			if (!source) continue;
			if (!written.has(file)) {
				mkdirSync(dirname(join(options.out, "assets", file)), { recursive: true });
				copyFileSync(source, join(options.out, "assets", file));
				written.add(file);
			}
			kept.push(file);
		}
		if (kept.length) manifest.builds.push({ builtAt: build.builtAt, files: kept });
	}
	writeFileSync(join(options.out, "manifest.json"), JSON.stringify(manifest, null, "\t") + "\n");
	return manifest;
}

if (import.meta.main) {
	let { values } = parseArgs({
		options: {
			previous: { type: "string" },
			kept: { type: "string" },
			current: { type: "string" },
			out: { type: "string" },
			builds: { type: "string", default: "2" },
			days: { type: "string", default: "30" },
		},
	});
	for (let name of ["previous", "kept", "current", "out"] as const) {
		if (!values[name]) throw new Error(`--${name} is required`);
	}
	let manifest = keepAssets({
		previous: values.previous!,
		kept: values.kept!,
		current: values.current!,
		out: values.out!,
		builds: Number(values.builds),
		days: Number(values.days),
		now: new Date(),
	});
	let count = manifest.builds.reduce((total, build) => total + build.files.length, 0);
	console.log(`kept ${count} files of ${manifest.builds.length} earlier builds`);
}
