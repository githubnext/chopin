/**
 * Rendering a fence as coloured code, and a patch as a diff.
 *
 * `@pierre/diffs` does both, over Shiki, and is used only to draw: the source
 * of every block on this page stays where it was, as Lexical text children
 * under Yjs, and what is drawn here is a second, read-only view of it. The
 * library has an edit mode and it must not be turned on — it would put a
 * character model of its own beside the one the room is collaborating in, and
 * the two would disagree the moment two people typed.
 *
 * It arrives on demand. Shiki's grammars and this library together are larger
 * than everything else the editor loads, and a plan with no code in it should
 * pay none of it.
 *
 * A diff fence is a unified patch or it is not a diff. The parser is asked to
 * throw rather than to salvage, because half a patch rendered as a diff is a
 * change nobody made: the hunk headers are what carry the filename and the
 * line numbers, and inventing them from a loose run of `+` and `-` lines would
 * put both in the reader's head with nothing behind them. What it refuses is
 * shown as coloured diff text instead, which is what it is.
 */

import { Component, useEffect, useMemo, useState } from "react";

import { fileNameOf, repaired, titled } from "./code";

import type { ErrorInfo, ReactNode } from "react";
import type { Kind } from "./code";

type Core = typeof import("@pierre/diffs");
type Views = typeof import("@pierre/diffs/react");

type Renderer = {
	File: Views["File"];
	FileDiff: Views["FileDiff"];
	parsePatchFiles: Core["parsePatchFiles"];
	resolveLanguage: Core["resolveLanguage"];
};

/** What the highlighter calls text it has no grammar for. */
const PLAIN = "text";

/**
 * One theme, named once.
 *
 * The page is light only — `theme.css` says so and carries no second palette —
 * so a `{ dark, light }` pair would load a second set of colours nothing can
 * ever ask for.
 */
const THEME = "pierre-light";

let loading: Promise<Renderer> | undefined;

function load(): Promise<Renderer> {
	loading ??= Promise.all([import("@pierre/diffs/react"), import("@pierre/diffs")]).then(
		([react, diffs]) => ({
			File: react.File,
			FileDiff: react.FileDiff,
			parsePatchFiles: diffs.parsePatchFiles,
			resolveLanguage: diffs.resolveLanguage,
		}),
	);
	return loading;
}

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

async function grammar(language: string, resolve: Core["resolveLanguage"]): Promise<string> {
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

/**
 * Keeps a failed preview from taking the editor with it.
 *
 * Everything below this point is third-party code rendering whatever a
 * collaborator or an agent wrote, inside the composer's own React tree — so a
 * throw during render would unmount the plan pane, not the block. The library
 * catches what happens inside its own renderer and paints a message; this is
 * for everything else.
 */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("[plan] could not render a code block:", error, info.componentStack);
	}

	override render(): ReactNode {
		if (this.state.failed) return <div data-plan-error="">could not be rendered</div>;
		return this.props.children;
	}
}

export type CodeViewProps = {
	kind: Extract<Kind, "code" | "diff">;
	/** The fence's contents, as the document holds them. */
	source: string;
	language: string;
	/** The rest of the info string, which is where a title lives. */
	meta: string;
};

export function CodeView(props: CodeViewProps) {
	return (
		<Boundary>
			<View {...props} />
		</Boundary>
	);
}

function View({ kind, source, language, meta }: CodeViewProps) {
	let [renderer, setRenderer] = useState<Renderer>();
	let [broken, setBroken] = useState(false);
	let [resolved, setResolved] = useState<string>();

	useEffect(() => {
		let live = true;
		load().then(
			value => {
				if (live) setRenderer(value);
			},
			error => {
				console.error("[plan] could not load the code renderer:", error);
				if (live) setBroken(true);
			},
		);
		return () => {
			live = false;
		};
	}, []);

	useEffect(() => {
		if (!renderer) return;
		let live = true;
		void grammar(language, renderer.resolveLanguage).then(value => {
			if (live) setResolved(value);
		});
		return () => {
			live = false;
		};
	}, [renderer, language]);

	/*
	 * Everything handed to the library is memoised, and not as a courtesy: it
	 * compares by reference to decide whether anything changed, so a fresh
	 * object on every keystroke elsewhere in the plan would re-render and
	 * re-highlight every block on the page.
	 */
	let file = useMemo(
		() => ({ name: fileNameOf(language, meta), contents: source, lang: resolved ?? PLAIN }),
		[language, meta, source, resolved],
	);

	let patch = useMemo(() => {
		if (kind !== "diff" || !renderer) return undefined;
		try {
			let read = renderer.parsePatchFiles(repaired(source), undefined, true);
			let files = read.flatMap(patch => patch.files);
			return files.length > 0 ? files : undefined;
		} catch {
			// Not a patch. Said by the parser rather than guessed at here,
			// which is the only reading of the format that cannot drift.
			return undefined;
		}
	}, [kind, renderer, source]);

	let options = useMemo(
		() => ({
			theme: THEME,
			themeType: "light" as const,
			// A snippet's identity is its language, and the control beside it
			// already says that. A snippet quoting a file has a second one.
			disableFileHeader: !titled(meta),
			disableLineNumbers: true,
			overflow: "scroll" as const,
			disableWorkerPool: true,
		}),
		[meta],
	);

	let diffOptions = useMemo(
		() => ({
			theme: THEME,
			themeType: "light" as const,
			// Three panes wide, so side by side would be two unreadable
			// columns. The filename comes from the patch and is the whole
			// point of rendering one, so its header stays.
			diffStyle: "unified" as const,
			/*
			 * A patch carries only what it changed, so there is nothing to
			 * expand into: the separator that offers to expand would be a
			 * control that cannot work. `metadata` says `@@ -60,6 +60,22 @@`,
			 * which is what the source says too.
			 */
			hunkSeparators: "metadata" as const,
			overflow: "scroll" as const,
			disableWorkerPool: true,
		}),
		[],
	);

	if (broken) return <div data-plan-error="">could not be rendered</div>;
	// Nothing yet. Drawing a box the height of the eventual render would move
	// the prose under it twice; the source is on screen throughout.
	if (!renderer) return null;

	let { File, FileDiff } = renderer;

	return (
		<div className="plan-code-view" contentEditable={false}>
			{patch
				? patch.map((fileDiff, index) => (
					<FileDiff
						// A patch names its files, but nothing stops it naming
						// one twice, so the position is what identifies them.
						key={index}
						fileDiff={fileDiff}
						options={diffOptions}
					/>
				))
				: <File file={file} options={options} />}
		</div>
	);
}
