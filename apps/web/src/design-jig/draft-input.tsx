import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";

import { writeDraft } from "./draft-highlights";
import { reconcileReferenceDrafts } from "../chat/references";
import type { HTMLAttributes } from "react";
import type { ReferenceDraft } from "../chat/references";

export type DraftInputHandle = {
	focus: () => void;
	setSelectionRange: (start: number, end: number) => void;
	readonly selectionStart: number;
	readonly selectionEnd: number;
};
type DraftEvent = {
	currentTarget: { value: string; selectionStart: number; references?: ReferenceDraft[] };
};
type DraftProps =
	& Pick<
		HTMLAttributes<HTMLDivElement>,
		| "role"
		| "aria-label"
		| "aria-disabled"
		| "aria-invalid"
		| "aria-describedby"
		| "aria-autocomplete"
		| "aria-expanded"
		| "aria-controls"
		| "aria-activedescendant"
		| "onKeyDown"
		| "onBlur"
	>
	& {
		value: string;
		references: ReferenceDraft[];
		readOnly: boolean;
		placeholder: string;
		onChange: (event: DraftEvent) => void;
		onSelect: (event: DraftEvent) => void;
	};

function selectionOffsets(element: HTMLElement) {
	let selection = window.getSelection();
	let offset = (node: Node | null, at: number) => {
		if (!node || !element.contains(node)) return 0;
		let range = document.createRange();
		range.selectNodeContents(element);
		range.setEnd(node, at);
		return range.toString().length;
	};
	return {
		anchor: offset(selection?.anchorNode ?? null, selection?.anchorOffset ?? 0),
		focus: offset(selection?.focusNode ?? null, selection?.focusOffset ?? 0),
	};
}

function setSelection(element: HTMLElement, anchor: number, focus: number) {
	let point = (offset: number): [Node, number] => {
		let walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		let node: Node | null;
		let last: Node = element;
		while ((node = walker.nextNode())) {
			let length = node.textContent?.length ?? 0;
			if (offset <= length) return [node, Math.max(0, offset)];
			offset -= length;
			last = node;
		}
		return [last, last === element ? 0 : last.textContent?.length ?? 0];
	};
	let [startNode, startOffset] = point(anchor);
	let [endNode, endOffset] = point(focus);
	window.getSelection()?.setBaseAndExtent(startNode, startOffset, endNode, endOffset);
}

export let DraftInput = forwardRef<DraftInputHandle, DraftProps>(function DraftInput(
	{
		value,
		references,
		readOnly,
		placeholder,
		onChange,
		onSelect,
		onKeyDown,
		onBlur,
		role,
		"aria-label": label,
		"aria-disabled": disabled,
		"aria-invalid": invalid,
		"aria-describedby": describedBy,
		"aria-autocomplete": autocomplete,
		"aria-expanded": expanded,
		"aria-controls": controls,
		"aria-activedescendant": activeDescendant,
	},
	ref,
) {
	let element = useRef<HTMLDivElement>(null);
	let composing = useRef(false);
	let history = useRef([{ value, references, anchor: value.length, focus: value.length }]);
	let historyIndex = useRef(0);
	let event = () => {
		let current = element.current!;
		let selected = selectionOffsets(current);
		return {
			currentTarget: {
				value: current.textContent ?? "",
				selectionStart: Math.min(selected.anchor, selected.focus),
			},
		};
	};
	let remember = (
		next: string,
		refs: ReferenceDraft[],
		selected: { anchor: number; focus: number },
	) => {
		let current = history.current[historyIndex.current]!;
		if (current.value === next && JSON.stringify(current.references) === JSON.stringify(refs)) {
			Object.assign(current, selected);
			return;
		}
		history.current.splice(historyIndex.current + 1);
		history.current.push({ value: next, references: refs, ...selected });
		historyIndex.current = history.current.length - 1;
	};
	let change = () => {
		let next = event();
		let refs = reconcileReferenceDrafts(value, next.currentTarget.value, references);
		if (!composing.current) {
			remember(next.currentTarget.value, refs, selectionOffsets(element.current!));
		}
		onChange({ currentTarget: { ...next.currentTarget, references: refs } });
	};
	let insert = (text: string) => {
		let selection = window.getSelection();
		if (!selection?.rangeCount || readOnly) return;
		let range = selection.getRangeAt(0);
		range.deleteContents();
		let node = document.createTextNode(text);
		range.insertNode(node);
		range.setStartAfter(node);
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
		change();
	};
	useImperativeHandle(ref, () => ({
		focus: () => element.current?.focus(),
		setSelectionRange: (start, end) => {
			if (element.current) setSelection(element.current, start, end);
		},
		get selectionStart() {
			return element.current ? event().currentTarget.selectionStart : 0;
		},
		get selectionEnd() {
			if (!element.current) return 0;
			let selected = selectionOffsets(element.current);
			return Math.max(selected.anchor, selected.focus);
		},
	}));
	useLayoutEffect(() => {
		let current = element.current;
		if (!current || composing.current) return;
		let selected = selectionOffsets(current);
		let focused = document.activeElement === current;
		let snapshot = history.current[historyIndex.current]!;
		if (
			snapshot.value !== value || JSON.stringify(snapshot.references) !== JSON.stringify(references)
		) {
			remember(value, references, selected);
		}
		writeDraft(current, value, references);
		if (focused) setSelection(current, selected.anchor, selected.focus);
	}, [value, references]);
	return (
		<div
			role={role}
			aria-label={label}
			aria-disabled={disabled}
			aria-invalid={invalid}
			aria-describedby={describedBy}
			aria-autocomplete={autocomplete}
			aria-expanded={expanded}
			aria-controls={controls}
			aria-activedescendant={activeDescendant}
			ref={element}
			className="composer-draft-input"
			contentEditable={!readOnly}
			suppressContentEditableWarning
			aria-readonly={readOnly}
			aria-multiline="true"
			data-empty={!value || undefined}
			data-placeholder={placeholder}
			tabIndex={0}
			onInput={change}
			onSelect={() => onSelect(event())}
			onFocus={() => onSelect(event())}
			onKeyUp={() => onSelect(event())}
			onMouseUp={() => onSelect(event())}
			onBlur={onBlur}
			onCompositionStart={() => {
				composing.current = true;
			}}
			onCompositionEnd={() => {
				composing.current = false;
				let current = element.current!;
				let selected = selectionOffsets(current);
				let next = current.textContent ?? "";
				writeDraft(current, next, reconcileReferenceDrafts(value, next, references));
				setSelection(current, selected.anchor, selected.focus);
				change();
			}}
			onKeyDown={keyboard => {
				if (composing.current || keyboard.nativeEvent.isComposing || keyboard.keyCode === 229) {
					return;
				}
				let selected = selectionOffsets(element.current!);
				Object.assign(history.current[historyIndex.current]!, selected);
				if (
					!readOnly && !keyboard.nativeEvent.isComposing && (keyboard.metaKey || keyboard.ctrlKey)
					&& ["z", "y"].includes(keyboard.key.toLowerCase())
				) {
					keyboard.preventDefault();
					let redo = keyboard.shiftKey || keyboard.key.toLowerCase() === "y";
					let index = Math.max(
						0,
						Math.min(history.current.length - 1, historyIndex.current + (redo ? 1 : -1)),
					);
					historyIndex.current = index;
					let snapshot = history.current[index]!;
					writeDraft(element.current!, snapshot.value, snapshot.references);
					setSelection(element.current!, snapshot.anchor, snapshot.focus);
					onChange({
						currentTarget: {
							value: snapshot.value,
							references: snapshot.references,
							selectionStart: Math.min(snapshot.anchor, snapshot.focus),
						},
					});
					return;
				}
				onKeyDown?.(keyboard);
				if (keyboard.defaultPrevented || readOnly || keyboard.nativeEvent.isComposing) return;
				if (keyboard.key === "Enter") {
					keyboard.preventDefault();
					insert("\n");
				}
			}}
			onPaste={paste => {
				paste.preventDefault();
				insert(paste.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
			}}
		/>
	);
});
