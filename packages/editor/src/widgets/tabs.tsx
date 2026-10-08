/**
 * Tab strips.
 *
 * Tab panels are ordinary element nodes in the document, so their content
 * collaborates like any other block. Only *visibility* is local: switching tabs
 * must not edit the document or move other people, so the strip is rendered
 * alongside the panels and toggles their DOM, leaving the model untouched.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { CloseIcon, PlusIcon } from "@chopin/icons";
import { readOnly$ } from "@mdxeditor/editor";
import { useCellValue } from "@mdxeditor/gurx";
import {
	$createParagraphNode,
	$getNodeByKey,
	$getRoot,
	$isElementNode,
	$isParagraphNode,
} from "lexical";
import { $createTabNode, $isTabNode, $isTabsNode, limits, ulid } from "@chopin/dialect";

import { newTabLabel, stripKey, successor, tabLabel } from "./tab-authoring";
import { edgeMask, revealDelta, scrollEdges } from "./tab-edges";

import type { ElementNode, LexicalEditor } from "lexical";

type Group = {
	id: string;
	key: string;
	/** `empty` tabs hold nothing but empty paragraphs, so removing one loses nothing. */
	tabs: Array<{ id: string; key: string; label: string; empty: boolean }>;
};

/** Reveal a tab without moving any scroll ancestor outside its own strip. */
function revealInline(strip: HTMLElement, tab: HTMLElement): void {
	// Keep the tab clear of the edge fades (8 spacing units); the browser clamps at the ends.
	let fade = parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.25 * 8;
	strip.scrollLeft += revealDelta(
		strip.getBoundingClientRect(),
		tab.getBoundingClientRect(),
		fade,
	);
}

/** The chosen tab while it exists; otherwise, as when a collaborator removed it, the first. */
function shown(group: Group, chosen: string | undefined): string | undefined {
	return group.tabs.some(tab => tab.key === chosen) ? chosen : group.tabs[0]?.key;
}

/** Read the tab structure out of the document. */
function collect(editor: LexicalEditor): Group[] {
	let groups: Group[] = [];

	editor.getEditorState().read(() => {
		let walk = (node: ElementNode) => {
			for (let child of node.getChildren()) {
				if ($isTabsNode(child)) {
					groups.push({
						id: child.getId(),
						key: child.getKey(),
						tabs: child.getChildren().filter($isTabNode).map(tab => ({
							id: tab.getId(),
							key: tab.getKey(),
							label: tab.getLabel(),
							empty: tab.getChildren().every(
								block => $isParagraphNode(block) && block.isEmpty(),
							),
						})),
					});
				}
				if ($isElementNode(child)) walk(child);
			}
		};
		walk($getRoot());
	});

	return groups;
}

/** How long a touch holds a tab before it offers removal. */
const LONG_PRESS = 500;

/** Keys a focused tab answers itself, so Lexical never acts on them against the document. */
const STRIP_KEYS = new Set([
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"Enter",
	"F2",
	"Delete",
	" ",
]);

/**
 * Events Lexical listens for on its root. The rename field sits inside the
 * editable root, so without this its typing, undo and paste would also reach
 * the document's selection.
 */
const FIELD_EVENTS = [
	"keydown",
	"beforeinput",
	"input",
	"compositionstart",
	"compositionend",
	"paste",
	"cut",
	"copy",
	"drop",
	"dragstart",
] as const;

function RenameField(
	{ label, onDone }: {
		label: string;
		onDone: (label: string | undefined) => void;
	},
) {
	let field = useRef<HTMLInputElement>(null);
	let [value, setValue] = useState(label);
	let finished = useRef(false);
	let actions = useRef({ onDone });
	actions.current = { onDone };

	useLayoutEffect(() => {
		let input = field.current;
		if (!input) return;
		input.focus();
		input.select();

		let finish = (next: string | undefined) => {
			if (finished.current) return;
			finished.current = true;
			actions.current.onDone(next);
		};
		let stop = (event: Event) => {
			event.stopPropagation();
			if (event.type === "input") setValue(input.value);
			if (!(event instanceof KeyboardEvent) || event.isComposing) return;
			if (event.key === "Enter") finish(tabLabel(input.value));
			else if (event.key === "Escape") finish(undefined);
			else return;
			event.preventDefault();
		};
		let blur = () => finish(tabLabel(input.value));
		for (let name of FIELD_EVENTS) input.addEventListener(name, stop);
		input.addEventListener("blur", blur);
		return () => {
			for (let name of FIELD_EVENTS) input.removeEventListener(name, stop);
			input.removeEventListener("blur", blur);
		};
	}, []);

	return (
		<span className="plan-tab-rename text-sm font-medium">
			<span aria-hidden="true">{value || label}</span>
			<input
				ref={field}
				aria-label="Tab name"
				className="field"
				defaultValue={label}
				maxLength={limits.MAX_TAB_LABEL}
				// The hidden copy sets the width; one column keeps the input from adding its own.
				size={1}
				spellCheck={false}
			/>
		</span>
	);
}

function Strip(
	{ group, active, editable, onSelect }: {
		group: Group;
		active: string;
		editable: boolean;
		onSelect: (key: string) => void;
	},
) {
	let [editor] = useLexicalComposerContext();
	let chrome = useRef<HTMLDivElement>(null);
	let strip = useRef<HTMLDivElement>(null);
	let buttons = useRef<Array<HTMLButtonElement | null>>([]);
	let [mask, setMask] = useState<string | undefined>();
	let [renaming, setRenaming] = useState<string | undefined>();
	/** A tab with content asks once before it goes: there is no undo for it yet. */
	let [armed, setArmed] = useState<string | undefined>();
	let pointer = useRef("mouse");
	let press = useRef<ReturnType<typeof setTimeout>>(undefined);
	let pressed = useRef(false);
	let release = () => {
		clearTimeout(press.current);
		press.current = undefined;
	};
	let activeIndex = group.tabs.findIndex(tab => tab.key === active);
	let structure = group.tabs.map(tab => tab.key).join(" ");
	let canRemove = editable && group.tabs.length > 1;

	let focusTab = (key: string) => {
		requestAnimationFrame(() => {
			strip.current?.querySelector<HTMLElement>(`[aria-controls="ace-panel-${key}"]`)?.focus();
		});
	};

	let rename = (key: string, label: string | undefined) => {
		setRenaming(undefined);
		if (label !== undefined) {
			editor.update(() => {
				let node = $getNodeByKey(key);
				if ($isTabNode(node) && node.getLabel() !== label) node.setLabel(label);
			});
		}
		focusTab(key);
	};

	let remove = (index: number) => {
		let tab = group.tabs[index];
		if (!tab || !canRemove) return;
		if (!tab.empty && armed !== tab.key) {
			setArmed(tab.key);
			return;
		}
		setArmed(undefined);
		let rest = group.tabs.filter(other => other.key !== tab.key);
		let next = tab.key === active ? rest[successor(group.tabs.length, index)] : rest.find(
			other => other.key === active,
		);
		setRenaming(undefined);
		editor.update(() => {
			let node = $getNodeByKey(tab.key);
			if ($isTabNode(node) && (node.getParent()?.getChildrenSize() ?? 0) > 1) node.remove();
		});
		if (next) {
			onSelect(next.key);
			focusTab(next.key);
		}
	};

	let add = () => {
		let key: string | undefined;
		editor.update(() => {
			let node = $getNodeByKey(group.key);
			if (!$isTabsNode(node)) return;
			let tab = $createTabNode(ulid(), newTabLabel(group.tabs.map(other => other.label)));
			tab.append($createParagraphNode());
			node.append(tab);
			key = tab.getKey();
		});
		if (!key) return;
		onSelect(key);
		setRenaming(key);
	};

	useEffect(() => {
		if (!armed) return;
		let timer = setTimeout(() => setArmed(undefined), 4000);
		return () => clearTimeout(timer);
	}, [armed]);

	let handlers = useRef<(event: KeyboardEvent) => void>(() => {});
	handlers.current = event => {
		let position = buttons.current.findIndex(button => button === event.target);
		if (position < 0) return;
		let action = stripKey(event.key, position, group.tabs.length, editable);
		if (!action) return;
		event.preventDefault();
		if (action.type === "select") {
			onSelect(group.tabs[action.index]!.key);
			buttons.current[action.index]?.focus();
		} else if (action.type === "rename") setRenaming(group.tabs[position]!.key);
		else remove(position);
	};

	// Native, so a key meant for a strip control never reaches Lexical's root
	// listener, which would otherwise apply it to the document's selection too.
	useEffect(() => {
		let host = chrome.current;
		if (!host) return;
		let keydown = (event: KeyboardEvent) => {
			if (!STRIP_KEYS.has(event.key)) return;
			event.stopPropagation();
			handlers.current(event);
		};
		host.addEventListener("keydown", keydown);
		return () => host.removeEventListener("keydown", keydown);
	}, []);

	useLayoutEffect(() => {
		let list = strip.current;
		let activeButton = buttons.current[activeIndex];
		if (!list || !activeButton) return;
		let measure = () =>
			setMask(edgeMask(scrollEdges(list.scrollLeft, list.clientWidth, list.scrollWidth)));
		let reveal = () => {
			revealInline(list, activeButton);
			measure();
		};
		reveal();
		list.addEventListener("scroll", measure, { passive: true });
		let observer = new ResizeObserver(reveal);
		observer.observe(list);
		for (let button of buttons.current) {
			if (button) observer.observe(button);
		}
		return () => {
			observer.disconnect();
			list.removeEventListener("scroll", measure);
		};
	}, [active, activeIndex, structure, renaming]);

	return (
		<div
			ref={chrome}
			// The strip is chrome, not content: keep it out of the editable tree.
			contentEditable={false}
			className="plan-tab-strip"
		>
			<div
				ref={strip}
				role="tablist"
				data-focus-boundary=""
				style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
				className="flex min-w-0 gap-1 overflow-x-auto scroll-smooth motion-reduce:scroll-auto"
			>
				{group.tabs.map((tab, position) => {
					let selected = tab.key === active;
					let name = tab.label || `Tab ${position + 1}`;
					if (editable && renaming === tab.key) {
						buttons.current[position] = null;
						return (
							<RenameField
								key={tab.key}
								label={tab.label}
								onDone={label => rename(tab.key, label)}
							/>
						);
					}
					return (
						<div
							key={tab.key}
							className="plan-tab"
							data-selected={selected ? "" : undefined}
							data-armed={armed === tab.key ? "" : undefined}
							data-removable={canRemove ? "" : undefined}
							onPointerLeave={event => {
								// Touch reports a leave as the finger lifts, which would undo a long press.
								if (event.pointerType !== "touch" && armed === tab.key) setArmed(undefined);
							}}
						>
							<button
								ref={element => {
									buttons.current[position] = element;
								}}
								type="button"
								role="tab"
								title={tab.label || undefined}
								id={`ace-tab-${tab.key}`}
								aria-selected={selected}
								aria-controls={`ace-panel-${tab.key}`}
								aria-keyshortcuts={editable ? "Enter Delete" : undefined}
								aria-description={armed === tab.key
									? "Press Delete again to remove this tab and its content"
									: undefined}
								tabIndex={selected ? 0 : -1}
								onPointerDown={event => {
									pointer.current = event.pointerType;
									if (event.pointerType === "touch" && canRemove) {
										let key = tab.key;
										press.current = setTimeout(() => {
											press.current = undefined;
											pressed.current = true;
											setArmed(key);
										}, LONG_PRESS);
									}
								}}
								onPointerUp={release}
								onPointerCancel={release}
								onContextMenu={event => {
									if (pointer.current === "touch" && canRemove) event.preventDefault();
								}}
								onClick={() => {
									// A long press arms removal; the tap that ends it does nothing else.
									if (pressed.current) {
										pressed.current = false;
										return;
									}
									// Touch has no double-click: a second tap on the open tab renames it.
									if (editable && selected && pointer.current === "touch") setRenaming(tab.key);
									else onSelect(tab.key);
								}}
								onDoubleClick={() => {
									if (editable) setRenaming(tab.key);
								}}
								className="min-w-0 max-w-64 truncate px-2.5 py-1 text-left text-sm font-medium"
							>
								{name}
							</button>
							{canRemove && (
								<button
									type="button"
									tabIndex={-1}
									aria-label={armed === tab.key && !tab.empty
										? `Remove ${name} and its content`
										: `Remove ${name}`}
									title={armed === tab.key && !tab.empty
										? `Click again to remove ${name} and its content`
										: `Remove ${name}`}
									onClick={() => remove(position)}
									className="plan-tab-remove"
								>
									<CloseIcon aria-hidden="true" />
								</button>
							)}
						</div>
					);
				})}
			</div>
			{editable && (
				<button
					type="button"
					aria-label="Add tab"
					title="Add tab"
					onClick={add}
					className="plan-tab-add btn btn-icon btn-ghost"
				>
					<PlusIcon aria-hidden="true" />
				</button>
			)}
		</div>
	);
}

export function TabsPlugin() {
	let [editor] = useLexicalComposerContext();
	let disabled = useCellValue(readOnly$);
	let [groups, setGroups] = useState<Group[]>([]);
	/** Active tab per group, by node key. Local to this viewer. */
	let [active, setActive] = useState<Record<string, string>>({});

	useEffect(() => {
		let update = () => setGroups(collect(editor));
		update();
		return editor.registerUpdateListener(update);
	}, [editor]);

	let select = useCallback((group: string, key: string) => {
		setActive(prev => ({ ...prev, [group]: key }));
	}, []);

	// Show exactly one panel per group without touching the document.
	useEffect(() => {
		for (let group of groups) {
			let chosen = shown(group, active[group.key]);
			for (let tab of group.tabs) {
				let element = editor.getElementByKey(tab.key);
				if (!element) continue;
				element.hidden = tab.key !== chosen;
				element.setAttribute("id", `ace-panel-${tab.key}`);
				element.setAttribute("aria-labelledby", `ace-tab-${tab.key}`);
			}
		}
	}, [editor, groups, active]);

	return (
		<>
			{groups.map(group => {
				// The node reserves an unmanaged container for exactly this, so
				// the strip can live inside the node without Lexical removing it.
				let host = editor.getElementByKey(group.key)
					?.querySelector<HTMLElement>("[data-plan-chrome='tabs']");
				if (!host) return null;
				return createPortal(
					<Strip
						group={group}
						active={shown(group, active[group.key]) ?? ""}
						editable={!disabled}
						onSelect={key => select(group.key, key)}
					/>,
					host,
					group.key,
				);
			})}
		</>
	);
}
