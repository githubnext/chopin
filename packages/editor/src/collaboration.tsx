/**
 * Binds MDXEditor's root Lexical editor to the shared plan document.
 *
 * MDXEditor builds its own editor, so collaboration cannot be configured up
 * front. This reaches the built editor through the realm and binds it, which is
 * why the editor is mounted with `editorState={null}` and
 * `suppressSharedHistory` — otherwise it would seed initial content that then
 * fights the CRDT, and its history would compete with the Yjs undo manager.
 */

import { useEffect, useState } from "react";
import {
	addComposerChild$,
	contentEditableWrapperElement$,
	realmPlugin,
	rootEditor$,
} from "@mdxeditor/editor";
import { useCellValue } from "@mdxeditor/gurx";
import {
	$getAnchorAndFocusForUserState,
	createYjsBinding,
	initLocalState,
	setLocalStateFocus,
	syncCursorPositions,
	syncLexicalUpdateToYjs,
	syncYjsChangesToLexical,
} from "@lexical/yjs";
import { $getNodeByKey, BLUR_COMMAND, COMMAND_PRIORITY_EDITOR, FOCUS_COMMAND } from "lexical";
import * as Y from "yjs";

import { collapsed, enclosing } from "./collapse";
import { labels } from "./labels";
import { PlanProvider } from "./provider";

import type {
	BaseBinding,
	Binding,
	Provider,
	SyncCursorPositionsFn,
	UserState,
} from "@lexical/yjs";
import type { LexicalEditor } from "lexical";
import type { PlanProviderOptions } from "./provider";

export type CollaborationOptions = Omit<PlanProviderOptions, "doc"> & {
	/** Identity shown on this client's remote cursor. */
	user: { name: string; color: string };
	onProvider?: (provider: PlanProvider | undefined) => void;
	onBinding?: (binding: Binding | undefined) => void;
};

const DOC = "plan";

/**
 * The one way cursors get painted.
 *
 * Lexical repaints them itself after a remote edit, so both routes have to
 * agree: highlighted selections and the rect-overlay fallback produce
 * different DOM, and alternating between them strands whichever lost.
 */
/**
 * The binding `createYjsBinding` returns.
 *
 * `isBindingV1` performs exactly this check but is not part of the package's
 * public surface, so it is repeated rather than reached into.
 */
function v1(binding: BaseBinding): binding is Binding {
	return "collabNodeMap" in binding;
}

/**
 * Peers whose caret can actually be drawn.
 *
 * Someone editing inside a block whose source this reader has hidden resolves
 * to a zero-size rectangle, and the painter turns that into a position relative
 * to the frame rather than no position at all — so their labelled caret lands
 * at whatever point the plan happens to be scrolled to. Better to omit them
 * until the block is open again.
 */
function visible(binding: BaseBinding, provider: Provider): Map<number, UserState> {
	let states = provider.awareness.getStates();
	if (!v1(binding)) return states;

	let out = new Map<number, UserState>();

	binding.editor.getEditorState().read(() => {
		for (let [client, state] of states) {
			let { anchorKey } = $getAnchorAndFocusForUserState(binding, state);
			let node = anchorKey === null ? null : $getNodeByKey(anchorKey);
			let block = enclosing(node);
			if (block && collapsed(binding.editor, block)) continue;
			out.set(client, state);
		}
	});

	return out;
}

const cursors: SyncCursorPositionsFn = (binding, provider) =>
	syncCursorPositions(binding, provider, {
		selectionHighlight: true,
		getAwarenessStates: visible,
	});

function Collaboration(options: CollaborationOptions) {
	let editor = useCellValue(rootEditor$) as LexicalEditor | null;
	let frame = useCellValue(contentEditableWrapperElement$);
	let [collab, setCollab] = useState<{ binding: Binding; provider: PlanProvider }>();

	useEffect(() => {
		if (!editor) return;

		let doc = new Y.Doc();
		let provider = new PlanProvider({ ...options, doc });
		let binding = createYjsBinding({ editor, id: DOC, doc, docMap: new Map([[DOC, doc]]) });
		setCollab({ binding, provider });
		options.onProvider?.(provider);
		options.onBinding?.(binding);

		let stopLocal = editor.registerUpdateListener(
			({ dirtyElements, dirtyLeaves, editorState, normalizedNodes, prevEditorState, tags }) => {
				if (tags.has("skip-collab")) return;
				syncLexicalUpdateToYjs(
					binding,
					provider,
					prevEditorState,
					editorState,
					dirtyElements,
					dirtyLeaves,
					normalizedNodes,
					tags,
				);
			},
		);

		let observer = (events: unknown[], transaction: { origin: unknown }) => {
			if (transaction.origin !== binding) {
				syncYjsChangesToLexical(binding, provider, events as never, false, cursors);
			}
		};
		binding.root.getSharedType().observeDeep(observer);

		// Identity must be seeded through `initLocalState`, not field by field.
		// Lexical writes the caret into `anchorPos`/`focusPos` on an existing
		// local state and gives up if that shape is not already there, so
		// setting only name and colour publishes presence without a cursor.
		let root = editor.getRootElement();
		let name = options.user.name;
		let color = options.user.color;
		initLocalState(provider, name, color, root !== null && document.activeElement === root, {});

		let focus = editor.registerCommand(FOCUS_COMMAND, () => {
			setLocalStateFocus(provider, name, color, true, {});
			return false;
		}, COMMAND_PRIORITY_EDITOR);

		let blur = editor.registerCommand(BLUR_COMMAND, () => {
			setLocalStateFocus(provider, name, color, false, {});
			return false;
		}, COMMAND_PRIORITY_EDITOR);

		// Awareness cannot be published before the epoch is known, so the state
		// seeded above goes nowhere. Repeat it once the document arrives, or
		// peers would not see this cursor until the next renewal 15s later.
		let announce = (synced: boolean) => {
			if (synced) provider.awareness.setLocalState(provider.awareness.getLocalState());
		};
		provider.on("sync", announce);

		// Otherwise a closed tab leaves a ghost cursor until awareness times it
		// out, which takes half a minute.
		let leave = () => provider.awareness.setLocalState(null);
		addEventListener("beforeunload", leave);
		addEventListener("pagehide", leave);

		/*
		 * A failed open used to be invisible.
		 *
		 * `connect` resolves once the document has arrived and `sync` has been
		 * emitted; anything that threw on the way left the editor locked with
		 * the status chip saying "Loading" forever, and the rejection went
		 * nowhere. Saying so is not a fix for whatever threw, but it is the
		 * difference between a bug somebody can report and one they cannot.
		 */
		provider.connect().catch((err: unknown) => {
			console.error("[plan] could not open the document:", err);
			provider.fail(err instanceof Error ? err.message : "the plan could not be opened");
		});

		return () => {
			removeEventListener("beforeunload", leave);
			removeEventListener("pagehide", leave);
			provider.off("sync", announce);
			focus();
			blur();
			stopLocal();
			binding.root.getSharedType().unobserveDeep(observer);
			// Announce the departure while the transport is still up.
			leave();
			provider.disconnect();
			options.onProvider?.(undefined);
			options.onBinding?.(undefined);
			doc.destroy();
			setCollab(undefined);
		};
		// The editor identity is what matters; options are read at bind time.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor]);

	useEffect(() => {
		if (!collab || !frame) return;
		let { binding, provider } = collab;

		/*
		 * Cursors are absolutely positioned against their container's offset
		 * parent, so that parent has to scroll with the prose. The pane around
		 * it does not — it is the scroll viewport, and anchoring there would
		 * displace every caret by the scroll offset. The content wrapper grows
		 * with the document, which is what makes it the right frame.
		 */
		frame.classList.add("plan-frame");
		let container = document.createElement("div");
		frame.append(container);
		binding.cursorsContainer = container;

		let flash = labels(binding);
		let paint = () => {
			cursors(binding, provider);
			flash.sync();
		};

		provider.awareness.on("update", paint);
		// Peers already present when this mounts have nothing left to announce.
		paint();

		return () => {
			provider.awareness.off("update", paint);
			flash.dispose();
			binding.cursorsContainer = null;
			container.remove();
			frame.classList.remove("plan-frame");
		};
	}, [collab, frame]);

	return null;
}

/** Registers collaboration as a composer child of MDXEditor's root editor. */
export function collaborationPlugin(options: CollaborationOptions) {
	return realmPlugin<CollaborationOptions>({
		init(realm, params) {
			realm.pub(addComposerChild$, () => <Collaboration {...(params ?? options)} />);
		},
	})(options);
}
