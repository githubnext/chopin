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
 *
 * A copy may carry a recorded patch: `<file>.patch`, a unified diff from the registry's bytes (the
 * entry's `sha256`) to the file in the repository, one hunk per extension point, each with its reason
 * after the `@@`. It is checked as "the registry file at its recorded hash, plus exactly this patch":
 * the patch has the recorded hash, undoing it gives back the registry's bytes, and it only adds
 * extension points (props, slots, data attributes), never a class, a style or a geometry.
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

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/;

/** A unified diff as hunks of whole lines; `{ error }` where it is not one. Reasons follow the `@@`. */
export function parsePatch(text) {
	let hunks = [];
	let current;
	let lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	for (let line of lines) {
		let header = HUNK.exec(line);
		if (header) {
			current = {
				oldStart: Number(header[1]),
				oldCount: header[2] === undefined ? 1 : Number(header[2]),
				newStart: Number(header[3]),
				newCount: header[4] === undefined ? 1 : Number(header[4]),
				reason: (header[5] ?? "").trim(),
				oldLines: [],
				newLines: [],
				added: [],
			};
			hunks.push(current);
			continue;
		}
		// Anything before the first hunk is the diff's own header.
		if (!current) continue;
		let mark = line[0];
		if (mark === " " || line === "") {
			// An editor may have emptied a blank context line.
			current.oldLines.push(line.slice(1));
			current.newLines.push(line.slice(1));
		} else if (mark === "-") current.oldLines.push(line.slice(1));
		else if (mark === "+") {
			current.newLines.push(line.slice(1));
			current.added.push(line.slice(1));
		} else if (mark !== "\\") return { error: `unexpected line in a hunk: ${line}` };
	}
	if (!hunks.length) return { error: "has no hunk" };
	for (let hunk of hunks) {
		if (hunk.oldLines.length !== hunk.oldCount || hunk.newLines.length !== hunk.newCount) {
			return { error: `hunk at line ${hunk.newStart} does not have the lines its header counts` };
		}
	}
	return { hunks };
}

/**
 * Applies hunks to a text exactly, with no fuzz or offset: `from: "old"` turns the registry's bytes
 * into the patched file, `from: "new"` undoes it. `{ error }` says where the text is not what the
 * patch was made from.
 */
export function applyPatch(text, hunks, from) {
	let lines = text.split("\n");
	let out = [];
	let cursor = 0;
	for (let hunk of hunks) {
		let [seen, made, number, count] = from === "old"
			? [hunk.oldLines, hunk.newLines, hunk.oldStart, hunk.oldCount]
			: [hunk.newLines, hunk.oldLines, hunk.newStart, hunk.newCount];
		let start = count === 0 ? number : number - 1;
		if (start < cursor) return { error: `hunk at line ${number} overlaps the one before it` };
		let actual = lines.slice(start, start + seen.length);
		if (actual.length !== seen.length || actual.some((line, index) => line !== seen[index])) {
			return { error: `hunk at line ${number} no longer applies` };
		}
		out.push(...lines.slice(cursor, start), ...made);
		cursor = start + seen.length;
	}
	out.push(...lines.slice(cursor));
	return { text: out.join("\n") };
}

const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const STYLING = /\b(?:className|class|style)\s*=|\b(?:cn|cva|clsx|twMerge)\(/;

function counted(text) {
	let counts = new Map();
	for (let literal of text.match(LITERAL) ?? []) {
		counts.set(literal, (counts.get(literal) ?? 0) + 1);
	}
	return counts;
}

/**
 * What a patch may do: add extension points. It needs a reason on every hunk; it keeps every string
 * the registry wrote (so no class changes), adds none with a space in it (a class list) and adds
 * no `className`, `style`, `cn(` or `cva(`.
 */
export function patchProblems(pristine, patched, hunks) {
	let problems = [];
	for (let hunk of hunks) {
		if (hunk.reason.length < 8) {
			problems.push(`hunk at line ${hunk.newStart} needs a one-line reason after its @@`);
		}
		for (let line of hunk.added) {
			if (STYLING.test(line)) {
				problems.push(
					`hunk at line ${hunk.newStart} adds styling (${line.trim()}): a patch only adds extension points`,
				);
			}
		}
	}
	let before = counted(pristine);
	let after = counted(patched);
	for (let [literal, count] of before) {
		if ((after.get(literal) ?? 0) < count) {
			problems.push(`removes or changes a string the registry wrote: ${literal}`);
		}
	}
	for (let [literal, count] of after) {
		if (count > (before.get(literal) ?? 0) && /\s/.test(literal.slice(1, -1))) {
			problems.push(`adds a string with a space in it, which could be classes: ${literal}`);
		}
	}
	return problems;
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

/** Everything wrong with a patched copy; empty when it is the registry's file plus exactly its patch. */
function patchedProblems(root, entry) {
	if (entry.patch !== `${entry.file}.patch`) return [`its patch must be ${entry.file}.patch`];
	if (typeof entry.patchSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.patchSha256)) {
		return ["needs the sha256 of its patch (patchSha256)"];
	}
	let patchPath = join(root, entry.patch);
	if (!existsSync(patchPath) || !statSync(patchPath).isFile()) return [`${entry.patch} is missing`];
	let patchBytes = readFileSync(patchPath);
	if (sha256(patchBytes) !== entry.patchSha256) {
		return [`${entry.patch} no longer matches its record: record the patch again`];
	}
	let parsed = parsePatch(patchBytes.toString("utf8"));
	if (parsed.error) return [`${entry.patch} ${parsed.error}`];
	let patched = readFileSync(join(root, entry.file), "utf8");
	let undone = applyPatch(patched, parsed.hunks, "new");
	if (undone.error) {
		return [
			`${entry.patch} no longer applies (${undone.error}): the file is not the registry's plus this patch`,
		];
	}
	if (sha256(undone.text) !== entry.sha256) {
		return [
			"undoing its patch does not give back the registry's bytes at the recorded hash: "
			+ "copy it again with `shadcn add --overwrite`, apply the patch and record it",
		];
	}
	return patchProblems(undone.text, patched, parsed.hunks).map(problem =>
		`${entry.patch} ${problem}`
	);
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
		} else if (entry.patch !== undefined) {
			let problems = patchedProblems(root, entry);
			for (let problem of problems) result.errors.push(`${entry.file}: ${problem}`);
			if (!problems.length) result.files.add(entry.file);
		} else if (sha256(readFileSync(path)) !== entry.sha256) {
			result.errors.push(
				`${entry.file} no longer matches its record (${entry.registry}/${entry.item}, ${entry.version}); `
					+ "a copied file is never edited: copy it again with `shadcn add --overwrite` and run "
					+ "`bun scripts/record-registry-sources.ts`",
			);
		} else result.files.add(entry.file);
	}
	let patches = new Set(
		result.entries.flatMap(entry => entry.patch === undefined ? [] : [entry.patch]),
	);
	for (let file of present) {
		if (seen.has(file) || patches.has(file)) continue;
		result.errors.push(
			`${file} is in ${RECORDED_DIRECTORY}, which holds only copied registry files, but is not in `
				+ `${RECORDED_MANIFEST}: record it with \`bun scripts/record-registry-sources.ts <item>\`, `
				+ "or move hand-written code out of that directory",
		);
	}
	return result;
}
