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
import { $getRoot, $isElementNode } from "lexical";
import { $isTabNode, $isTabsNode } from "@chopin/dialect";

import type { ElementNode, LexicalEditor } from "lexical";

type Group = {
	id: string;
	key: string;
	tabs: Array<{ id: string; key: string; label: string }>;
};

/** Reveal a tab without moving any scroll ancestor outside its own strip. */
function revealInline(strip: HTMLElement, tab: HTMLElement): void {
	let viewport = strip.getBoundingClientRect();
	let item = tab.getBoundingClientRect();
	if (item.left < viewport.left) strip.scrollLeft += item.left - viewport.left;
	else if (item.right > viewport.right) strip.scrollLeft += item.right - viewport.right;
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

function Strip(
	{ group, active, onSelect }: {
		group: Group;
		active: string;
		onSelect: (key: string) => void;
	},
) {
	let strip = useRef<HTMLDivElement>(null);
	let buttons = useRef<Array<HTMLButtonElement | null>>([]);
	let activeIndex = group.tabs.findIndex(tab => tab.key === active);
	let structure = group.tabs.map(tab => tab.key).join(" ");
	let select = (index: number) => {
		onSelect(group.tabs[index]!.key);
		buttons.current[index]?.focus();
	};

	useLayoutEffect(() => {
		let list = strip.current;
		let activeButton = buttons.current[activeIndex];
		if (!list || !activeButton) return;
		let reveal = () => revealInline(list, activeButton);
		reveal();
		let observer = new ResizeObserver(reveal);
		observer.observe(list);
		for (let button of buttons.current) {
			if (button) observer.observe(button);
		}
		return () => observer.disconnect();
	}, [active, activeIndex, structure]);

	return (
		<div
			ref={strip}
			role="tablist"
			// The strip is chrome, not content: keep it out of the editable tree.
			contentEditable={false}
			className="flex gap-1 overflow-x-auto pb-1 hairline-b"
		>
			{group.tabs.map((tab, position) => (
				<button
					key={tab.key}
					ref={element => {
						buttons.current[position] = element;
					}}
					type="button"
					role="tab"
					id={`ace-tab-${tab.key}`}
					aria-selected={tab.key === active}
					aria-controls={`ace-panel-${tab.key}`}
					tabIndex={tab.key === active ? 0 : -1}
					onClick={() => onSelect(tab.key)}
					onKeyDown={event => {
						if (event.key === "ArrowRight") select((position + 1) % group.tabs.length);
						else if (event.key === "ArrowLeft") {
							select((position - 1 + group.tabs.length) % group.tabs.length);
						} else if (event.key === "Home") select(0);
						else if (event.key === "End") select(group.tabs.length - 1);
						else return;
						event.preventDefault();
					}}
					className={`max-w-full shrink-0 whitespace-normal break-words rounded-md px-2.5 py-1 text-left text-sm font-medium transition ${
						tab.key === active
							? "bg-selected text-text-primary"
							: "text-text-quaternary hover:text-text-primary"
					}`}
				>
					{tab.label || `Tab ${position + 1}`}
				</button>
			))}
		</div>
	);
}

export function TabsPlugin() {
	let [editor] = useLexicalComposerContext();
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
			let chosen = active[group.key] ?? group.tabs[0]?.key;
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
						active={active[group.key] ?? group.tabs[0]?.key ?? ""}
						onSelect={key => select(group.key, key)}
					/>,
					host,
					group.key,
				);
			})}
		</>
	);
}
