import { useEffect, useRef, useState } from "react";
import { $getNodeByKey, HISTORY_PUSH_TAG } from "lexical";

import { $isImageNode } from "@chopin/dialect";

import { draggedImageWidth, imageWidth } from "./image-size";

import type { KeyboardEvent, PointerEvent, RefObject } from "react";
import type { LexicalEditor } from "lexical";
import type { ImageCorner } from "./image-size";

let corners: ImageCorner[] = ["top left", "top right", "bottom left", "bottom right"];

export function useImageResize(
	{ editor, nodeKey, src, width, disabled, frame }: {
		editor: LexicalEditor;
		nodeKey: string;
		src: string;
		width: number;
		disabled: boolean;
		frame: RefObject<HTMLSpanElement | null>;
	},
) {
	let [preview, setPreview] = useState<number>();
	let cancel = useRef<(() => void) | undefined>(undefined);

	useEffect(() => () => cancel.current?.(), [disabled, src, width]);

	let maximum = () => {
		let node = editor.getElementByKey(nodeKey);
		// A linked image's immediate parent is a shrink-wrapped anchor, not its resize boundary.
		let block = node?.parentElement?.closest<HTMLElement>(
			"p, li, th, td, h1, h2, h3, h4, h5, h6, .planColumn, [contenteditable]",
		);
		if (!block) return 4096;
		let style = getComputedStyle(block);
		let inset = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
			+ parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
		return Math.min(4096, block.getBoundingClientRect().width - inset);
	};
	let commit = (next: number) => {
		if (disabled || !editor.isEditable()) return;
		editor.update(() => {
			let node = $getNodeByKey(nodeKey);
			if (!$isImageNode(node) || node.getSrc() !== src || node.getWidth() !== width) return;
			node.setWidth(next);
		}, { tag: HISTORY_PUSH_TAG });
	};
	let start = (event: PointerEvent<HTMLButtonElement>, corner: ImageCorner) => {
		if (event.button !== 0 || disabled || !editor.isEditable()) return;
		let rect = frame.current?.getBoundingClientRect();
		if (!rect?.width || !rect.height) return;
		event.preventDefault();
		event.stopPropagation();
		cancel.current?.();
		let handle = event.currentTarget;
		handle.focus({ preventScroll: true });
		let pointer = event.pointerId;
		let x = event.clientX;
		let y = event.clientY;
		let next = Math.round(rect.width);
		let changed = false;
		let move = (event: globalThis.PointerEvent) => {
			if (event.pointerId !== pointer) return;
			next = draggedImageWidth(
				rect.width,
				rect.width / rect.height,
				event.clientX - x,
				event.clientY - y,
				corner,
				maximum(),
			);
			changed = next !== Math.round(rect.width);
			setPreview(next);
		};
		let cleanup = () => {
			document.removeEventListener("pointermove", move);
			document.removeEventListener("pointerup", finish);
			document.removeEventListener("pointercancel", abort);
			document.removeEventListener("keydown", escape, true);
			handle.removeEventListener("lostpointercapture", abort);
			unregisterUpdate();
			unregisterEditable();
			if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
			cancel.current = undefined;
			setPreview(undefined);
		};
		let finish = (event: globalThis.PointerEvent) => {
			if (event.pointerId !== pointer) return;
			cleanup();
			if (changed) commit(next);
		};
		let abort = (event: globalThis.PointerEvent) => {
			if (event.pointerId === pointer) cleanup();
		};
		let escape = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			cleanup();
			handle.focus();
		};
		let unregisterUpdate = editor.registerUpdateListener(({ editorState }) => {
			let valid = editorState.read(() => {
				let node = $getNodeByKey(nodeKey);
				return $isImageNode(node) && node.getSrc() === src && node.getWidth() === width;
			});
			if (!valid) cleanup();
		});
		let unregisterEditable = editor.registerEditableListener(editable => {
			if (!editable) cleanup();
		});
		cancel.current = cleanup;
		handle.setPointerCapture(pointer);
		document.addEventListener("pointermove", move);
		document.addEventListener("pointerup", finish);
		document.addEventListener("pointercancel", abort);
		document.addEventListener("keydown", escape, true);
		handle.addEventListener("lostpointercapture", abort);
	};
	let key = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		let current = frame.current?.getBoundingClientRect().width;
		if (!current) return;
		let step = event.shiftKey ? 50 : 10;
		let max = maximum();
		let next = event.key === "ArrowLeft" || event.key === "ArrowDown"
			? current - step
			: event.key === "ArrowRight" || event.key === "ArrowUp"
			? current + step
			: event.key === "Home"
			? 64
			: event.key === "End"
			? max
			: undefined;
		if (next === undefined) return;
		event.preventDefault();
		event.stopPropagation();
		commit(imageWidth(next, max));
	};

	return {
		preview,
		reset: () => commit(0),
		controls: corners.map(corner => (
			<button
				key={corner}
				type="button"
				role="slider"
				aria-label={`Resize image from ${corner}`}
				aria-description="Use arrow keys to resize. Hold Shift for larger steps."
				aria-valuemin={0}
				aria-valuemax={4096}
				aria-valuenow={preview ?? width}
				aria-valuetext={preview || width ? `${preview ?? width} pixels wide` : "Automatic width"}
				className="plan-image-resize"
				data-corner={corner}
				onPointerDown={event => start(event, corner)}
				onKeyDown={key}
				onClick={event => {
					event.preventDefault();
					event.stopPropagation();
				}}
			/>
		)),
	};
}
