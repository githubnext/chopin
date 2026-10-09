/**
 * Links: a small preview while the caret is on one, and an editor to add,
 * change, or remove one.
 *
 * Both surfaces sit outside the contenteditable. The editor's field has to
 * take focus, which costs Lexical its DOM selection, so the target is kept on
 * opening and put back on every way out. It is kept as collaborative
 * positions, not node keys and offsets, because someone else may type into
 * the same paragraph while the field is open.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isLinkNode, $toggleLink } from "@lexical/link";
import { createDOMRange } from "@lexical/selection";
import { LINK_PROTOCOLS } from "@chopin/dialect";
import {
	$findMatchingParent,
	$getNearestNodeFromDOMNode,
	$getNodeByKey,
	$getSelection,
	$isRangeSelection,
	$setSelection,
	BLUR_COMMAND,
	COMMAND_PRIORITY_LOW,
	createCommand,
	KEY_DOWN_COMMAND,
	SELECTION_CHANGE_COMMAND,
} from "lexical";

import { parseGitHubReference } from "@chopin/protocol/github-reference";

import { GitHubCard } from "../github-card";
import { useGitHubEntry } from "../github-hover";
import { useGitHubReferences } from "../github-references";
import { registerLinkGuard } from "./link-guard";
import { placeSurface } from "./placement";
import { $relativePosition, $resolveRange } from "./position";
import { editorSurfaceViewport, listenToEditorGeometry } from "./surface";
import { checkUrl } from "./url";

import type { LinkNode } from "@lexical/link";
import type { GitHubReference } from "@chopin/protocol/github-reference";
import type { GitHubReferenceStore } from "../widget-options";
import type { Binding } from "@lexical/yjs";
import type {
	BaseSelection,
	LexicalCommand,
	LexicalEditor,
	NodeKey,
	RangeSelection,
} from "lexical";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type { RelativePosition } from "yjs";
import type { DOMRectLike, SurfacePlacement } from "./placement";

/** Ask for the link editor over the current selection. */
export const OPEN_LINK_EDITOR_COMMAND: LexicalCommand<void> = createCommand("OPEN_LINK_EDITOR");

const RULES = { protocols: LINK_PROTOCOLS, relative: true };

const SURFACE = "fixed z-50 rounded-lg bg-page ring-hairline shadow-overlay";

const GONE = "Someone else changed this text. Select it again to add the link.";

/** The one link the selection sits wholly inside, if there is one. Call inside a read. */
export function $linkAt(selection: BaseSelection | null): LinkNode | undefined {
	if (!$isRangeSelection(selection)) return;
	let found: LinkNode | undefined;
	for (let node of selection.getNodes()) {
		let link = $isLinkNode(node) ? node : $findMatchingParent(node, $isLinkNode);
		if (!link || (found && !found.is(link))) return;
		found = link;
	}
	return found;
}

/** Point an existing link somewhere else, or unwrap it when `url` is null. */
export function $updateLink(key: NodeKey, url: string | null): void {
	let link = $getNodeByKey(key);
	if (!$isLinkNode(link)) return;
	if (url !== null) {
		link.setURL(url);
		return;
	}
	for (let child of link.getChildren()) link.insertBefore(child);
	link.remove();
}

/** The passage a link editor opened over, as positions that survive remote edits. */
type Target = { anchor: RelativePosition; focus: RelativePosition; text: string };

type Preview = { mode: "preview"; key: NodeKey; url: string };
type Editing = {
	mode: "edit";
	/** The existing link, which its key identifies through any edit around it. */
	key?: NodeKey;
	url: string;
	/** Where the selection was; only trusted when there is no binding to say better. */
	selection: RangeSelection;
	target?: Target;
};
type Open = Preview | Editing;

/** The kept selection as it stands now, or nothing if its text has gone. Call inside a read. */
function $selectionFor(state: Editing, binding: Binding | undefined): RangeSelection | undefined {
	if (state.target && binding) {
		let selection = $resolveRange(binding, state.target.anchor, state.target.focus);
		return selection?.getTextContent() === state.target.text ? selection : undefined;
	}
	let { anchor, focus } = state.selection;
	if (!$getNodeByKey(anchor.key)?.isAttached() || !$getNodeByKey(focus.key)?.isAttached()) return;
	return state.selection.clone();
}

function follow(editor: LexicalEditor, key: NodeKey, url: string): void {
	let href = editor.getElementByKey(key)?.closest("a")?.href ?? url;
	window.open(href, "_blank", "noopener,noreferrer");
}

export function LinkSurface(
	{ binding, disabled, onEditing }: {
		binding?: Binding;
		disabled?: boolean;
		onEditing?: (editing: boolean) => void;
	},
) {
	let [editor] = useLexicalComposerContext();
	let [open, setOpen] = useState<Open>();
	/** A link whose preview was dismissed stays quiet until the caret leaves it. */
	let dismissed = useRef<NodeKey>(undefined);
	let editing = open?.mode === "edit";

	useEffect(() => onEditing?.(editing), [editing, onEditing]);
	useEffect(() => registerLinkGuard(editor), [editor]);

	let edit = useCallback(() => {
		if (disabled) return false;
		let next = editor.getEditorState().read((): Editing | undefined => {
			let selection = $getSelection();
			if (!$isRangeSelection(selection)) return;
			let link = $linkAt(selection);
			if (selection.isCollapsed() && !link) return;
			let anchor = binding && $relativePosition(binding, selection.anchor);
			let focus = binding && $relativePosition(binding, selection.focus);
			return {
				mode: "edit",
				key: link?.getKey(),
				url: link?.getURL() ?? "",
				selection: selection.clone(),
				target: anchor && focus ? { anchor, focus, text: selection.getTextContent() } : undefined,
			};
		});
		if (!next) return false;
		setOpen(next);
		return true;
	}, [editor, binding, disabled]);

	let sync = useCallback(() => {
		if (disabled) return;
		let link = editor.getEditorState().read(() => {
			let selection = $getSelection();
			if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
			let node = $linkAt(selection);
			return node && { key: node.getKey(), url: node.getURL() };
		});
		if (link?.key !== dismissed.current) dismissed.current = undefined;
		setOpen(current => {
			if (current?.mode === "edit") return current;
			if (!link || link.key === dismissed.current) return undefined;
			if (current?.key === link.key && current.url === link.url) return current;
			return { mode: "preview", ...link };
		});
	}, [editor, disabled]);

	useEffect(() => {
		if (disabled) {
			setOpen(current => (current?.mode === "edit" ? undefined : current));
			return;
		}
		let stops = [
			editor.registerCommand(OPEN_LINK_EDITOR_COMMAND, edit, COMMAND_PRIORITY_LOW),
			editor.registerCommand(
				KEY_DOWN_COMMAND,
				(event: KeyboardEvent) => {
					if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return false;
					if (event.key.toLowerCase() === "k") {
						if (!edit()) return false;
						event.preventDefault();
						return true;
					}
					if (event.key !== "Enter") return false;
					// ⌘↵ follows the link under the caret: the keyboard's way to Open.
					let link = editor.getEditorState().read(() => {
						let selection = $getSelection();
						if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
						let node = $linkAt(selection);
						return node && { key: node.getKey(), url: node.getURL() };
					});
					if (!link) return false;
					event.preventDefault();
					follow(editor, link.key, link.url);
					return true;
				},
				COMMAND_PRIORITY_LOW,
			),
			editor.registerCommand(
				SELECTION_CHANGE_COMMAND,
				() => {
					sync();
					return false;
				},
				COMMAND_PRIORITY_LOW,
			),
			editor.registerCommand(
				BLUR_COMMAND,
				() => {
					setOpen(current => (current?.mode === "preview" ? undefined : current));
					return false;
				},
				COMMAND_PRIORITY_LOW,
			),
			editor.registerUpdateListener(sync),
		];
		return () => stops.forEach(stop => stop());
	}, [editor, disabled, edit, sync]);

	/*
	 * Clicks on links.
	 *
	 * Inside the contenteditable a plain click only places the caret, which is
	 * what brings up the preview. A read-only document has no caret, so the
	 * click opens the preview itself. A modified or middle click still follows
	 * the link at once, and a link this editor cannot resolve (one inside a
	 * nested editor) keeps the old behaviour of opening in a new tab.
	 */
	useEffect(() => {
		let click = (event: MouseEvent) => {
			if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
			if (!(event.target instanceof Element)) return;
			let anchor = event.target.closest<HTMLAnchorElement>("a[href]");
			if (!anchor || anchor.hasAttribute("download")) return;
			event.preventDefault();
			let selecting = editor.read(() => {
				let selection = $getSelection();
				return $isRangeSelection(selection) && !selection.isCollapsed();
			});
			if (selecting) return;
			let link = editor.read(() => {
				let node = $getNearestNodeFromDOMNode(anchor);
				let found = node && ($isLinkNode(node) ? node : $findMatchingParent(node, $isLinkNode));
				return found ? { key: found.getKey(), url: found.getURL() } : undefined;
			});
			if (event.button === 1 || event.metaKey || event.ctrlKey || !link) {
				event.stopPropagation();
				window.open(anchor.href, "_blank", "noopener,noreferrer");
				return;
			}
			dismissed.current = undefined;
			if (editor.isEditable()) sync();
			else setOpen({ mode: "preview", ...link });
		};
		let middle = (event: MouseEvent) => {
			if (event.button === 1) click(event);
		};
		return editor.registerRootListener((current, previous) => {
			previous?.removeEventListener("click", click);
			previous?.removeEventListener("mouseup", middle);
			current?.addEventListener("click", click);
			current?.addEventListener("mouseup", middle);
		});
	}, [editor, sync]);

	let close = useCallback(() => {
		setOpen(current => {
			if (current?.mode === "preview") dismissed.current = current.key;
			return undefined;
		});
	}, []);

	/**
	 * Put the target back, apply any change to it, and hand focus to the
	 * editor. Returns false, changing nothing, when the text a new link was
	 * meant for has gone: a link on whatever now sits there would be wrong.
	 */
	let finish = useCallback((state: Editing, url: string | null | undefined): boolean => {
		let applied = false;
		editor.update(() => {
			let selection = $selectionFor(state, binding);
			if (state.key) {
				let link = $getNodeByKey(state.key);
				if (!$isLinkNode(link) || !link.isAttached()) return;
				if (selection) $setSelection(selection);
				else link.selectEnd();
				if (url !== undefined) $updateLink(state.key, url);
				applied = true;
				return;
			}
			if (!selection) return;
			$setSelection(selection);
			if (url) $toggleLink(url);
			applied = true;
		}, { discrete: true });
		if (!applied && url !== undefined) return false;
		setOpen(undefined);
		editor.focus();
		return true;
	}, [editor, binding]);

	if (!open) return null;
	if (open.mode === "edit") {
		return (
			<LinkEditor
				key={open.key ?? "new"}
				binding={binding}
				editor={editor}
				state={open}
				onFinish={finish}
				onLeave={() => setOpen(undefined)}
			/>
		);
	}
	return (
		<LinkPreview
			editor={editor}
			preview={open}
			readOnly={!!disabled}
			onClose={close}
			onEdit={edit}
		/>
	);
}

function LinkEditor(
	{ binding, editor, onFinish, onLeave, state }: {
		binding?: Binding;
		editor: LexicalEditor;
		onFinish: (state: Editing, url: string | null | undefined) => boolean;
		/** Clicked or tabbed elsewhere: close without pulling focus back. */
		onLeave: () => void;
		state: Editing;
	},
) {
	let [value, setValue] = useState(state.url);
	let [problem, setProblem] = useState<string>();
	let [gone, setGone] = useState(false);
	let field = useRef<HTMLInputElement>(null);
	let ref = useRef<HTMLFormElement>(null);
	let problemId = useId();
	let existing = state.key !== undefined;

	/** The target's live DOM range, re-read so remote edits move it with the text. */
	let measure = useCallback((): Range | undefined => {
		if (state.key) {
			let element = editor.getElementByKey(state.key);
			let range = element?.ownerDocument.createRange();
			range?.selectNodeContents(element!);
			return range;
		}
		return editor.getEditorState().read(() => {
			let selection = $selectionFor(state, binding);
			if (!selection) return;
			return createDOMRange(
				editor,
				selection.anchor.getNode(),
				selection.anchor.offset,
				selection.focus.getNode(),
				selection.focus.offset,
			) ?? undefined;
		});
	}, [editor, binding, state]);

	let locate = useCallback(() => {
		let range = measure();
		return range && startOf(range.getClientRects(), range.getBoundingClientRect());
	}, [measure]);
	let position = usePlacement(editor, ref, locate);

	// The field takes the native selection, so mark the passage it will link.
	useEffect(() => {
		if (typeof Highlight === "undefined" || !CSS.highlights) return;
		let mark = () => {
			let range = measure();
			if (range) CSS.highlights.set("plan-link-target", new Highlight(range));
			else CSS.highlights.delete("plan-link-target");
		};
		mark();
		let stop = editor.registerUpdateListener(mark);
		return () => {
			stop();
			CSS.highlights.delete("plan-link-target");
		};
	}, [editor, measure]);

	// Only once placed: the first render is hidden while it measures, and a
	// hidden field refuses focus.
	let placed = position !== undefined;
	useLayoutEffect(() => {
		if (!placed) return;
		field.current?.focus({ preventScroll: true });
		field.current?.select();
	}, [placed]);

	useEffect(() => {
		let outside = (event: PointerEvent) => {
			if (event.target instanceof Node && !ref.current?.contains(event.target)) onLeave();
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [onLeave]);

	let submit = (event: FormEvent) => {
		event.preventDefault();
		if (gone) return onFinish(state, undefined);
		let checked = checkUrl(value, RULES);
		if (checked.problem !== undefined) {
			setProblem(checked.problem);
			field.current?.focus();
			return;
		}
		if (!onFinish(state, checked.url)) setGone(true);
	};

	let key = (event: ReactKeyboardEvent<HTMLFormElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onFinish(state, undefined);
			return;
		}
		// Tab cycles inside the popover rather than wandering off and leaving it open.
		if (event.key !== "Tab") return;
		let stops = [...event.currentTarget.querySelectorAll<HTMLElement>("input, button")]
			.filter(element => !(element as HTMLInputElement).disabled);
		let index = stops.indexOf(document.activeElement as HTMLElement);
		let next = stops[(index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length];
		event.preventDefault();
		next?.focus();
	};

	return (
		<form
			ref={ref}
			aria-label={existing ? "Edit link" : "Add link"}
			className={`${SURFACE} flex w-72 max-w-[calc(100vw-1rem)] flex-col gap-2 p-2`}
			data-focus-boundary=""
			noValidate
			onSubmit={submit}
			onKeyDown={key}
			style={position
				? { top: position.top, left: position.left }
				: { top: 0, left: 0, visibility: "hidden" }}
		>
			<input
				ref={field}
				aria-describedby={problem || gone ? problemId : undefined}
				aria-invalid={problem ? true : undefined}
				aria-label="Link URL"
				autoCapitalize="off"
				autoComplete="off"
				autoCorrect="off"
				className="field h-8 w-full min-w-0 px-2 text-sm"
				disabled={gone}
				enterKeyHint="done"
				inputMode="url"
				onChange={event => {
					setValue(event.target.value);
					setProblem(undefined);
				}}
				placeholder="Paste or type a link"
				spellCheck={false}
				type="text"
				value={value}
			/>
			{problem && (
				<p id={problemId} className="m-0 text-xs text-destructive-ink" role="alert">
					{problem}
				</p>
			)}
			{gone && (
				<p id={problemId} className="m-0 text-xs text-text-secondary" role="status">
					{GONE}
				</p>
			)}
			<div className="flex items-center justify-end gap-2">
				{existing && !gone && (
					<button
						className="btn btn-sm btn-ghost mr-auto"
						onClick={() => {
							if (!onFinish(state, null)) setGone(true);
						}}
						type="button"
					>
						Remove
					</button>
				)}
				{gone
					? (
						<button
							className="btn btn-sm btn-secondary"
							ref={button => button?.focus()}
							type="submit"
						>
							Close
						</button>
					)
					: (
						<button className="btn btn-sm btn-primary" type="submit">
							{existing ? "Save" : "Add link"}
						</button>
					)}
			</div>
		</form>
	);
}

function LinkPreview(
	{ editor, onClose, onEdit, preview, readOnly }: {
		editor: LexicalEditor;
		onClose: () => void;
		onEdit: () => void;
		preview: Preview;
		readOnly: boolean;
	},
) {
	let ref = useRef<HTMLDivElement>(null);
	let locate = useCallback(() => {
		let element = editor.getElementByKey(preview.key);
		return element ? startOf(element.getClientRects(), element.getBoundingClientRect()) : undefined;
	}, [editor, preview.key]);
	let position = usePlacement(editor, ref, locate);
	let store = useGitHubReferences();
	let reference = store ? parseGitHubReference(preview.url) : undefined;

	// Without a caret to move away, a read-only preview needs its own ways out.
	useEffect(() => {
		let escape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			onClose();
		};
		let outside = (event: PointerEvent) => {
			if (!(event.target instanceof Node)) return;
			if (ref.current?.contains(event.target)) return;
			if (editor.getElementByKey(preview.key)?.contains(event.target)) return;
			onClose();
		};
		window.addEventListener("keydown", escape, true);
		document.addEventListener("pointerdown", outside, true);
		return () => {
			window.removeEventListener("keydown", escape, true);
			document.removeEventListener("pointerdown", outside, true);
		};
	}, [editor, onClose, preview.key]);

	return (
		<div
			ref={ref}
			role="dialog"
			aria-label="Link"
			className={`${SURFACE} flex max-w-[min(24rem,calc(100vw-1rem))] flex-col`}
			contentEditable={false}
			data-focus-boundary=""
			// The caret is what keeps this open; the buttons must not take it.
			onMouseDown={event => event.preventDefault()}
			style={position
				? { top: position.top, left: position.left }
				: { top: 0, left: 0, visibility: "hidden" }}
		>
			{store && reference && (
				<PreviewGitHubCard reference={reference} store={store} url={preview.url} />
			)}
			<div className="flex items-center gap-1 p-1">
				<span className="min-w-0 truncate px-2 text-sm text-text-secondary" title={preview.url}>
					{preview.url}
				</span>
				<button
					className="btn btn-sm btn-ghost shrink-0"
					onClick={() => follow(editor, preview.key, preview.url)}
					title={readOnly ? "Open in a new tab" : "Open in a new tab (⌘↵)"}
					type="button"
				>
					Open
				</button>
				{!readOnly && (
					<button
						className="btn btn-sm btn-ghost shrink-0"
						onClick={onEdit}
						title="Edit link (⌘K)"
						type="button"
					>
						Edit
					</button>
				)}
			</div>
		</div>
	);
}

/** A GitHub reference's card above the link's own actions, so a pill opens one surface. */
function PreviewGitHubCard(
	{ reference, store, url }: {
		reference: GitHubReference;
		store: GitHubReferenceStore;
		url: string;
	},
) {
	let entry = useGitHubEntry(store, reference);
	return (
		<div className="gh-card-preview">
			<GitHubCard entry={entry} reference={reference} url={url} />
		</div>
	);
}

/**
 * The first line's left edge, over the whole passage's height.
 *
 * Both popovers start where the link starts, so a link that wraps does not
 * pull them to the middle of the column, and Edit opens where the preview was.
 */
function startOf(lines: DOMRectList, whole: DOMRect): DOMRectLike {
	let first = lines[0] ?? whole;
	return {
		top: whole.top,
		bottom: whole.bottom,
		height: whole.height,
		left: first.left,
		right: first.right,
		width: first.width,
	};
}

/** Keep a fixed surface under the live document, as the selection toolbar does. */
function usePlacement(
	editor: LexicalEditor,
	ref: RefObject<HTMLElement | null>,
	locate: () => DOMRectLike | undefined,
): SurfacePlacement | undefined {
	let [position, setPosition] = useState<SurfacePlacement>();

	let place = useCallback(() => {
		let element = ref.current;
		let anchor = locate();
		if (!element || !anchor) return;
		let width = element.offsetWidth;
		let next = placeSurface(
			{ ...anchor, right: anchor.left + width },
			{ width, height: element.offsetHeight },
			editorSurfaceViewport(editor),
		);
		setPosition(current =>
			current?.left === next.left && current.top === next.top ? current : next
		);
	}, [editor, ref, locate]);

	useLayoutEffect(place, [place]);
	useEffect(() => listenToEditorGeometry(editor, place), [editor, place]);
	// Other people's edits move the text without moving the page.
	useEffect(() => editor.registerUpdateListener(place), [editor, place]);

	return position;
}
