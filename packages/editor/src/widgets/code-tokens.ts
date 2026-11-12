/**
 * Fenced code as coloured tokens, for a surface that draws its own `<pre>`.
 *
 * The document's code view and Chat colour code with one highlighter: the
 * Shiki instance `@pierre/diffs` shares, loaded on demand from the same chunk,
 * with the same grammars. Chat cannot use the view itself (it paints in a
 * shadow root, with its own frame), so it asks for tokens and draws them.
 *
 * A token carries the role the theme gave it (`keyword`, `string`, `comment`)
 * rather than a colour: the theme here is Shiki's CSS variables theme, so a
 * token's colour names its role, and the surface maps each role to one of
 * Chopin's colour tokens in its own stylesheet.
 */

import { kindOf } from "./code";

import type { DiffsHighlighter } from "@pierre/diffs";

type Core = typeof import("@pierre/diffs");
type State = ReturnType<DiffsHighlighter["getLastGrammarState"]>;

/** What the highlighter calls text it has no grammar for. */
export const PLAIN = "text";

/** The roles Shiki's CSS variables theme names; a token in none of them is the foreground. */
const PREFIX = "--chopin-code-";
const THEME = "chopin-code-roles";
const ROLE = new RegExp(`^var\\(${PREFIX}token-([a-z-]+)`);

/** A line longer than this is drawn as it is: a minified bundle is not worth a frame. */
const LONGEST_LINE = 2000;

export type CodeToken = { text: string; role?: string };

/** The next lines of a block, and where the grammar stood after them. */
export type CodeLines = { lines: CodeToken[][]; state: State | undefined };

export type Tokenize = (code: string, after?: State) => CodeLines;

/**
 * Languages the highlighter turned out to have, and the ones it did not.
 *
 * Asked rather than assumed, because a fence may say anything and the answer
 * is not a list this package can hold: `resolveLanguage` rejects what it
 * cannot load, and the renderer's own attempt at an unknown grammar rejects a
 * promise nothing is watching — which leaves the block blank rather than
 * uncoloured. Asking first turns that into plain text.
 */
const known = new Map<string, string>();

export async function grammar(language: string, resolve: Core["resolveLanguage"]): Promise<string> {
	let seen = known.get(language);
	if (seen !== undefined) return seen;

	try {
		await resolve(language);
		known.set(language, language);
		return language;
	} catch {
		known.set(language, PLAIN);
		return PLAIN;
	}
}

let core: Promise<Core> | undefined;
const ready = new Map<string, Tokenize | undefined>();
const loading = new Map<string, Promise<Tokenize | undefined>>();

function role(color: string | undefined): string | undefined {
	return color ? ROLE.exec(color)?.[1] : undefined;
}

function tokenizer(highlighter: DiffsHighlighter, language: string): Tokenize {
	return (code, after) => {
		let result = highlighter.codeToTokens(code, {
			lang: language,
			theme: THEME,
			grammarState: after,
			tokenizeMaxLineLength: LONGEST_LINE,
		});
		return {
			lines: result.tokens.map(line =>
				line.map(token => ({ text: token.content, role: role(token.color) }))
			),
			state: result.grammarState,
		};
	};
}

/** Whether a fence names a language to colour: one nobody named, or named as plain text, is not. */
export function colourable(language: string): boolean {
	return kindOf(language) !== "plain";
}

/**
 * A block's lines so far: the whole lines already coloured, the text they came
 * from and where the grammar stood after them.
 */
export type Coloured = {
	tokenize: Tokenize;
	source: string;
	lines: CodeToken[][];
	state: State | undefined;
};

/**
 * Colours `code`, starting from what `held` already coloured when `code` goes on
 * from it, as a streamed block does: only the lines it gained are tokenized,
 * and the line still being written is tokenized again on its own. Any other
 * change starts over. Returns the lines to draw and what to hold for next time.
 */
export function colour(
	tokenize: Tokenize,
	code: string,
	held?: Coloured,
): { lines: CodeToken[][]; held: Coloured } {
	let start = held?.tokenize === tokenize && code.startsWith(held.source)
		? held
		: { tokenize, source: "", lines: [], state: undefined };
	let end = code.lastIndexOf("\n") + 1;
	let next = start;
	if (end > start.source.length) {
		// The whole lines it gained, without the empty line after their last break.
		let gained = tokenize(code.slice(start.source.length, end - 1), start.state);
		next = {
			tokenize,
			source: code.slice(0, end),
			lines: [...start.lines, ...gained.lines],
			state: gained.state,
		};
	}
	let rest = code.slice(next.source.length);
	let last = rest ? tokenize(rest, next.state).lines : [[]];
	return { lines: [...next.lines, ...last], held: next };
}

/** The tokenizer for a language already loaded, so a block drawn again colours in the same frame. */
export function loadedTokenizer(language: string): Tokenize | undefined {
	return ready.get(language);
}

/**
 * Loads the highlighter and the language's grammar, once each, and resolves to
 * its tokenizer, or to nothing for a language the highlighter does not know.
 */
export function loadTokenizer(language: string): Promise<Tokenize | undefined> {
	if (ready.has(language)) return Promise.resolve(ready.get(language));
	let pending = loading.get(language);
	if (pending) return pending;
	core ??= import("@pierre/diffs").then(diffs => {
		let theme = diffs.createCSSVariablesTheme({
			name: THEME,
			variablePrefix: PREFIX,
			fontStyle: false,
		});
		diffs.registerCustomTheme(THEME, () => Promise.resolve(theme));
		return diffs;
	});
	pending = core.then(async diffs => {
		let name = await grammar(language, diffs.resolveLanguage);
		let found = name === PLAIN
			? undefined
			: tokenizer(await diffs.getSharedHighlighter({ themes: [THEME], langs: [name] }), name);
		ready.set(language, found);
		return found;
	}).finally(() => loading.delete(language));
	loading.set(language, pending);
	return pending;
}
