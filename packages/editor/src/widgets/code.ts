/**
 * What a fence says about itself.
 *
 * A fence carries two strings and neither is content: the language, which
 * decides how the block is coloured, and the rest of the info string, which
 * the dialect keeps verbatim so that opening and saving a plan does not
 * rewrite it. This is the reading of both, kept apart from anything that
 * renders them because none of it needs a document, a browser or a renderer —
 * and because the renderer is several hundred kilobytes that `bun test` should
 * never have to load.
 */

import { DIFF_LANGUAGE, MERMAID_LANGUAGE } from "@chopin/dialect";

/**
 * How a block is drawn, which is not the same as what its fence says.
 *
 * `plain` is a fence with no language: it renders nothing, because a rendered
 * preview of uncoloured text beside the same uncoloured text is two of the
 * same thing and an invitation to edit the wrong one.
 */
export type Kind = "plain" | "code" | "diff" | "mermaid";

export function kindOf(language: string): Kind {
	if (!language) return "plain";
	if (language === MERMAID_LANGUAGE) return "mermaid";
	if (language === DIFF_LANGUAGE) return "diff";
	return "code";
}

/**
 * Languages the selector offers, in the order it offers them.
 *
 * A curated few rather than everything the highlighter has: a list of six
 * hundred is not a control, and a fence may still say anything at all — one
 * the agent wrote in a language not listed here is kept, offered as its own
 * entry, and coloured if the highlighter knows it.
 *
 * The ids are the highlighter's own, so a plan written elsewhere and opened
 * here colours without translation.
 */
export const LANGUAGES: readonly (readonly [id: string, label: string])[] = Object.freeze(
	[
		["bash", "Shell"],
		["c", "C"],
		["cpp", "C++"],
		["csharp", "C#"],
		["css", "CSS"],
		[DIFF_LANGUAGE, "Diff"],
		["dockerfile", "Dockerfile"],
		["go", "Go"],
		["graphql", "GraphQL"],
		["html", "HTML"],
		["java", "Java"],
		["javascript", "JavaScript"],
		["json", "JSON"],
		["kotlin", "Kotlin"],
		["markdown", "Markdown"],
		[MERMAID_LANGUAGE, "Mermaid"],
		["php", "PHP"],
		["python", "Python"],
		["ruby", "Ruby"],
		["rust", "Rust"],
		["sql", "SQL"],
		["swift", "Swift"],
		["toml", "TOML"],
		["tsx", "TSX"],
		["typescript", "TypeScript"],
		["xml", "XML"],
		["yaml", "YAML"],
	] as const,
);

/**
 * The title an author wrote on the fence, if any.
 *
 * `title="a.js"` is the convention every static site generator settled on and
 * the one an agent is most likely to produce; `filename=` is accepted because
 * it is the other one. Quotes are required: an unquoted value cannot contain a
 * space, and half-supporting it would mean a path with a space in it silently
 * losing its tail.
 */
export function titleOf(meta: string): string | undefined {
	let found = /(?:^|\s)(?:title|filename)=(?:"([^"]*)"|'([^']*)')/.exec(meta);
	let title = found?.[1] ?? found?.[2];
	return title ? title.trim() || undefined : undefined;
}

/**
 * What to call the block when handing it to the renderer.
 *
 * The renderer works in files: it takes a name, shows it, and falls back to it
 * when nothing else says what the language is. A fence usually has no name, so
 * one is invented from the language — invented rather than omitted, because an
 * empty name is a header reading as a missing file rather than a snippet.
 *
 * The invented name is never shown; `titled` is what decides that.
 */
export function fileNameOf(language: string, meta: string): string {
	return titleOf(meta) ?? (language ? `snippet.${language}` : "snippet.txt");
}

/**
 * Whether the block has a name worth drawing a header for.
 *
 * A snippet's identity is its language, which the control beside it already
 * says. A snippet quoting a file has a second identity — which file — and that
 * one nothing else in the block can carry.
 */
export function titled(meta: string): boolean {
	return titleOf(meta) !== undefined;
}

/** `@@ -12,7 +12,9 @@ what the hunk is inside`, with the counts optional. */
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** A line that belongs to a hunk rather than ending one. */
function body(line: string): boolean {
	let first = line[0];
	return first === " " || first === "+" || first === "-" || first === "\\";
}

/**
 * Where the next file in a patch begins.
 *
 * A `---` line is also how a deletion looks, so the pair is what tells them
 * apart: the format itself is ambiguous line by line, and the counts that
 * would settle it are the thing being recomputed.
 */
function heading(lines: string[], index: number): boolean {
	return lines[index]?.startsWith("--- ") === true && lines[index + 1]?.startsWith("+++ ") === true;
}

/**
 * A patch as a renderer has to read it.
 *
 * Nobody writes a patch by hand correctly, and the thing that writes most of
 * the ones in a plan is a language model quoting a change it is proposing. Two
 * mistakes are near-universal and neither changes what the patch says:
 *
 * A hunk header's counts disagree with the lines under it. The counts are how
 * a parser knows where a hunk ends, so a count that is too small truncates the
 * hunk — silently, which is the one outcome worth going to any trouble to
 * avoid. They are recomputed here from the lines that are actually there.
 *
 * An unchanged blank line is written as an empty line rather than as a single
 * space, because every editor in the world strips trailing whitespace. Under
 * the format that is not a context line at all, it is the end of the hunk.
 *
 * Nothing else is touched, and the fence itself is never rewritten: this is
 * what gets handed to the renderer, not what gets saved. Anything still
 * malformed after this is refused by the parser and drawn as the text it is,
 * which is the right answer for a fragment that was never a patch.
 */
export function repaired(patch: string): string {
	let lines = patch.split("\n");
	let git = lines.some(line => line.startsWith("diff --git "));
	let out: string[] = [];
	/*
	 * Which of the lines written out are the patch's own rather than a file's.
	 * Kept because whether the filenames may be rewritten cannot be decided
	 * until every header has been seen, and a line inside a hunk that looks
	 * like a header is a line of somebody's SQL.
	 */
	let structure: number[] = [];

	for (let index = 0; index < lines.length; index++) {
		let line = lines[index]!;
		let hunk = HUNK.exec(line);

		if (!hunk) {
			structure.push(out.length);
			out.push(line);
			continue;
		}

		let [, before, , after, , context] = hunk;
		let deletions = 0;
		let additions = 0;
		let kept: string[] = [];

		while (index + 1 < lines.length) {
			let next = lines[index + 1]!;
			if (HUNK.test(next) || heading(lines, index + 1)) break;

			// A trailing empty string is the split of the final newline, not a
			// line of the patch, so it ends the hunk rather than joining it.
			if (next === "" && index + 2 >= lines.length) break;
			if (next !== "" && !body(next)) break;

			index += 1;
			let repaired = next === "" ? " " : next;
			kept.push(repaired);

			let first = repaired[0];
			if (first === "-") deletions += 1;
			else if (first === "+") additions += 1;
			else if (first === " ") {
				deletions += 1;
				additions += 1;
			}
		}

		out.push(`@@ -${before},${deletions} +${after},${additions} @@${context}`, ...kept);
	}

	let headers = structure
		.map(at => out[at]!)
		.filter(line => line.startsWith("--- ") || line.startsWith("+++ "));

	// Git's own form carries the filenames on the `diff --git` line, and the
	// renderer reads them from there, prefixes and all.
	if (!git && headers.length > 0 && headers.every(conventional)) {
		for (let at of structure) out[at] = named(out[at]!);
	}

	return out.join("\n");
}

/**
 * A header line that reads the way git writes one.
 *
 * All of them have to, before any of them is rewritten: deleting a line that
 * itself begins with `-- ` produces something indistinguishable from a header,
 * and a patch about a directory actually called `a` has to keep its name.
 * `/dev/null` counts, because that is the side an added or deleted file has.
 */
function conventional(line: string): boolean {
	return /^--- (a\/|\/dev\/null$)/.test(line) || /^\+\+\+ (b\/|\/dev\/null$)/.test(line);
}

/**
 * `--- a/x` and `+++ b/x` without the prefixes git puts there.
 *
 * The renderer strips them itself when the patch says `diff --git`, and does
 * not when it does not — so a plain unified diff would be drawn as a change to
 * a file called `b/…`.
 */
function named(line: string): string {
	if (line.startsWith("--- a/")) return `--- ${line.slice("--- a/".length)}`;
	if (line.startsWith("+++ b/")) return `+++ ${line.slice("+++ b/".length)}`;
	return line;
}
