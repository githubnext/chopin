/**
 * Links: a small preview while the caret is on one, and an editor to add,
 * change, or remove one.
 *
 * Both surfaces sit outside the contenteditable. The editor's field has to
 * take focus, which costs Lexical its DOM selection, so the selection is kept
 * on opening and put back on every way out.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isLinkNode, $toggleLink } from "@lexical/link";
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

import { placeSurface } from "./placement";
import { editorSurfaceViewport, listenToEditorGeometry } from "./surface";
import { checkUrl } from "./url";

import type { LinkNode } from "@lexical/link";
import type { BaseSelection, LexicalCommand, LexicalEditor, NodeKey } from "lexical";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type { DOMRectLike, SurfacePlacement } from "./placement";

/** Ask for the link editor over the current selection. */
export const OPEN_LINK_EDITOR_COMMAND: LexicalCommand<void> = createCommand("OPEN_LINK_EDITOR");

const RULES = { protocols: LINK_PROTOCOLS, relative: true };

const SURFACE = "fixed z-50 rounded-lg bg-page ring-hairline shadow-overlay";

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

type Preview = { mode: "preview"; key: NodeKey; url: string };
type Editing = {
	mode: "edit";
	key?: NodeKey;
	url: string;
	selection: BaseSelection;
	/** A live DOM range over the passage, which keeps measuring true as the page scrolls. */
	range?: Range;
};
type Open = Preview | Editing;

export function LinkSurface(
	{ disabled, onEditing }: { disabled?: boolean; onEditing?: (editing: boolean) => void },
) {
	let [editor] = useLexicalComposerContext();
	let [open, setOpen] = useState<Open>();
	/** A link whose preview was dismissed stays quiet until the caret leaves it. */
	let dismissed = useRef<NodeKey>(undefined);
	let editing = open?.mode === "edit";

	useEffect(() => onEditing?.(editing), [editing, onEditing]);

	let edit = useCallback(() => {
		if (disabled) return false;
		let next = editor.getEditorState().read((): Editing | undefined => {
			let selection = $getSelection();
			if (!$isRangeSelection(selection)) return;
			let link = $linkAt(selection);
			if (selection.isCollapsed() && !link) return;
			return {
				mode: "edit",
				key: link?.getKey(),
				url: link?.getURL() ?? "",
				selection: selection.clone(),
				range: selection.isCollapsed() ? undefined : nativeRange(),
			};
		});
		if (!next) return false;
		setOpen(next);
		return true;
	}, [editor, disabled]);

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
					if (event.key.toLowerCase() !== "k" || event.shiftKey || event.altKey) return false;
					if (!(event.metaKey || event.ctrlKey) || !edit()) return false;
					event.preventDefault();
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
		let follow = (event: MouseEvent) => {
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
			if (event.button === 1) follow(event);
		};
		return editor.registerRootListener((current, previous) => {
			previous?.removeEventListener("click", follow);
			previous?.removeEventListener("mouseup", middle);
			current?.addEventListener("click", follow);
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
	 * Put the kept selection back, apply any change against it, and hand focus
	 * to the editor. One update, so the change cannot run before the selection
	 * it acts on has returned.
	 */
	let finish = useCallback((state: Editing, url: string | null | undefined) => {
		setOpen(undefined);
		editor.update(() => {
			$setSelection(state.selection.clone());
			if (url === undefined) return;
			if (state.key) $updateLink(state.key, url);
			else if (url !== null) $toggleLink(url);
		}, { onUpdate: () => editor.focus() });
	}, [editor]);

	if (!open) return null;
	if (open.mode === "edit") {
		return (
			<LinkEditor
				key={open.key ?? "new"}
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
	{ editor, onFinish, onLeave, state }: {
		editor: LexicalEditor;
		onFinish: (state: Editing, url: string | null | undefined) => void;
		/** Clicked elsewhere: close without pulling focus back from where it went. */
		onLeave: () => void;
		state: Editing;
	},
) {
	let [value, setValue] = useState(state.url);
	let [problem, setProblem] = useState<string>();
	let field = useRef<HTMLInputElement>(null);
	let ref = useRef<HTMLFormElement>(null);
	let problemId = useId();
	let existing = state.key !== undefined;

	let locate = useCallback(() => {
		if (state.range) return state.range.getBoundingClientRect();
		return state.key ? editor.getElementByKey(state.key)?.getBoundingClientRect() : undefined;
	}, [editor, state.key, state.range]);
	let position = usePlacement(editor, ref, locate, "centre");

	// The field takes the native selection, so mark the passage it will link.
	useEffect(() => {
		let element = state.key ? editor.getElementByKey(state.key) : undefined;
		let range = state.range ?? element?.ownerDocument.createRange();
		if (!range || typeof Highlight === "undefined" || !CSS.highlights) return;
		if (!state.range && element) range.selectNodeContents(element);
		CSS.highlights.set("plan-link-target", new Highlight(range));
		return () => void CSS.highlights.delete("plan-link-target");
	}, [editor, state.key, state.range]);

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
		let checked = checkUrl(value, RULES);
		if (checked.problem !== undefined) {
			setProblem(checked.problem);
			field.current?.focus();
			return;
		}
		onFinish(state, checked.url);
	};

	return (
		<form
			ref={ref}
			aria-label={existing ? "Edit link" : "Add link"}
			className={`${SURFACE} flex w-72 max-w-[calc(100vw-1rem)] flex-col gap-2 p-2`}
			data-focus-boundary=""
			noValidate
			onSubmit={submit}
			onKeyDown={(event: ReactKeyboardEvent) => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				onFinish(state, undefined);
			}}
			style={position
				? { top: position.top, left: position.left }
				: { top: 0, left: 0, visibility: "hidden" }}
		>
			<input
				ref={field}
				aria-describedby={problem ? problemId : undefined}
				aria-invalid={problem ? true : undefined}
				aria-label="Link URL"
				autoCapitalize="off"
				autoComplete="off"
				autoCorrect="off"
				className="field h-8 w-full min-w-0 px-2 text-sm"
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
			<div className="flex items-center justify-end gap-2">
				{existing && (
					<button
						className="btn btn-sm btn-ghost mr-auto"
						onClick={() => onFinish(state, null)}
						type="button"
					>
						Remove
					</button>
				)}
				<button className="btn btn-sm btn-primary" type="submit">
					{existing ? "Save" : "Add link"}
				</button>
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
	let locate = useCallback(
		() => editor.getElementByKey(preview.key)?.getBoundingClientRect(),
		[editor, preview.key],
	);
	let position = usePlacement(editor, ref, locate, "start");

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

	let follow = () => {
		let href = editor.getElementByKey(preview.key)?.closest("a")?.href ?? preview.url;
		window.open(href, "_blank", "noopener,noreferrer");
	};

	return (
		<div
			ref={ref}
			role="dialog"
			aria-label="Link"
			className={`${SURFACE} flex max-w-[min(24rem,calc(100vw-1rem))] items-center gap-1 p-1`}
			contentEditable={false}
			data-focus-boundary=""
			// The caret is what keeps this open; the buttons must not take it.
			onMouseDown={event => event.preventDefault()}
			style={position
				? { top: position.top, left: position.left }
				: { top: 0, left: 0, visibility: "hidden" }}
		>
			<span className="min-w-0 truncate px-2 text-sm text-text-secondary" title={preview.url}>
				{preview.url}
			</span>
			<button className="btn btn-sm btn-ghost shrink-0" onClick={follow} type="button">
				Open
			</button>
			{!readOnly && (
				<button className="btn btn-sm btn-ghost shrink-0" onClick={onEdit} type="button">
					Edit
				</button>
			)}
		</div>
	);
}

function nativeRange(): Range | undefined {
	let selection = window.getSelection();
	return selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
}

/** Keep a fixed surface under live document geometry, as the selection toolbar does. */
function usePlacement(
	editor: LexicalEditor,
	ref: RefObject<HTMLElement | null>,
	locate: () => DOMRectLike | undefined,
	align: "centre" | "start",
): SurfacePlacement | undefined {
	let [position, setPosition] = useState<SurfacePlacement>();

	let place = useCallback(() => {
		let element = ref.current;
		let anchor = locate();
		if (!element || !anchor) return;
		let width = element.offsetWidth;
		let left = align === "centre" ? anchor.left + anchor.width / 2 - width / 2 : anchor.left;
		let next = placeSurface(
			// Field by field: a DOMRect keeps its geometry on the prototype, out of reach of a spread.
			{
				top: anchor.top,
				bottom: anchor.bottom,
				height: anchor.height,
				width: anchor.width,
				left,
				right: left + width,
			},
			{ width, height: element.offsetHeight },
			editorSurfaceViewport(editor),
		);
		setPosition(current =>
			current?.left === next.left && current.top === next.top ? current : next
		);
	}, [editor, ref, locate, align]);

	useLayoutEffect(place, [place]);
	useEffect(() => listenToEditorGeometry(editor, place), [editor, place]);

	return position;
}
