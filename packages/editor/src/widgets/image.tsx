/**
 * Images.
 *
 * A plan references an image by absolute URL, so rendering one is an `<img>`
 * and nothing more. Referrers are suppressed because plan content is written
 * by an agent as well as by people: loading it should not tell a third party
 * where the request came from.
 */

import { useEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { readOnly$ } from "@mdxeditor/editor";
import { useCellValue } from "@mdxeditor/gurx";

import { ImageIcon, PencilIcon } from "@chopin/icons";

import { ImageEditor } from "./image-editor";

import type { ImageNode } from "@chopin/dialect";

function Image({ alt, src, nodeKey }: { alt: string; src: string; nodeKey: string }) {
	let [editor] = useLexicalComposerContext();
	let disabled = useCellValue(readOnly$);
	let [failed, setFailed] = useState(false);
	let [selected, setSelected] = useState(false);
	let [editing, setEditing] = useState(false);
	let button = useRef<HTMLButtonElement>(null);

	useEffect(() => setFailed(false), [src]);
	useEffect(() => {
		if (disabled) setEditing(false);
	}, [disabled]);
	useEffect(() => {
		if (!selected) return;
		let outside = (event: PointerEvent) => {
			if (!(event.target instanceof Node)) return;
			if (!editor.getElementByKey(nodeKey)?.contains(event.target)) setSelected(false);
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [editor, nodeKey, selected]);

	let close = () => {
		setEditing(false);
		requestAnimationFrame(() => button.current?.focus());
	};

	// One element for both placements: the stylesheet makes it a frame when the
	// image is alone in its paragraph and a chip when it sits in a sentence.
	return (
		<>
			{failed
				? (
					<span
						aria-label={alt || "Image unavailable"}
						className="plan-image-missing"
						role="img"
						onClick={() => setSelected(true)}
					>
						<ImageIcon />
						<span className="plan-image-missing-label">{alt || "Image unavailable"}</span>
					</span>
				)
				: (
					<img
						// An omitted alt marks the image decorative, so screen readers skip it.
						alt={alt}
						aria-hidden={alt ? undefined : true}
						className="plan-image"
						loading="lazy"
						onClick={() => setSelected(true)}
						onError={() => setFailed(true)}
						referrerPolicy="no-referrer"
						src={src}
					/>
				)}
			{!disabled && (
				<button
					ref={button}
					type="button"
					contentEditable={false}
					className="plan-image-edit btn btn-icon btn-secondary"
					aria-label="Edit image"
					data-selected={selected ? "" : undefined}
					onFocus={() => setSelected(true)}
					onKeyDown={event => event.stopPropagation()}
					onClick={event => {
						event.stopPropagation();
						setEditing(true);
					}}
				>
					<PencilIcon size={14} aria-hidden="true" />
				</button>
			)}
			{editing && (
				<ImageEditor
					editor={editor}
					nodeKey={nodeKey}
					initialSrc={src}
					initialAlt={alt}
					onClose={close}
				/>
			)}
		</>
	);
}

export function renderImage(node: ImageNode): unknown {
	return <Image alt={node.getAlt()} src={node.getSrc()} nodeKey={node.getKey()} />;
}
