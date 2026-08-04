/**
 * Callout headings.
 *
 * Type and title are node attributes rather than content, so they render as
 * chrome and are edited through controls rather than by typing into the block.
 * Changing either is a local Yjs update — callouts already carry an id, so
 * nothing here needs the server.
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { readOnly$ } from "@mdxeditor/editor";
import { useCellValue } from "@mdxeditor/gurx";
import { $getNodeByKey, $getRoot, $isElementNode } from "lexical";
import { $isCalloutNode, CALLOUT_TYPES } from "@chopin/dialect";

import type { CalloutType } from "@chopin/dialect";
import type { ElementNode, LexicalEditor } from "lexical";

type Callout = { key: string; type: CalloutType; title: string };

const LABELS: Record<CalloutType, string> = {
	note: "Note",
	tip: "Tip",
	important: "Important",
	warning: "Warning",
	danger: "Danger",
};

function collect(editor: LexicalEditor): Callout[] {
	let out: Callout[] = [];

	editor.getEditorState().read(() => {
		let walk = (node: ElementNode) => {
			for (let child of node.getChildren()) {
				if ($isCalloutNode(child)) {
					out.push({
						key: child.getKey(),
						type: child.getCalloutType(),
						title: child.getTitle(),
					});
				}
				if ($isElementNode(child)) walk(child);
			}
		};
		walk($getRoot());
	});

	return out;
}

function Heading(
	{ callout, editor, disabled }: {
		callout: Callout;
		editor: LexicalEditor;
		disabled?: boolean;
	},
) {
	let setType = useCallback((type: CalloutType) => {
		editor.update(() => {
			let node = $getNodeByKey(callout.key);
			if ($isCalloutNode(node)) node.setCalloutType(type);
		});
	}, [editor, callout.key]);

	let setTitle = useCallback((title: string) => {
		editor.update(() => {
			let node = $getNodeByKey(callout.key);
			if ($isCalloutNode(node)) node.setTitle(title);
		});
	}, [editor, callout.key]);

	return (
		<div contentEditable={false} className="flex items-center gap-2 pb-1">
			<select
				aria-label="Callout type"
				value={callout.type}
				disabled={disabled}
				onChange={event => setType(event.currentTarget.value as CalloutType)}
				className="rounded-sm border border-transparent bg-transparent text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:border-border focus-visible:border-ring"
			>
				{CALLOUT_TYPES.map(type => <option key={type} value={type}>{LABELS[type]}</option>)}
			</select>

			<input
				aria-label="Callout title"
				value={callout.title}
				placeholder="Optional title"
				maxLength={100}
				disabled={disabled}
				onChange={event => setTitle(event.currentTarget.value)}
				className="min-w-0 flex-1 rounded-sm border border-transparent bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground/60 hover:border-border focus-visible:border-ring"
			/>
		</div>
	);
}

export function CalloutPlugin() {
	let [editor] = useLexicalComposerContext();
	let disabled = useCellValue(readOnly$);
	let [callouts, setCallouts] = useState<Callout[]>([]);

	useEffect(() => {
		let update = () => setCallouts(collect(editor));
		update();
		return editor.registerUpdateListener(update);
	}, [editor]);

	return (
		<>
			{callouts.map(callout => {
				let host = editor.getElementByKey(callout.key)
					?.querySelector<HTMLElement>("[data-plan-chrome='callout']");
				if (!host) return null;
				return createPortal(
					<Heading callout={callout} editor={editor} disabled={disabled} />,
					host,
					callout.key,
				);
			})}
		</>
	);
}
