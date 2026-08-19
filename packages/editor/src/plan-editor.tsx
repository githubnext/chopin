/**
 * The collaborative plan editor.
 *
 * Content is owned by the shared document, not by props: `markdown` is empty
 * and `editorState` null because the server supplies the initial state over
 * the provider. Passing source here would race the CRDT and duplicate it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lexicalTheme, markdownShortcutPlugin, MDXEditor } from "@mdxeditor/editor";

// Structural editor CSS, then our retheme over the top.
import "@mdxeditor/editor/style.css";
import "./styles.css";
import { plugins as dialectPlugins } from "@chopin/dialect";

import { ChangeStore } from "./changes";
import { PlanChanges } from "./changes-chip";
import { collaborationPlugin } from "./collaboration";
import { PlanStatus } from "./status";
import { register } from "./widgets";
import { widgetsPlugin } from "./widgets-plugin";

import type { Binding } from "@lexical/yjs";
import type { MDXEditorMethods } from "@mdxeditor/editor";
import type { Plan } from "@chopin/protocol";
import type { PlanProvider } from "./provider";
import type { QuestionnaireStore } from "./questionnaires";
import type { ThreadStore } from "./threads";
import type { Connection, Transport } from "./transport";
import type { CommentPresentation } from "./widget-options";

/**
 * Lexical paints remote cursors with inline styles unless the theme names a
 * class for them, and inline styles cannot be restyled from a stylesheet. The
 * classes are how the cursors become ours rather than the library's.
 *
 * The table entries are the same arrangement one step worse: `@lexical/table`
 * paints a selected cell by adding `theme.tableCellSelected` and nothing else,
 * so a theme that does not name one — MDXEditor's does not name any table class
 * at all — draws a cell selection that is completely invisible. Dragging across
 * cells then appears to do nothing while a `TableSelection` is very much live.
 */
const THEME = {
	...lexicalTheme,
	collaboration: {
		cursor: "plan-cursor",
		cursorName: "plan-cursor-name",
		selection: "plan-cursor-selection",
		selectionBg: "plan-cursor-selection-bg",
	},
	tableCellSelected: "plan-cell-selected",
	tableSelection: "plan-table-selecting",
};

// Decorator nodes render through whatever the UI registered, so this has to
// happen before an editor mounts.
register();

export type PlanEditorProps = {
	wire: Transport | undefined;
	connection?: Connection;
	/** How comment threads are presented by the surrounding workspace. */
	commentPresentation?: CommentPresentation;
	/** Identity for this client's remote cursor. */
	user: { name: string; color: string };
	/** Read-only while an agent turn may be rewriting the plan. */
	busy?: boolean;
	/** Read-only because this participant may view but not edit. */
	readOnly?: boolean;
	/**
	 * Where the plan's questionnaires are published.
	 *
	 * Owned by the host because the pane that answers them renders outside the
	 * editor, while the observer that finds them has to run inside it.
	 */
	questions?: QuestionnaireStore;
	/** The same arrangement for comment threads. */
	threads?: ThreadStore;
	/** Remembered by the document host while this surface is hidden. */
	scrollTop?: number;
	/** The document host owns persisted view position, not the editor. */
	onScrollTop?: (top: number) => void;
	className?: string;
};

export type PlanState = {
	/** True once the shared document has been received. */
	synced: boolean;
	/** Why the document was last replaced, if it was. */
	reset?: Plan.Reset["reason"];
	/** Why it could not be opened at all, if it could not. */
	failed?: string;
};

export function PlanEditor(
	{
		busy,
		className,
		commentPresentation = "popover",
		connection,
		onScrollTop,
		questions,
		readOnly,
		scrollTop,
		threads,
		user,
		wire,
	}: PlanEditorProps,
) {
	let ref = useRef<MDXEditorMethods>(null);
	let scroller = useRef<HTMLDivElement>(null);
	let [state, setState] = useState<PlanState>({ synced: false });
	let [generation, setGeneration] = useState(0);
	let provider = useRef<PlanProvider>(undefined);
	// Presence renders, so it needs the provider as state; edits need it
	// synchronously during an event, so they keep reading the ref.
	let [presence, setPresence] = useState<PlanProvider>();
	let previousWire = useRef(wire);
	// Nothing outside the editor reads this one, unlike the questionnaires,
	// so it is owned here rather than being handed down from the room.
	let [changes] = useState(() => new ChangeStore());

	// A rotated epoch invalidates the whole local document, so the editor is
	// rebuilt rather than reconciled — that is what "reset" means. The marks
	// describe a history that no longer exists, so they go with it.
	let onReset = useCallback((reason: Plan.Reset["reason"]) => {
		changes.clear();
		setState(prev => ({ ...prev, synced: false, reset: reason }));
		setGeneration(value => value + 1);
	}, [changes]);

	// The store resolves anchors itself, because a Lexical key is per-editor:
	// the server's key for a block means nothing in this browser.
	let onBinding = useCallback((value: Binding | undefined) => {
		questions?.bind(value);
		threads?.bind(value);
		changes.bind(value);
	}, [questions, threads, changes]);

	let onAnchors = useCallback(
		(snapshot: { widgets: Plan.WidgetAnchors[]; threads: Plan.ThreadAnchors[] }) => {
			questions?.anchors(snapshot.widgets);
			threads?.anchors(snapshot.threads);
		},
		[questions, threads],
	);

	let onChanges = useCallback((found: Plan.Change[]) => {
		changes.mark(found);
	}, [changes]);

	// The scroll container is what "in view" is measured against, and it only
	// exists once the editor has rendered.
	useEffect(() => {
		changes.viewport(scroller.current ?? undefined);
		let element = scroller.current;
		if (!element) return;
		let onScroll = () => {
			changes.onScroll();
			onScrollTop?.(element.scrollTop);
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		return () => element.removeEventListener("scroll", onScroll);
	}, [changes, generation, onScrollTop, wire]);

	useEffect(() => {
		let element = scroller.current;
		if (element && scrollTop !== undefined) element.scrollTop = scrollTop;
	}, [generation, scrollTop]);

	useEffect(() => () => changes.dispose(), [changes]);

	let onProvider = useCallback((value: PlanProvider | undefined) => {
		provider.current = value;
		setPresence(value);
		if (!value) return;
		value.on("sync", synced => setState(prev => ({ ...prev, synced })));
		value.on("status", ({ message, status }) => {
			// A failure is sticky until something opens the document; anything
			// else clears it, so a reconnect that works stops saying it failed.
			setState(prev => ({
				...prev,
				...(status === "failed" ? { failed: message ?? "the plan could not be opened" } : {}),
				...(status === "connected" ? { failed: undefined } : {}),
			}));
		});
	}, []);

	/*
	 * Open the document whenever the connection says it can carry the request.
	 *
	 * The provider is created when the editor mounts, and a socket comes up on
	 * its own schedule; nothing makes the two coincide. Opening only on mount
	 * meant a handshake that had not finished yet cost the plan entirely, and a
	 * reconnect went unnoticed — leaving the editor unlocked over a document
	 * quietly missing whatever arrived while it was away.
	 *
	 * Keyed on both, so it does not matter which turns up first, and so every
	 * later reconnection re-syncs.
	 */
	useEffect(() => {
		if (connection !== undefined && connection !== "connected") return;
		void presence?.resume();
	}, [presence, connection]);

	let offline = connection !== undefined && connection !== "connected";
	let locked = offline || !!busy || !!readOnly || !state.synced;

	// Empty without a connection, and never used: the editor is not rendered
	// at all until there is one, so there is nothing to configure.
	let plugins = useMemo(
		() =>
			wire
				? [
					...dialectPlugins({ core: false }),
					// After the dialect, not before. It chooses its transformers from
					// whichever plugins have registered by the time it initialises, so
					// running first would leave it with inline marks and no headings
					// or lists — quietly, with no error.
					markdownShortcutPlugin(),
					/*
					 * Before the widgets, deliberately.
					 *
					 * Plugin order decides the order composer children mount,
					 * which decides the order their update listeners register.
					 * Lexical runs those in one loop with no isolation — the
					 * first to throw skips every listener after it. Behind the
					 * widgets, a bug in any of them costs the author an edit in
					 * silence: the editor commits it, the CRDT never hears, and
					 * the loss only shows when the plan is reopened.
					 *
					 * This buys less than it appears to. MDXEditor's own core
					 * subscribes when the root editor is built, ahead of every
					 * composer child, so nothing here can get in front of it.
					 * Guarding that one is `markdownPlugin`'s job, in the
					 * dialect: keep its serialiser able to write every node, and
					 * it has no reason to throw.
					 */
					collaborationPlugin({
						wire,
						user,
						onReset,
						onProvider,
						onBinding,
						onAnchors,
						onChanges,
					}),
					widgetsPlugin({
						commentPresentation,
						questions,
						threads,
						changes,
						wire,
						connected: !offline,
					}),
				]
				: [],
		[
			wire,
			user,
			onReset,
			onProvider,
			onBinding,
			onAnchors,
			onChanges,
			questions,
			commentPresentation,
			threads,
			changes,
			offline,
		],
	);

	// Adjusting state during render, per React's guidance for state that must
	// reset when a prop changes: comparing against a ref here (rather than in
	// an Effect) avoids the extra render an Effect-driven reset would cause,
	// and it cannot be skipped by Strict Mode's double-invoked Effects.
	if (previousWire.current !== wire) {
		previousWire.current = wire;
		setState({ synced: false });
		setGeneration(value => value + 1);
	}

	if (!wire) {
		return (
			<div
				className={`flex h-full flex-col items-center justify-center gap-2 text-text-quaternary ${
					className ?? ""
				}`}
			>
				<p className="m-0 text-sm">Not connected</p>
				<p className="m-0 text-sm">The plan appears once the room is reachable</p>
			</div>
		);
	}

	return (
		<div className={`plan flex h-full w-full flex-col ${className ?? ""}`}>
			<div className="plan-workspace">
				<div className="plan-document">
					<div
						ref={scroller}
						className="h-full min-h-0 overflow-auto"
						data-plan-scroll=""
					>
						<MDXEditor
							// Remounting on epoch rotation is deliberate: the previous
							// document no longer exists, so there is nothing to reconcile.
							key={generation}
							ref={ref}
							markdown=""
							editorState={null}
							suppressSharedHistory
							readOnly={locked}
							plugins={plugins}
							lexicalTheme={THEME}
							contentEditableClassName="plan-content"
							placeholder="Start writing, or ask the agent to plan"
							spellCheck
							// The dialect has no raw HTML. Left on, MDXEditor registers
							// its HTML visitors and quietly admits `html` nodes.
							suppressHtmlProcessing
						/>
					</div>
					{/* In the document column, so they track the prose, not the pane. */}
					<PlanChanges store={changes} />
					<PlanStatus
						connection={connection}
						synced={state.synced}
						failed={state.failed}
						busy={busy}
					/>
				</div>
			</div>
		</div>
	);
}
