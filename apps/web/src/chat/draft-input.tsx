import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";

import { writeDraft } from "./draft-highlights";
import { beforeInputSelection, reconcileReferenceDrafts } from "./references";
import type { HTMLAttributes } from "react";
import type { ReferenceDraft } from "../chat/references";

export type DraftInputHandle = {
	focus: () => void;
	setSelectionRange: (start: number, end: number) => void;
	readonly selectionStart: number;
	readonly selectionEnd: number;
};
type DraftEvent = {
	currentTarget: {
		value: string;
		selectionStart: number;
		selectionEnd: number;
		references?: ReferenceDraft[];
	};
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
		mentions: readonly string[];
		readOnly: boolean;
		placeholder: string;
		resetKey: number;
		historyGroupKey: boolean;
		onSubmit: () => void;
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
		mentions,
		readOnly,
		placeholder,
		resetKey,
		historyGroupKey,
		onSubmit,
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
	let mentionsKey = mentions.join("\0");
	let history = useRef([{ value, references, anchor: value.length, focus: value.length }]);
	let historyIndex = useRef(0);
	let historyKey = useRef(resetKey);
	let groupKey = useRef(historyGroupKey);
	let group = useRef<{ type: string; caret: number; at: number; index: number } | undefined>(
		undefined,
	);
	let pendingInput = useRef<{ type: string; start: number; end: number } | undefined>(undefined);
	let pendingEdit = useRef<{ start: number; end: number } | undefined>(undefined);
	let rememberSelection = () => {
		if (!composing.current && element.current) {
			Object.assign(history.current[historyIndex.current]!, selectionOffsets(element.current));
		}
	};
	let event = () => {
		let current = element.current!;
		let selected = selectionOffsets(current);
		return {
			currentTarget: {
				value: current.textContent ?? "",
				selectionStart: Math.min(selected.anchor, selected.focus),
				selectionEnd: Math.max(selected.anchor, selected.focus),
			},
		};
	};
	let remember = (
		next: string,
		refs: ReferenceDraft[],
		selected: { anchor: number; focus: number },
		merge = false,
	) => {
		let current = history.current[historyIndex.current]!;
		if (current.value === next && JSON.stringify(current.references) === JSON.stringify(refs)) {
			Object.assign(current, selected);
			return;
		}
		if (merge) {
			history.current[historyIndex.current] = { value: next, references: refs, ...selected };
			return;
		}
		history.current.splice(historyIndex.current + 1);
		history.current.push({ value: next, references: refs, ...selected });
		if (history.current.length > 100) history.current.shift();
		historyIndex.current = history.current.length - 1;
	};
	let change = () => {
		let next = event();
		let refs = reconcileReferenceDrafts(
			value,
			next.currentTarget.value,
			references,
			pendingEdit.current,
		);
		pendingEdit.current = undefined;
		let input = pendingInput.current;
		pendingInput.current = undefined;
		let at = performance.now();
		let groupable =
			input && ["insertText", "deleteContentBackward", "deleteContentForward"].includes(input.type)
				&& input.start === input.end && !composing.current
				? input
				: undefined;
		let merge = !!(groupable && group.current && group.current.type === groupable.type
			&& group.current.caret === groupable.start && at - group.current.at < 1000
			&& group.current.index === historyIndex.current);
		if (!composing.current) {
			remember(next.currentTarget.value, refs, selectionOffsets(element.current!), merge);
		}
		group.current = groupable
			? {
				type: groupable.type,
				caret: next.currentTarget.selectionStart,
				at,
				index: historyIndex.current,
			}
			: undefined;
		onChange({ currentTarget: { ...next.currentTarget, references: refs } });
	};
	let insert = (text: string) => {
		group.current = undefined;
		pendingInput.current = undefined;
		let selection = window.getSelection();
		if (!selection?.rangeCount || readOnly) return;
		let range = selection.getRangeAt(0);
		if (!element.current?.contains(range.commonAncestorContainer)) return;
		let selected = selectionOffsets(element.current);
		rememberSelection();
		pendingEdit.current = {
			start: Math.min(selected.anchor, selected.focus),
			end: Math.max(selected.anchor, selected.focus),
		};
		range.deleteContents();
		let node = document.createTextNode(text);
		range.insertNode(node);
		range.setStartAfter(node);
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
		change();
	};
	let restoreHistory = (redo: boolean) => {
		group.current = undefined;
		pendingInput.current = undefined;
		let index = Math.max(
			0,
			Math.min(history.current.length - 1, historyIndex.current + (redo ? 1 : -1)),
		);
		historyIndex.current = index;
		let snapshot = history.current[index]!;
		writeDraft(element.current!, snapshot.value, snapshot.references, mentions);
		setSelection(element.current!, snapshot.anchor, snapshot.focus);
		onChange({
			currentTarget: {
				value: snapshot.value,
				references: snapshot.references,
				selectionStart: Math.min(snapshot.anchor, snapshot.focus),
				selectionEnd: Math.max(snapshot.anchor, snapshot.focus),
			},
		});
	};
	let callbacks = useRef({ beforeInput: (_input: InputEvent) => {}, select: () => {} });
	callbacks.current = {
		beforeInput: input => {
			if (readOnly) {
				input.preventDefault();
				return;
			}
			if (["historyUndo", "historyRedo"].includes(input.inputType)) {
				input.preventDefault();
				restoreHistory(input.inputType === "historyRedo");
				return;
			}
			if (input.inputType === "insertParagraph" && !input.isComposing && !composing.current) {
				input.preventDefault();
				onSubmit();
				return;
			}
			if (input.inputType === "insertLineBreak" && !input.isComposing && !composing.current) {
				input.preventDefault();
				insert("\n");
				return;
			}
			rememberSelection();
			let selected = event().currentTarget;
			pendingInput.current = {
				type: input.inputType,
				start: selected.selectionStart,
				end: selected.selectionEnd,
			};
			let target = input.getTargetRanges?.()[0];
			if (
				target && element.current!.contains(target.startContainer)
				&& element.current!.contains(target.endContainer)
			) {
				let offset = (node: Node, at: number) => {
					let range = document.createRange();
					range.selectNodeContents(element.current!);
					range.setEnd(node, at);
					return range.toString().length;
				};
				pendingEdit.current = {
					start: offset(target.startContainer, target.startOffset),
					end: offset(target.endContainer, target.endOffset),
				};
			} else {pendingEdit.current = beforeInputSelection(
					selected.selectionStart,
					selected.selectionEnd,
					input.inputType,
					value.length,
				);}
		},
		select: () => {
			if (document.activeElement !== element.current) return;
			let next = event();
			if (
				group.current && (next.currentTarget.selectionStart !== group.current.caret
					|| next.currentTarget.selectionEnd !== group.current.caret)
			) group.current = undefined;
			onSelect(next);
		},
	};
	useEffect(() => {
		let current = element.current!;
		let beforeInput = (input: InputEvent) => callbacks.current.beforeInput(input);
		let select = () => callbacks.current.select();
		current.addEventListener("beforeinput", beforeInput);
		document.addEventListener("selectionchange", select);
		return () => {
			current.removeEventListener("beforeinput", beforeInput);
			document.removeEventListener("selectionchange", select);
		};
	}, []);
	useImperativeHandle(ref, () => ({
		focus: () => element.current?.focus(),
		setSelectionRange: (start, end) => {
			if (element.current) setSelection(element.current, start, end);
		},
		get selectionStart() {
			return element.current ? event().currentTarget.selectionStart : 0;
		},
		get selectionEnd() {
			return element.current ? event().currentTarget.selectionEnd : 0;
		},
	}));
	useLayoutEffect(() => {
		let current = element.current;
		if (!current || composing.current) return;
		let selected = selectionOffsets(current);
		let focused = document.activeElement === current;
		if (groupKey.current !== historyGroupKey) {
			group.current = undefined;
			groupKey.current = historyGroupKey;
		}
		if (historyKey.current !== resetKey) {
			group.current = undefined;
			history.current = [{ value, references, ...selected }];
			historyIndex.current = 0;
			historyKey.current = resetKey;
		}
		let snapshot = history.current[historyIndex.current]!;
		if (
			snapshot.value !== value || JSON.stringify(snapshot.references) !== JSON.stringify(references)
		) {
			group.current = undefined;
			remember(value, references, selected);
		}
		writeDraft(current, value, references, mentions);
		if (focused) setSelection(current, selected.anchor, selected.focus);
	}, [value, references, resetKey, mentionsKey, historyGroupKey]);
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
			onFocus={() => {
				group.current = undefined;
				onSelect(event());
			}}
			onKeyUp={() => onSelect(event())}
			onMouseUp={() => onSelect(event())}
			onBlur={blur => {
				group.current = undefined;
				onBlur?.(blur);
			}}
			onMouseDown={() => {
				group.current = undefined;
			}}
			onCompositionStart={() => {
				group.current = undefined;
				rememberSelection();
				composing.current = true;
			}}
			onCompositionEnd={() => {
				composing.current = false;
				let current = element.current!;
				let selected = selectionOffsets(current);
				let next = current.textContent ?? "";
				writeDraft(current, next, reconcileReferenceDrafts(value, next, references), mentions);
				setSelection(current, selected.anchor, selected.focus);
				change();
			}}
			onKeyDown={keyboard => {
				if (
					["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Tab", "Escape"]
						.includes(keyboard.key)
				) group.current = undefined;
				if (composing.current || keyboard.nativeEvent.isComposing || keyboard.keyCode === 229) {
					return;
				}
				rememberSelection();
				if (
					!readOnly && !keyboard.nativeEvent.isComposing && (keyboard.metaKey || keyboard.ctrlKey)
					&& ["z", "y"].includes(keyboard.key.toLowerCase())
				) {
					keyboard.preventDefault();
					let redo = keyboard.shiftKey || keyboard.key.toLowerCase() === "y";
					restoreHistory(redo);
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
