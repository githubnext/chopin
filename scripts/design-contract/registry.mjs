/**
 * Recorded third-party source.
 *
 * Components copied from a registry with `shadcn add` (assistant-ui's elements and the shadcn parts
 * they stand on) keep the registry's own classes, so they cannot follow Chopin's token rules. They
 * are accepted as a set, never one finding at a time, and only while each file is exactly what was
 * recorded: its registry, item, upstream revision and the hash of its bytes. Hand-written code
 * keeps every rule: a file under the recorded directory that is not recorded fails, and so does a
 * recorded file that was edited. The check is shared by the design contract (`scan.ts`) and the
 * Impeccable gate (`check-design.mjs`), which runs on plain Node, so this stays JavaScript.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Holds only copied registry files: `components.json` aliases every shadcn target into it. */
export const RECORDED_DIRECTORY = "apps/web/src/components";
export const RECORDED_MANIFEST = `${RECORDED_DIRECTORY}/sources.json`;
/** shadcn writes a few target-pinned files (`lib/utils.ts`) beside the directory, inside `src`. */
export const RECORDED_AREA = "apps/web/src/";

export const REGISTRIES = ["@assistant-ui", "@shadcn", "tailwindcss"];
const REVISION = /^[\w.-]+\/[\w.-]+@[0-9a-f]{7,40}$/;
const TAILWIND_VERSION = /^tailwindcss@\d+\.\d+\.\d+$/;
const ITEM = /^[a-z0-9][a-z0-9.-]*$/;

export function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

function listed(root, directory) {
	let absolute = join(root, directory);
	if (!existsSync(absolute)) return [];
	return readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
		let path = `${directory}/${entry.name}`;
		return entry.isDirectory() ? listed(root, path) : [path];
	});
}

function problemWith(entry, tailwind) {
	if (!entry || typeof entry !== "object") return "is not an object";
	let { file, registry, item, version, sha256: hash } = entry;
	if (
		typeof file !== "string" || !file.startsWith(RECORDED_AREA) || file.includes("..")
		|| file.includes("\\") || file.includes("//")
	) return `needs a file path inside ${RECORDED_AREA}`;
	if (!REGISTRIES.includes(registry)) return `names a registry other than ${REGISTRIES.join(", ")}`;
	if (typeof item !== "string" || !ITEM.test(item)) return "needs the registry item it came from";
	if (typeof version !== "string") return "needs the upstream version it was copied at";
	if (registry === "tailwindcss") {
		if (!TAILWIND_VERSION.test(version)) return "needs a version like tailwindcss@4.3.0";
		if (tailwind && version !== `tailwindcss@${tailwind}`) {
			return `was generated from ${version}, but tailwindcss ${tailwind} is installed: generate it again`;
		}
	} else if (!REVISION.test(version)) {
		return "needs a version like owner/repo@<upstream commit>";
	}
	if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
		return "needs the sha256 of its file";
	}
}

function installedTailwind(root) {
	try {
		return JSON.parse(
			readFileSync(join(root, "apps/web/node_modules/tailwindcss/package.json"), "utf8"),
		)
			.version;
	} catch {
		return undefined;
	}
}

/**
 * Reads the manifest and checks every recorded file. `files` holds the ones that match their
 * record and so are accepted as third-party source; `errors` says everything else.
 */
export function verifyRecordedSources(root) {
	let result = { files: new Set(), errors: [], entries: [] };
	let manifest = join(root, RECORDED_MANIFEST);
	let present = listed(root, RECORDED_DIRECTORY).filter(file => file !== RECORDED_MANIFEST);
	let parsed;
	if (existsSync(manifest)) {
		try {
			parsed = JSON.parse(readFileSync(manifest, "utf8"));
		} catch {
			result.errors.push(`${RECORDED_MANIFEST} is not valid JSON`);
			return result;
		}
		if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.files)) {
			result.errors.push(`${RECORDED_MANIFEST} needs "schemaVersion": 1 and a "files" array`);
			return result;
		}
	}
	let tailwind = parsed?.files?.some(entry => entry?.registry === "tailwindcss")
		? installedTailwind(root)
		: undefined;
	let seen = new Set();
	for (let [index, entry] of (parsed?.files ?? []).entries()) {
		let problem = problemWith(entry, tailwind);
		if (problem) {
			result.errors.push(`${RECORDED_MANIFEST} entry ${index + 1} ${problem}`);
			continue;
		}
		if (seen.has(entry.file)) {
			result.errors.push(`${RECORDED_MANIFEST} records ${entry.file} twice`);
			continue;
		}
		seen.add(entry.file);
		result.entries.push(entry);
		let path = join(root, entry.file);
		if (!existsSync(path) || !statSync(path).isFile()) {
			result.errors.push(`${entry.file} is recorded (${entry.registry}/${entry.item}) but missing`);
		} else if (sha256(readFileSync(path)) !== entry.sha256) {
			result.errors.push(
				`${entry.file} no longer matches its record (${entry.registry}/${entry.item}, ${entry.version}); `
					+ "a copied file is never edited: copy it again with `shadcn add --overwrite` and run "
					+ "`bun scripts/record-registry-sources.ts`",
			);
		} else result.files.add(entry.file);
	}
	for (let file of present) {
		if (seen.has(file)) continue;
		result.errors.push(
			`${file} is in ${RECORDED_DIRECTORY}, which holds only copied registry files, but is not in `
				+ `${RECORDED_MANIFEST}: record it with \`bun scripts/record-registry-sources.ts <item>\`, `
				+ "or move hand-written code out of that directory",
		);
	}
	return result;
}
