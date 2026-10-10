/**
 * Callout headings and type picker.
 *
 * Type and title are node attributes rather than content, so they render as
 * chrome. The title still edits like document text; the type picker stays
 * behind its icon until asked for. Changing either is a local Yjs update —
 * callouts already carry an id, so nothing here needs the server.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	CheckIcon,
	InfoIcon,
	LightbulbIcon,
	SirenIcon,
	SparkleIcon,
	WarningIcon,
} from "@chopin/icons";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { readOnly$ } from "@mdxeditor/editor";
import { useCellValue } from "@mdxeditor/gurx";
import * as Select from "@radix-ui/react-select";
import {
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$getState,
	$isElementNode,
	$isRangeSelection,
	setDOMUnmanaged,
} from "lexical";
import { $isCalloutNode, CALLOUT_TYPES, calloutFoldState, limits } from "@chopin/dialect";

import { foldOf } from "./callout-fold";
import { registerCalloutNormalization } from "./callout-shape";

import type { CalloutType } from "@chopin/dialect";
import type { IconSize } from "@chopin/icons";
import type { ElementNode, LexicalEditor } from "lexical";

type Callout = {
	key: string;
	type: CalloutType;
	title: string;
	fold: number;
	blocks: number;
	/** Index of the body block holding the caret, when it is inside this callout. */
	caret?: number;
};

const LABELS: Record<CalloutType, string> = {
	note: "Note",
	tip: "Tip",
	important: "Important",
	warning: "Warning",
	danger: "Danger",
};

function TypeIcon({ type, size = 14 }: { type: CalloutType; size?: IconSize }) {
	let props = { "aria-hidden": true, size } as const;
	switch (type) {
		case "note":
			return <InfoIcon {...props} />;
		case "tip":
			return <LightbulbIcon {...props} />;
		case "important":
			return <SparkleIcon {...props} />;
		case "warning":
			return <WarningIcon {...props} />;
		case "danger":
			return <SirenIcon {...props} />;
	}
}

function collect(editor: LexicalEditor): Callout[] {
	let out: Callout[] = [];

	editor.getEditorState().read(() => {
		let selection = $getSelection();
		let anchor = $isRangeSelection(selection) ? selection.anchor.getNode() : undefined;
		let walk = (node: ElementNode) => {
			for (let child of node.getChildren()) {
				if ($isCalloutNode(child)) {
					let fold = $getState(child, calloutFoldState);
					let caret: number | undefined;
					if (fold && anchor) {
						let block = anchor.getParents().find(parent => parent.getParent()?.is(child))
							?? (anchor.getParent()?.is(child) ? anchor : undefined);
						if (block) caret = block.getIndexWithinParent();
					}
					out.push({
						key: child.getKey(),
						type: child.getCalloutType(),
						title: child.getTitle(),
						fold,
						blocks: child.getChildrenSize(),
						...(caret === undefined ? {} : { caret }),
					});
				}
				if ($isElementNode(child)) walk(child);
			}
		};
		walk($getRoot());
	});

	return out;
}

type TitleSelection = { anchor: number; focus: number };

function titleSelection(element: HTMLElement): TitleSelection | undefined {
	let selection = window.getSelection();
	if (!selection?.anchorNode || !selection.focusNode) return;
	if (!element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return;

	let offset = (node: Node, at: number) => {
		let range = document.createRange();
		range.selectNodeContents(element);
		range.setEnd(node, at);
		return range.toString().length;
	};
	return {
		anchor: offset(selection.anchorNode, selection.anchorOffset),
		focus: offset(selection.focusNode, selection.focusOffset),
	};
}

function restoreTitleSelection(element: HTMLElement, saved?: TitleSelection) {
	if (!saved) return;
	let text = element.firstChild ?? element.appendChild(document.createTextNode(""));
	let length = text.textContent?.length ?? 0;
	window.getSelection()?.setBaseAndExtent(
		text,
		Math.min(saved.anchor, length),
		text,
		Math.min(saved.focus, length),
	);
}

function plainTitle(element: HTMLElement): string {
	let raw = element.textContent ?? "";
	let title = raw.replace(/[\r\n]+/g, " ").slice(0, limits.MAX_CALLOUT_TITLE);
	if (raw === title && element.childElementCount === 0) return title;

	let selection = titleSelection(element);
	element.textContent = title;
	restoreTitleSelection(element, selection);
	return title;
}

function pastePlainTitle(element: HTMLElement, value: string): string {
	let selection = window.getSelection();
	let range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
	if (!selection || !range || !element.contains(range.commonAncestorContainer)) {
		element.append(value.replace(/[\r\n]+/g, " "));
		return plainTitle(element);
	}

	let plain = value.replace(/[\r\n]+/g, " ");

	range.deleteContents();
	let pasted = document.createTextNode(plain);
	range.insertNode(pasted);
	range.setStart(pasted, plain.length);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
	return plainTitle(element);
}

function CalloutTitle(
	{ callout, editor, disabled, elementRef }: {
		callout: Callout;
		editor: LexicalEditor;
		disabled?: boolean;
		elementRef: React.RefObject<HTMLSpanElement | null>;
	},
) {
	let composing = useRef(false);
	let disabledRef = useRef(disabled);
	disabledRef.current = disabled;

	let setTitle = useCallback((title: string) => {
		if (disabledRef.current) return;
		editor.update(() => {
			let node = $getNodeByKey(callout.key);
			if ($isCalloutNode(node)) node.setTitle(title);
		});
	}, [editor, callout.key]);

	let sync = useCallback(() => {
		let element = elementRef.current;
		if (!element) return;
		if (disabled) composing.current = false;
		if (composing.current) return;
		if (!disabled && document.activeElement === element) return;
		if (element.textContent !== callout.title || element.childElementCount > 0) {
			element.textContent = callout.title;
		}
	}, [callout.title, disabled, elementRef]);

	useLayoutEffect(sync, [sync]);

	let commit = (element: HTMLElement) => setTitle(plainTitle(element));

	return (
		<span
			aria-label="Callout title"
			className="plan-callout-title"
			contentEditable={!disabled}
			data-placeholder={LABELS[callout.type]}
			onBlur={sync}
			onCompositionEnd={event => {
				composing.current = false;
				commit(event.currentTarget);
			}}
			onCompositionStart={() => {
				composing.current = true;
			}}
			onInput={event => {
				if (!composing.current) commit(event.currentTarget);
			}}
			onKeyDown={event => {
				if (event.key !== "Enter" || composing.current || event.nativeEvent.isComposing) return;
				event.preventDefault();
				event.currentTarget.blur();
			}}
			onPaste={event => {
				event.preventDefault();
				setTitle(pastePlainTitle(event.currentTarget, event.clipboardData.getData("text/plain")));
			}}
			ref={elementRef}
			role={disabled ? undefined : "textbox"}
			suppressContentEditableWarning
			tabIndex={disabled ? undefined : 0}
		/>
	);
}

function Heading(
	{ callout, editor, disabled }: {
		callout: Callout;
		editor: LexicalEditor;
		disabled?: boolean;
	},
) {
	let [choosing, setChoosing] = useState(false);
	// Becoming disabled should close the picker immediately, not one render
	// later — adjust it here rather than in an effect that runs after commit.
	let [previousDisabled, setPreviousDisabled] = useState(disabled);
	if (disabled !== previousDisabled) {
		setPreviousDisabled(disabled);
		if (disabled) setChoosing(false);
	}
	let title = useRef<HTMLSpanElement>(null);
	let disabledRef = useRef(disabled);
	disabledRef.current = disabled;

	let setType = useCallback((type: CalloutType) => {
		if (disabledRef.current) return;
		editor.update(() => {
			let node = $getNodeByKey(callout.key);
			if ($isCalloutNode(node)) node.setCalloutType(type);
		});
	}, [editor, callout.key]);

	let choose = (value: string) => {
		if (disabledRef.current) return;
		let type = CALLOUT_TYPES.find(candidate => candidate === value);
		if (type) setType(type);
	};

	return (
		<div contentEditable={false} className="plan-callout-heading">
			<Select.Root
				disabled={disabled}
				onOpenChange={open => setChoosing(disabledRef.current ? false : open)}
				onValueChange={choose}
				open={choosing && !disabled}
				value={callout.type}
			>
				<Select.Trigger
					aria-label={`Change callout type: ${LABELS[callout.type]}`}
					className="plan-callout-type"
					data-callout-type={callout.type}
					title={`${LABELS[callout.type]} — change callout type`}
				>
					<TypeIcon type={callout.type} />
				</Select.Trigger>

				<Select.Portal>
					<Select.Content
						aria-label="Callout type"
						className="plan-callout-menu"
						onKeyDown={event => {
							if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

							let options = [
								...event.currentTarget.querySelectorAll<HTMLElement>(
									"[role='option']:not([data-disabled])",
								),
							];
							let current = options.indexOf(event.target as HTMLElement);
							let next = current < 0
								? options[event.key === "ArrowDown" ? 0 : options.length - 1]
								: options[current + (event.key === "ArrowDown" ? 1 : -1)];
							// Radix queues this focus change. A rapid Enter would otherwise
							// select the option that was focused before the arrow key.
							next?.focus();
							event.preventDefault();
						}}
						position="popper"
						sideOffset={4}
					>
						<Select.Viewport data-focus-boundary="">
							{CALLOUT_TYPES.map(type => (
								<Select.Item
									className="plan-callout-option"
									data-callout-type={type}
									key={type}
									value={type}
								>
									<TypeIcon type={type} size={14} />
									<Select.ItemText>{LABELS[type]}</Select.ItemText>
									<Select.ItemIndicator asChild>
										<CheckIcon aria-hidden="true" size={14} />
									</Select.ItemIndicator>
								</Select.Item>
							))}
						</Select.Viewport>
					</Select.Content>
				</Select.Portal>
			</Select.Root>

			<CalloutTitle callout={callout} disabled={disabled} editor={editor} elementRef={title} />
		</div>
	);
}

/**
 * Where a folded callout's disclosure renders: after the body, outside the slot Lexical
 * reconciles, and marked unmanaged so its mutation observer leaves it in place.
 */
function disclosureHost(editor: LexicalEditor, key: string): HTMLElement | null {
	let element = editor.getElementByKey(key);
	if (!element) return null;
	let host = element.querySelector<HTMLElement>(":scope > [data-plan-chrome='callout-fold']");
	if (host) return host;
	host = document.createElement("div");
	host.dataset.planChrome = "callout-fold";
	setDOMUnmanaged(host);
	element.append(host);
	return host;
}

/** Opens or closes the blocks a callout folds; a reader's own view, never the document. */
function FoldToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	return (
		<div contentEditable={false} className="plan-callout-fold">
			<button aria-expanded={open} className="plan-research-more" onClick={onToggle} type="button">
				{open ? "Show less" : "Show more"}
			</button>
		</div>
	);
}

export function CalloutPlugin() {
	let [editor] = useLexicalComposerContext();
	let disabled = useCellValue(readOnly$);
	let [callouts, setCallouts] = useState<Callout[]>([]);
	let [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
	let folds = new Map(callouts.map(callout => [
		callout.key,
		foldOf({ ...callout, opened: opened.has(callout.key) }),
	]));

	// Mirrored onto the callout's own element; Lexical leaves attributes it does not own alone.
	useLayoutEffect(() => {
		for (let callout of callouts) {
			let element = editor.getElementByKey(callout.key);
			if (!element) continue;
			let fold = folds.get(callout.key) ?? "none";
			let lead = fold === "none" ? undefined : String(callout.fold);
			if (element.dataset.foldState !== (fold === "none" ? undefined : fold)) {
				if (fold === "none") delete element.dataset.foldState;
				else element.dataset.foldState = fold;
			}
			if (element.dataset.foldLead !== lead) {
				if (lead) element.dataset.foldLead = lead;
				else delete element.dataset.foldLead;
			}
		}
	});

	let toggle = (key: string) =>
		setOpened(previous => {
			let next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	useEffect(() => registerCalloutNormalization(editor), [editor]);

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
				let fold = folds.get(callout.key);
				let foldHost = fold === "none" ? null : disclosureHost(editor, callout.key);
				return [
					createPortal(
						<Heading callout={callout} editor={editor} disabled={disabled} />,
						host,
						callout.key,
					),
					foldHost && createPortal(
						<FoldToggle open={fold === "open"} onToggle={() => toggle(callout.key)} />,
						foldHost,
						`${callout.key}-fold`,
					),
				];
			})}
		</>
	);
}
