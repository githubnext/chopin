/**
 * The handle beside a block, as Notion has it: ⋮⋮ appears beside the block under the pointer (and,
 * on a touch screen, beside blocks selected as blocks). Dragged, it moves the block, or every
 * selected block if it is one of them, to where a line shows it will land. Clicked, it selects the
 * block and opens its menu: Turn into, Duplicate and Delete. Mod+/ opens the same menu from the
 * keyboard, for the selected blocks or the block holding the caret.
 *
 * The handle and the line are drawn on `body`, outside the editor's clipped and scrolled content,
 * at the block's place on screen. Nothing is written into the document until a drop.
 *
 * A block keeps its level: a callout, columns, tabs or a card moves only among the document's own
 * blocks, so a drop inside a list or a callout puts it beside them instead. List items dropped
 * outside a list become a list of their own kind, and anything else dropped among list items goes
 * beside their list. There is no Copy link: blocks have no addresses of their own to link to.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createListNode, $isListItemNode, $isListNode } from "@lexical/list";
import { $isHeadingNode, $isQuoteNode } from "@lexical/rich-text";
import {
	$createParagraphNode,
	$createRangeSelection,
	$getNodeByKey,
	$getSelection,
	$isElementNode,
	$isParagraphNode,
	$isRangeSelection,
	$isRootNode,
	$setSelection,
	COMMAND_PRIORITY_CRITICAL,
	KEY_DOWN_COMMAND,
} from "lexical";
import { GripIcon } from "@chopin/icons";
import { $isCalloutNode, $isColumnNode, $isTabNode } from "@chopin/dialect";

import { usePopoverDismissal } from "../popover-dismissal";
import { useTransitionPresence } from "../transition-presence";
import { $block, convertBlock } from "../toolbar/bubble";
import { isApplePlatform, shortcut } from "../toolbar/shortcut";
import { $plainBlock } from "./block-keys";
import {
	$blockOf,
	$blocks,
	$duplicateBlocks,
	$held,
	$hold,
	$isBlock,
	$removeBlocks,
} from "./block-selection";

import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ListNode } from "@lexical/list";
import type { LexicalEditor, LexicalNode } from "lexical";
import type { Block } from "../toolbar/bubble";

/** Where a drop lands: before or after a block. */
export type Place = "before" | "after";

function $topLevel(node: LexicalNode): LexicalNode {
	let at = node;
	while (at.getParent() && !$isRootNode(at.getParent())) at = at.getParentOrThrow();
	return at;
}

/** Whether a block may sit anywhere a block can, not only among the document's own. */
function $goesAnywhere(block: LexicalNode): boolean {
	return $plainBlock(block) || $isListItemNode(block);
}

/**
 * Move blocks before or after another, keeping each at a level it may hold.
 *
 * @returns false when the drop would put a block inside itself.
 */
export function $dropBlocks(
	blocks: readonly LexicalNode[],
	target: LexicalNode,
	place: Place,
): boolean {
	if (blocks.some(block => block.is(target) || block.isParentOf(target))) return false;
	let items = blocks.every($isListItemNode);
	let at = target;
	if (!blocks.every($goesAnywhere)) at = $topLevel(at);
	else if ($isListItemNode(at) && !items) {
		// Beside the list, at the level the list itself sits.
		while ($isListNode(at.getParent()) || $isListItemNode(at.getParent())) {
			at = at.getParentOrThrow();
		}
	}
	if (blocks.some(block => block.is(at) || block.isParentOf(at))) return false;
	let parents = new Set(blocks.map(block => block.getParent()).filter(parent => parent !== null));
	let moving: LexicalNode[] = [...blocks];
	if (items && !$isListItemNode(at)) {
		let list = $createListNode((blocks[0]!.getParent() as ListNode).getListType());
		list.append(...blocks);
		moving = [list];
	}
	if (place === "before") { for (let block of moving) at.insertBefore(block); }
	else {
		let after = at;
		for (let block of moving) {
			after.insertAfter(block);
			after = block;
		}
	}
	for (let parent of parents) {
		if (!parent.isAttached() || parent.getChildrenSize() > 0) continue;
		if ($isListNode(parent)) {
			let wrapper = parent.getParent();
			parent.remove();
			if ($isListItemNode(wrapper) && wrapper.getChildrenSize() === 0) wrapper.remove();
		} else if ($isCalloutNode(parent) || $isColumnNode(parent) || $isTabNode(parent)) {
			parent.append($createParagraphNode());
		}
	}
	return true;
}

/** Shapes Turn into offers; a list item, a heading, a quote or text may take any of them. */
const TURN_INTO: ReadonlyArray<{ id: Block; label: string }> = [
	{ id: "paragraph", label: "Text" },
	{ id: "h1", label: "Heading 1" },
	{ id: "h2", label: "Heading 2" },
	{ id: "h3", label: "Heading 3" },
	{ id: "bullet", label: "Bulleted list" },
	{ id: "number", label: "Numbered list" },
	{ id: "quote", label: "Quote" },
];

function $turnable(block: LexicalNode): boolean {
	return $isParagraphNode(block) || $isHeadingNode(block) || $isQuoteNode(block)
		|| $isListItemNode(block);
}

type Hover = { key: string; top: number; left: number };
type Drop = { top: number; left: number; width: number };
type Item = { label: string; shortcut?: string; disabled?: boolean; run: () => void };
type Group = { label?: string; items: Item[] };

const HANDLE = 20;
const GAP = 4;

/** Where the handle sits for a block: to the left of its first line, past a list's marker. */
function handleAt(editor: LexicalEditor, key: string, list: boolean): Hover | undefined {
	let element = editor.getElementByKey(key);
	if (!element) return undefined;
	let rect = element.getBoundingClientRect();
	if (rect.height === 0) return undefined;
	let style = getComputedStyle(element);
	let line = Number.parseFloat(style.lineHeight) || 24;
	let pad = Number.parseFloat(style.paddingTop) || 0;
	let first = Math.min(rect.height, line + pad);
	return {
		key,
		top: rect.top + Math.max(0, first - HANDLE) / 2 + (first > line ? pad / 2 : 0),
		left: rect.left - HANDLE - GAP - (list ? 20 : 0),
	};
}

export function BlockHandlePlugin() {
	let [editor] = useLexicalComposerContext();
	let [editable, setEditable] = useState(() => editor.isEditable());
	let [hover, setHover] = useState<Hover>();
	let [drop, setDrop] = useState<Drop>();
	let [menu, setMenu] = useState<{ top: number; left: number; groups: Group[] }>();
	let [active, setActive] = useState(0);
	// Kept while the menu fades out, as every dropdown here does.
	let presence = useTransitionPresence(menu, 150, false);
	let shown = presence.value;
	let handle = useRef<HTMLButtonElement>(null);
	let panel = useRef<HTMLDivElement>(null);
	let hovered = useRef<string>(undefined);
	let dragging = useRef(false);

	useEffect(() => editor.registerEditableListener(setEditable), [editor]);

	useEffect(() => {
		if (editable) void import("./block-selection.css");
	}, [editable]);

	let place = useCallback((key: string | undefined) => {
		hovered.current = key;
		if (!key) return setHover(undefined);
		let list = editor.read(() => $isListItemNode($getNodeByKey(key)));
		setHover(handleAt(editor, key, list));
	}, [editor]);

	// The block under the pointer, kept while the pointer crosses the gutter to its handle.
	useEffect(() => {
		if (!editable) return;
		let frame = 0;
		let last: PointerEvent | undefined;
		let track = () => {
			frame = 0;
			let event = last;
			let root = editor.getRootElement();
			if (!event || !root || dragging.current || menu) return;
			if (event.target instanceof Node && handle.current?.contains(event.target)) return;
			let bounds = root.getBoundingClientRect();
			let x = event.clientX;
			let y = event.clientY;
			if (x < bounds.left - 72 || x > bounds.right || y < bounds.top || y > bounds.bottom) {
				return place(undefined);
			}
			// The innermost block level with the pointer: later blocks in document order are deeper.
			let key = editor.read(() => {
				let found: string | undefined;
				for (let block of $blocks()) {
					let rect = editor.getElementByKey(block.getKey())?.getBoundingClientRect();
					if (rect && rect.height > 0 && y >= rect.top && y <= rect.bottom) found = block.getKey();
				}
				return found;
			});
			place(key);
		};
		let move = (event: PointerEvent) => {
			if (event.pointerType !== "mouse") return;
			last = event;
			frame ||= requestAnimationFrame(track);
		};
		let reposition = () => hovered.current && place(hovered.current);
		document.addEventListener("pointermove", move, { passive: true });
		window.addEventListener("scroll", reposition, true);
		window.addEventListener("resize", reposition);
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("pointermove", move);
			window.removeEventListener("scroll", reposition, true);
			window.removeEventListener("resize", reposition);
		};
	}, [editor, editable, menu, place]);

	// On a touch screen there is no hover: the handle stands beside blocks selected as blocks.
	useEffect(() => {
		if (!editable || !matchMedia("(pointer: coarse)").matches) return;
		return editor.registerUpdateListener(({ editorState }) => {
			if (dragging.current) return;
			let key = editorState.read(() => $held(editor)?.blocks[0]?.getKey(), { editor });
			place(key);
		});
	}, [editor, editable, place]);

	let openMenu = useCallback((at: { top: number; left: number }) => {
		let groups = editor.read((): Group[] | undefined => {
			let found = $held(editor);
			if (!found) return undefined;
			let keys = found.blocks.map(block => block.getKey());
			let blocks = () => keys.map(key => $getNodeByKey(key)).filter(node => node !== null);
			let turnable = found.blocks.every($turnable);
			let head = found.blocks[0]!;
			let current = turnable && $isElementNode(head)
				? $block(head.getFirstDescendant() ?? head)
				: undefined;
			let back = () => {
				setMenu(undefined);
				editor.focus();
			};
			let turn = (next: Block) => () => {
				back();
				editor.update(() => {
					let all = blocks();
					let first = all[0];
					let last = all.at(-1);
					if (!$isElementNode(first) || !$isElementNode(last)) return;
					let selection = $createRangeSelection();
					selection.anchor.set(first.getKey(), 0, "element");
					selection.focus.set(last.getKey(), last.getChildrenSize(), "element");
					$setSelection(selection);
				}, { discrete: true });
				convertBlock(editor, current!, next);
			};
			let groups: Group[] = [];
			if (turnable) {
				groups.push({
					label: "Turn into",
					items: TURN_INTO.map(({ id, label }) => ({
						label,
						disabled: id === current,
						run: turn(id),
					})),
				});
			}
			groups.push({
				items: [
					{
						label: "Duplicate",
						shortcut: shortcut("D"),
						disabled: !found.blocks.some($plainBlock),
						run: () => {
							back();
							editor.update(() => {
								let copies = $duplicateBlocks(blocks());
								if (copies.length) $hold(editor, copies[0]!, copies.at(-1)!);
							});
						},
					},
					{
						label: "Delete",
						shortcut: "Del",
						run: () => {
							back();
							editor.update(() => void $removeBlocks(blocks()));
						},
					},
				],
			});
			return groups;
		});
		if (!groups) return;
		setActive(groups.flatMap(group => group.items).findIndex(item => !item.disabled));
		setMenu({ ...at, groups });
	}, [editor]);

	// Mod+/ opens the menu for the selected blocks, or for the block holding the caret.
	useEffect(() => {
		if (!editable) return;
		let apple = isApplePlatform();
		return editor.registerCommand(
			KEY_DOWN_COMMAND,
			event => {
				let mod = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
				if (!mod || event.shiftKey || event.altKey || event.key !== "/") return false;
				let found = $held(editor);
				if (!found) {
					let selection = $getSelection();
					let block = $isRangeSelection(selection)
						? $blockOf(selection.anchor.getNode())
						: undefined;
					if (!block) return false;
					$hold(editor, block, block);
					found = $held(editor);
				}
				let key = found?.blocks[0]?.getKey();
				if (!key) return false;
				event.preventDefault();
				let list = $isListItemNode(found!.blocks[0]!);
				queueMicrotask(() => {
					let at = handleAt(editor, key, list);
					if (at) openMenu({ top: at.top + HANDLE + GAP, left: at.left });
				});
				return true;
			},
			COMMAND_PRIORITY_CRITICAL,
		);
	}, [editor, editable, openMenu]);

	usePopoverDismissal(
		!!menu,
		target => panel.current?.contains(target) || handle.current?.contains(target),
		() => {
			setMenu(undefined);
			editor.focus();
		},
	);

	useLayoutEffect(() => {
		if (menu) panel.current?.focus({ preventScroll: true });
	}, [menu]);

	/** A press on the handle: a drag past a few pixels moves blocks; otherwise it is a click. */
	let press = (event: React.PointerEvent<HTMLButtonElement>) => {
		if (event.button !== 0 || !hover) return;
		event.preventDefault();
		let key = hover.key;
		let start = { x: event.clientX, y: event.clientY };
		let button = event.currentTarget;
		button.setPointerCapture(event.pointerId);
		let moving: string[] | undefined;
		let target: { key: string; place: Place } | undefined;

		let onMove = (move: PointerEvent) => {
			if (!moving) {
				if (Math.hypot(move.clientX - start.x, move.clientY - start.y) < 4) return;
				dragging.current = true;
				editor.update(() => {
					let found = $held(editor);
					let node = $getNodeByKey(key);
					if (!node) return;
					if (!found?.blocks.some(block => block.is(node) || block.isParentOf(node))) {
						$hold(editor, node, node);
						found = $held(editor);
					}
					moving = found?.blocks.map(block => block.getKey()) ?? [key];
				}, { discrete: true });
				moving ??= [key];
			}
			let y = move.clientY;
			let found = editor.read(() => {
				let dragged = moving!.map(k => $getNodeByKey(k)).filter(node => node !== null);
				let best: { node: LexicalNode; rect: DOMRect; distance: number } | undefined;
				for (let node of $blocks()) {
					if (dragged.some(d => d.is(node) || d.isParentOf(node))) continue;
					let rect = editor.getElementByKey(node.getKey())?.getBoundingClientRect();
					if (!rect || rect.height === 0) continue;
					let distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
					// The innermost block under the pointer: later blocks in document order are deeper.
					if (!best || distance <= best.distance) best = { node, rect, distance };
				}
				return best;
			});
			if (!found) {
				target = undefined;
				setDrop(undefined);
				return;
			}
			let { rect } = found;
			let where: Place = y < rect.top + rect.height / 2 ? "before" : "after";
			target = { key: found.node.getKey(), place: where };
			setDrop({
				top: where === "before" ? rect.top - 3 : rect.bottom + 1,
				left: rect.left,
				width: rect.width,
			});
		};
		let onUp = () => {
			button.removeEventListener("pointermove", onMove);
			button.removeEventListener("pointerup", onUp);
			button.removeEventListener("pointercancel", onCancel);
			dragging.current = false;
			setDrop(undefined);
			if (!moving) {
				editor.update(() => {
					let node = $getNodeByKey(key);
					if (node && $isBlock(node)) $hold(editor, node, node);
				}, { discrete: true });
				let rect = button.getBoundingClientRect();
				openMenu({ top: rect.bottom + GAP, left: rect.left });
				return;
			}
			let dropped = target;
			let keys = moving;
			if (!dropped) return;
			editor.update(() => {
				let blocks = keys.map(k => $getNodeByKey(k)).filter(node => node !== null);
				let at = $getNodeByKey(dropped.key);
				if (!at || blocks.length === 0) return;
				if ($dropBlocks(blocks, at, dropped.place)) {
					let first = $getNodeByKey(keys[0]!);
					let last = $getNodeByKey(keys.at(-1)!);
					if (first && last) $hold(editor, first, last);
				}
			});
			editor.focus();
		};
		let onCancel = () => {
			moving = undefined;
			target = undefined;
			onUp();
		};
		button.addEventListener("pointermove", onMove);
		button.addEventListener("pointerup", onUp);
		button.addEventListener("pointercancel", onCancel);
	};

	let items = shown?.groups.flatMap(group => group.items) ?? [];
	let onMenuKey = (event: ReactKeyboardEvent) => {
		let step = (from: number, by: number) => {
			for (let at = from + by; at >= 0 && at < items.length; at += by) {
				if (!items[at]!.disabled) return at;
			}
			return from;
		};
		let actions: Record<string, () => void> = {
			ArrowDown: () => setActive(at => step(at, 1)),
			ArrowUp: () => setActive(at => step(at, -1)),
			Home: () => setActive(step(-1, 1)),
			End: () => setActive(step(items.length, -1)),
			Enter: () => items[active]?.run(),
			" ": () => items[active]?.run(),
		};
		let action = actions[event.key];
		if (event.key === "Tab") {
			event.preventDefault();
			setMenu(undefined);
			editor.focus();
			return;
		}
		if (!action) return;
		event.preventDefault();
		event.stopPropagation();
		action();
	};

	if (!editable) return null;
	let style: CSSProperties | undefined = hover ? { top: hover.top, left: hover.left } : undefined;
	let index = -1;
	return createPortal(
		<>
			{hover && (
				<button
					aria-expanded={!!menu}
					aria-haspopup="menu"
					aria-label="Block options"
					className="plan-block-handle"
					data-block-handle=""
					onPointerDown={press}
					// The click is the pointer's; Enter and Space reach the menu through Mod+/.
					onClick={event => event.preventDefault()}
					ref={handle}
					style={style}
					tabIndex={-1}
					title="Drag to move, click for options"
					type="button"
				>
					<GripIcon size={16} />
				</button>
			)}
			{drop && (
				<div
					aria-hidden="true"
					className="plan-block-drop"
					data-block-drop=""
					style={{ top: drop.top, left: drop.left, width: drop.width }}
				/>
			)}
			{shown && (
				<div
					aria-label="Block"
					className={presence.className === "is-open"
						? "plan-block-menu motion-dropdown is-open fixed z-50 min-w-52 menu-surface"
						: presence.className === "is-closing"
						? "plan-block-menu motion-dropdown is-closing fixed z-50 min-w-52 menu-surface"
						: "plan-block-menu motion-dropdown fixed z-50 min-w-52 menu-surface"}
					onKeyDown={onMenuKey}
					ref={panel}
					role="menu"
					style={{ top: shown.top, left: Math.max(8, shown.left), transformOrigin: "top left" }}
					tabIndex={-1}
				>
					{shown.groups.map((group, at) => (
						<div
							aria-label={group.label}
							className="plan-block-menu-group"
							key={at}
							role="group"
						>
							{group.label && (
								<div aria-hidden="true" className="plan-block-menu-label">{group.label}</div>
							)}
							{group.items.map(item => {
								index++;
								let mine = index;
								return (
									<div
										aria-disabled={item.disabled || undefined}
										className="menu-item cursor-pointer"
										data-active={mine === active || undefined}
										key={item.label}
										onClick={() => !item.disabled && item.run()}
										onPointerMove={() => !item.disabled && setActive(mine)}
										role="menuitem"
									>
										<span className="min-w-0 flex-1 truncate">{item.label}</span>
										{item.shortcut && (
											<span className="plan-block-menu-shortcut">{item.shortcut}</span>
										)}
									</div>
								);
							})}
						</div>
					))}
				</div>
			)}
		</>,
		document.body,
	);
}
