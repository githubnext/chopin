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

import { collaborationPlugin } from "./collaboration";
import { PlanPresence } from "./presence";
import { PlanStatus } from "./status";
import { register } from "./widgets";
import { widgetsPlugin } from "./widgets-plugin";

import type { Binding } from "@lexical/yjs";
import type { MDXEditorMethods } from "@mdxeditor/editor";
import type { Plan } from "@chopin/protocol";
import type { PlanProvider } from "./provider";
import type { QuestionnaireStore } from "./questionnaires";
import type { Connection, Transport } from "./transport";

/**
 * Lexical paints remote cursors with inline styles unless the theme names a
 * class for them, and inline styles cannot be restyled from a stylesheet. The
 * classes are how the cursors become ours rather than the library's.
 */
const THEME = {
	...lexicalTheme,
	collaboration: {
		cursor: "plan-cursor",
		cursorName: "plan-cursor-name",
		selection: "plan-cursor-selection",
		selectionBg: "plan-cursor-selection-bg",
	},
};

// Decorator nodes render through whatever the UI registered, so this has to
// happen before an editor mounts.
register();

export type PlanEditorProps = {
	wire: Transport | undefined;
	connection?: Connection;
	/** Identity for this client's remote cursor. */
	user: { name: string; color: string };
	/** Read-only while an agent turn may be rewriting the plan. */
	busy?: boolean;
	/**
	 * Where the plan's questionnaires are published.
	 *
	 * Owned by the host because the pane that answers them renders outside the
	 * editor, while the observer that finds them has to run inside it.
	 */
	questions?: QuestionnaireStore;
	className?: string;
};

export type PlanState = {
	/** True once the shared document has been received. */
	synced: boolean;
	/** Why the document was last replaced, if it was. */
	reset?: Plan.Reset["reason"];
};

export function PlanEditor(
	{ busy, className, connection, questions, user, wire }: PlanEditorProps,
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

	// A rotated epoch invalidates the whole local document, so the editor is
	// rebuilt rather than reconciled — that is what "reset" means.
	let onReset = useCallback((reason: Plan.Reset["reason"]) => {
		setState(prev => ({ ...prev, synced: false, reset: reason }));
		setGeneration(value => value + 1);
	}, []);

	// The store resolves anchors itself, because a Lexical key is per-editor:
	// the server's key for a block means nothing in this browser.
	let onBinding = useCallback((value: Binding | undefined) => {
		questions?.bind(value);
	}, [questions]);

	let onAnchors = useCallback((widgets: Plan.WidgetAnchors[]) => {
		questions?.anchors(widgets);
	}, [questions]);

	let onProvider = useCallback((value: PlanProvider | undefined) => {
		provider.current = value;
		setPresence(value);
		if (!value) return;
		value.on("sync", synced => setState(prev => ({ ...prev, synced })));
	}, []);

	let offline = connection !== undefined && connection !== "connected";
	let locked = offline || !!busy || !state.synced;

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
					collaborationPlugin({ wire, user, onReset, onProvider, onBinding, onAnchors }),
					widgetsPlugin({ questions }),
				]
				: [],
		[wire, user, onReset, onProvider, onBinding, onAnchors, questions],
	);

	useEffect(() => {
		if (previousWire.current !== wire) {
			previousWire.current = wire;
			setState({ synced: false });
			setGeneration(value => value + 1);
		}
		if (!wire) setState({ synced: false });
	}, [wire]);

	if (!wire) {
		return (
			<div
				className={`flex h-full flex-col items-center justify-center gap-2 text-muted-foreground ${
					className ?? ""
				}`}
			>
				<p className="m-0 text-sm">Not connected</p>
				<p className="m-0 text-xs">The plan appears once the room is reachable</p>
			</div>
		);
	}

	return (
		<div className={`plan flex h-full w-full flex-col ${className ?? ""}`}>
			{
				/* The grid's second column is the decisions sidecar, which is empty
			    until a questionnaire exists to put in it. */
			}
			<div className="plan-workspace">
				<div className="plan-document">
					<div ref={scroller} className="h-full min-h-0 overflow-auto">
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
					<PlanPresence provider={presence} />
					{/* In the document column, so it tracks the prose, not the pane. */}
					<PlanStatus wire={wire} connection={connection} synced={state.synced} busy={busy} />
				</div>
			</div>
		</div>
	);
}
