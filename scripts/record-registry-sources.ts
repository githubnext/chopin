#!/usr/bin/env bun
/**
 * Records what `shadcn add` copied, so the design contract can accept it as third-party source.
 *
 *   bunx shadcn@latest add @assistant-ui/<element> --cwd apps/web
 *   bun scripts/record-registry-sources.ts @assistant-ui/<element>
 *
 * For each item named, and the registry items it stands on, this finds the files shadcn wrote,
 * records the registry, item, upstream revision and sha256 of each in
 * `apps/web/src/components/sources.json`, and writes the assistant-ui layer
 * (`scripts/assistant-ui-layer.ts`) again, since it follows the copies' `data-slot` roots.
 * With no item it only writes the layer, which is what a Tailwind upgrade needs.
 *
 * A copy may carry a patch that adds extension points (props, slots, data attributes) and nothing
 * that changes a class or a size: `<file>.patch` beside it, one reason per hunk (see
 * docs/assistant-ui.md). Edit the copy, then
 *
 *   bun scripts/record-registry-sources.ts --patch <file> --reason "why" [--reason "why"...]
 *
 * writes the patch from `git diff HEAD` (HEAD must hold the registry's recorded bytes), checks the
 * rules and records it. After `shadcn add --overwrite`, recording the item applies the patch again
 * onto the fresh bytes, or fails naming the hunk that no longer applies.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";

import { LAYER_FILE, layerCss, slotsOf } from "./assistant-ui-layer";
import {
	applyPatch,
	parsePatch,
	patchProblems,
	RECORDED_MANIFEST,
	sha256,
} from "./design-contract/registry.mjs";

const ROOT = dirname(import.meta.dir);
/** What `shadcn` itself resolves a bare name against. */
const SHADCN = "https://ui.shadcn.com/r/styles/{style}/{name}.json";
const REPOSITORIES: Record<string, string> = {
	"@assistant-ui": "assistant-ui/assistant-ui",
	"@shadcn": "shadcn-ui/ui",
};

export type Config = {
	style: string;
	aliases: Record<"components" | "ui" | "lib" | "hooks", string>;
	registries?: Record<string, string>;
};
export type RegistryFile = { type: string; path: string; target?: string };
export type Item = {
	registry: string;
	name: string;
	files: RegistryFile[];
	registryDependencies: string[];
};

/** `@/components/ui` is `apps/web/src/components/ui`, by `paths` in apps/web/tsconfig.json. */
function aliased(alias: string): string {
	if (!alias.startsWith("@/")) throw new Error(`Alias ${alias} is not under @/ (src)`);
	return posix.join("apps/web/src", alias.slice(2));
}

/** shadcn's rule: what follows the first directory of the file's path named as the target's last. */
function nested(path: string, directory: string): string {
	let segments = path.replace(/^\/|\/$/g, "").split("/");
	let last = directory.split("/").at(-1);
	let at = segments.findIndex(segment => segment === last);
	return at < 0 ? segments.at(-1)! : segments.slice(at + 1).join("/");
}

/** Where `shadcn add` writes a registry file, with the aliases in `components.json`. */
export function installedPath(file: RegistryFile, config: Config): string {
	if (file.target) return posix.join("apps/web/src", file.target.replace(/^src\//, ""));
	let directory = {
		"registry:ui": config.aliases.ui,
		"registry:lib": config.aliases.lib,
		"registry:hook": config.aliases.hooks,
		"registry:component": config.aliases.components,
		"registry:block": config.aliases.components,
	}[file.type];
	if (!directory) throw new Error(`Unknown registry file type ${file.type} (${file.path})`);
	return posix.join(aliased(directory), nested(file.path, directory));
}

/** Where an item address is fetched from, and the registry it belongs to. */
export function itemUrl(address: string, config: Config): { url: string; registry: string } {
	if (/^https?:\/\//.test(address)) {
		return {
			url: address,
			registry: new URL(address).host === "ui.shadcn.com" ? "@shadcn" : "@assistant-ui",
		};
	}
	let named = /^(@[\w-]+)\/(.+)$/.exec(address);
	let registry = named?.[1] ?? "@shadcn";
	let template = registry === "@shadcn" ? SHADCN : config.registries?.[registry];
	if (!template) throw new Error(`${registry} is not a registry in components.json`);
	return {
		registry,
		url: template.replace("{style}", config.style).replace("{name}", named?.[2] ?? address),
	};
}

async function fetchItem(address: string, config: Config): Promise<Item> {
	let { url, registry } = itemUrl(address, config);
	let response = await fetch(url);
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	let item = await response.json() as {
		name: string;
		files?: RegistryFile[];
		registryDependencies?: string[];
	};
	return {
		registry,
		name: item.name,
		files: item.files ?? [],
		registryDependencies: item.registryDependencies ?? [],
	};
}

/** The item and everything it stands on, each once. */
async function resolve(addresses: string[], config: Config): Promise<Item[]> {
	let items = new Map<string, Item>();
	let pending = [...addresses];
	while (pending.length) {
		let item = await fetchItem(pending.shift()!, config);
		let key = `${item.registry}/${item.name}`;
		if (items.has(key)) continue;
		items.set(key, item);
		pending.push(...item.registryDependencies);
	}
	return [...items.values()];
}

/** The upstream repository's main commit now, which is what the registry serves from. */
function revision(registry: string): string {
	let repository = REPOSITORIES[registry];
	if (!repository) throw new Error(`No upstream repository is known for ${registry}`);
	let listed = spawnSync("git", [
		"ls-remote",
		`https://github.com/${repository}`,
		"refs/heads/main",
	], {
		encoding: "utf8",
	});
	let commit = /^([0-9a-f]{40})\s/.exec(listed.stdout)?.[1];
	if (!commit) throw new Error(`Could not read ${repository}'s main commit: ${listed.stderr}`);
	return `${repository}@${commit.slice(0, 12)}`;
}

type Entry = {
	file: string;
	registry: string;
	item: string;
	version: string;
	/** The registry's bytes; for a patched file, before its patch. */
	sha256: string;
	patch?: string;
	patchSha256?: string;
};

function readManifest(): Entry[] {
	let path = join(ROOT, RECORDED_MANIFEST);
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).files : [];
}

function write(path: string, content: string) {
	mkdirSync(dirname(join(ROOT, path)), { recursive: true });
	writeFileSync(join(ROOT, path), content);
}

/** The layer, from Tailwind's theme, Chopin's, and the roots of everything recorded. */
export function writeLayer(entries: Entry[]): Entry {
	let tailwind = createRequire(join(ROOT, "apps/web/package.json")).resolve(
		"tailwindcss/theme.css",
	);
	let version = JSON.parse(readFileSync(join(dirname(tailwind), "package.json"), "utf8")).version;
	let slots = entries.filter(entry => /\.tsx?$/.test(entry.file))
		.flatMap(entry => slotsOf(readFileSync(join(ROOT, entry.file), "utf8")));
	let css = layerCss({
		tailwind: readFileSync(tailwind, "utf8"),
		chopin: readFileSync(join(ROOT, "packages/visuals/theme.css"), "utf8"),
		slots,
	});
	write(LAYER_FILE, css);
	return {
		file: LAYER_FILE,
		registry: "tailwindcss",
		item: "theme.css",
		version: `tailwindcss@${version}`,
		sha256: sha256(css),
	};
}

/** What a patched copy was before its patch, if this entry's patch gives it back at the recorded hash. */
function pristineOf(patched: string, entry: Entry): string | undefined {
	if (sha256(patched) === entry.sha256) return patched;
	if (!entry.patch) return undefined;
	let parsed = parsePatch(readFileSync(join(ROOT, entry.patch), "utf8"));
	if (parsed.error) return undefined;
	let undone = applyPatch(patched, parsed.hunks, "new");
	return undone.text !== undefined && sha256(undone.text) === entry.sha256
		? undone.text
		: undefined;
}

/** A copy with its recorded patch, after `shadcn add` wrote the registry's bytes again or left them patched. */
function reapply(path: string, entry: Entry, fresh: string): Entry {
	let patchBytes = readFileSync(join(ROOT, entry.patch!));
	let parsed = parsePatch(patchBytes.toString("utf8"));
	if (parsed.error) throw new Error(`${entry.patch} ${parsed.error}`);
	let forward = applyPatch(fresh, parsed.hunks, "old");
	let pristine = fresh;
	let patched = forward.text;
	if (patched === undefined) {
		// Not freshly copied: it is fine if it is already the recorded bytes plus this patch.
		let undone = pristineOf(fresh, entry);
		if (undone === undefined || sha256(undone) === sha256(fresh)) {
			throw new Error(
				`${entry.patch} no longer applies to ${path} (${forward.error}): edit the patch`,
			);
		}
		pristine = undone;
		patched = fresh;
	} else {
		writeFileSync(join(ROOT, path), patched);
		console.log(`applied ${entry.patch}`);
	}
	let problems = patchProblems(pristine, patched, parsed.hunks);
	if (problems.length) throw new Error(`${entry.patch}: ${problems.join("; ")}`);
	return { ...entry, sha256: sha256(pristine), patchSha256: sha256(patchBytes) };
}

/** Writes `<file>.patch` from the edits made to a recorded copy since HEAD. */
function writePatch(file: string, reasons: string[], entries: Map<string, Entry>): void {
	let entry = entries.get(file);
	if (!entry) {
		throw new Error(`${file} is not recorded: copy it with shadcn add and record it first`);
	}
	let head = spawnSync("git", ["show", `HEAD:${file}`], { cwd: ROOT, encoding: "utf8" });
	if (head.status !== 0) throw new Error(`HEAD has no ${file}: commit the copy before patching it`);
	let pristine = pristineOf(head.stdout, entry);
	if (pristine === undefined) {
		throw new Error(
			`HEAD's ${file} is not the recorded registry bytes: commit the copy before patching it`,
		);
	}
	let working = readFileSync(join(ROOT, file), "utf8");
	if (working === pristine) throw new Error(`${file} has no edits to record`);
	let scratch = mkdtempSync(join(tmpdir(), "chopin-patch-"));
	try {
		writeFileSync(join(scratch, "a"), pristine);
		writeFileSync(join(scratch, "b"), working);
		let diff = spawnSync("git", ["diff", "--no-index", "--no-color", "-U3", "a", "b"], {
			cwd: scratch,
			encoding: "utf8",
		}).stdout;
		let from = diff.indexOf("\n@@");
		let hunks = diff.slice(from + 1).split(/^(?=@@ )/m);
		if (reasons.length !== 1 && reasons.length !== hunks.length) {
			throw new Error(
				`${hunks.length} hunks need ${hunks.length} --reason (or one for all), got ${reasons.length}`,
			);
		}
		let text = hunks.map((hunk, index) =>
			hunk.replace(/^(@@ .*? @@).*$/m, `$1 ${reasons[reasons.length === 1 ? 0 : index]}`)
		).join("");
		let patch = `--- a/${file}\n+++ b/${file}\n${text}`;
		let parsed = parsePatch(patch);
		if (parsed.error) throw new Error(`${file}: ${parsed.error}`);
		let problems = patchProblems(pristine, working, parsed.hunks);
		if (problems.length) throw new Error(`${file}: ${problems.join("; ")}`);
		write(`${file}.patch`, patch);
		entries.set(file, {
			...entry,
			sha256: sha256(pristine),
			patch: `${file}.patch`,
			patchSha256: sha256(patch),
		});
		console.log(`wrote ${file}.patch (${parsed.hunks.length} hunks)`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	let config: Config = JSON.parse(readFileSync(join(ROOT, "apps/web/components.json"), "utf8"));
	let flags = process.argv.slice(2);
	let reasons: string[] = [];
	let patching: string | undefined;
	let addresses: string[] = [];
	for (let index = 0; index < flags.length; index++) {
		if (flags[index] === "--reason") reasons.push(flags[++index] ?? "");
		else if (flags[index] === "--patch") patching = flags[++index];
		else if (!flags[index]!.startsWith("-")) addresses.push(flags[index]!);
	}
	let kept = new Map(readManifest().map(entry => [entry.file, entry]));
	let versions = new Map<string, string>();
	for (let item of await resolve(addresses, config)) {
		if (!item.files.length) continue;
		let version = versions.get(item.registry) ?? revision(item.registry);
		versions.set(item.registry, version);
		for (let file of item.files) {
			let path = installedPath(file, config);
			if (!existsSync(join(ROOT, path))) {
				throw new Error(
					`${item.registry}/${item.name} should have written ${path}: run \`shadcn add\` first`,
				);
			}
			let copied: Entry = {
				file: path,
				registry: item.registry,
				item: item.name,
				version,
				sha256: sha256(readFileSync(join(ROOT, path))),
			};
			let previous = kept.get(path);
			if (previous?.patch) {
				copied = {
					...copied,
					...reapply(path, previous, readFileSync(join(ROOT, path), "utf8")),
					version,
					registry: item.registry,
					item: item.name,
				};
			}
			kept.set(path, copied);
			console.log(`recorded ${path} (${item.registry}/${item.name})`);
		}
	}
	if (patching) writePatch(patching, reasons, kept);
	kept.delete(LAYER_FILE);
	let layer = writeLayer([...kept.values()]);
	let files = [...kept.values(), layer].sort((a, b) => a.file.localeCompare(b.file));
	write(RECORDED_MANIFEST, JSON.stringify({ schemaVersion: 1, files }, null, "\t") + "\n");
	console.log(`recorded ${layer.file} (${layer.version}); ${files.length} files in all`);
}
