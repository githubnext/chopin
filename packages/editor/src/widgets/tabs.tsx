/**
 * Tab strips.
 *
 * Tab panels are ordinary element nodes in the document, so their content
 * collaborates like any other block. Only *visibility* is local: switching tabs
 * must not edit the document or move other people, so the strip is rendered
 * alongside the panels and toggles their DOM, leaving the model untouched.
 */

import { useCallback, useEffect, useState } from "react";
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
	let select = (index: number) => onSelect(group.tabs[index]!.key);

	return (
		<div
			role="tablist"
			// The strip is chrome, not content: keep it out of the editable tree.
			contentEditable={false}
			className="flex gap-1 overflow-x-auto border-b border-border pb-1"
		>
			{group.tabs.map((tab, position) => (
				<button
					key={tab.key}
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
					className={`shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition ${
						tab.key === active
							? "bg-muted text-foreground"
							: "text-muted-foreground hover:text-foreground"
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
