/** Images load with the browser session, without sending document referrers. */

import { useEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { readOnly$ } from "@mdxeditor/editor";
import { useCellValue } from "@mdxeditor/gurx";

import { ImageIcon, PencilIcon, RestartIcon } from "@chopin/icons";

import { ImageEditor } from "./image-editor";
import { ImageLightbox } from "./image-lightbox";
import { useImageResize } from "./image-resize";

import type { ImageNode } from "@chopin/dialect";

function Image(
	{ alt, src, width, nodeKey }: { alt: string; src: string; width: number; nodeKey: string },
) {
	let [editor] = useLexicalComposerContext();
	let disabled = useCellValue(readOnly$);
	let [failed, setFailed] = useState(false);
	let [editing, setEditing] = useState(false);
	let [viewing, setViewing] = useState(false);
	let frame = useRef<HTMLSpanElement>(null);
	let editButton = useRef<HTMLButtonElement>(null);
	let viewButton = useRef<HTMLButtonElement>(null);
	let resize = useImageResize({ editor, nodeKey, src, width, disabled, frame });

	useEffect(() => {
		setFailed(false);
		setViewing(false);
		setEditing(false);
	}, [src]);
	useEffect(() => {
		if (disabled) setEditing(false);
	}, [disabled]);

	return (
		<>
			<span
				ref={frame}
				className="plan-image-frame"
				contentEditable={false}
				data-resizing={resize.preview === undefined ? undefined : ""}
				style={{ width: failed ? undefined : resize.preview ?? (width || undefined) }}
			>
				{failed
					? (
						<span aria-label={alt || "Image unavailable"} className="plan-image-missing" role="img">
							<ImageIcon />
							<span className="plan-image-missing-label">{alt || "Image unavailable"}</span>
						</span>
					)
					: (
						<button
							ref={viewButton}
							type="button"
							className="plan-image-view"
							aria-label="View image"
							aria-haspopup="dialog"
							onClick={event => {
								event.preventDefault();
								setViewing(true);
							}}
							onKeyDown={event => {
								if (!event.metaKey && !event.ctrlKey) event.stopPropagation();
							}}
						>
							<img
								alt={alt}
								aria-hidden={alt ? undefined : true}
								className="plan-image"
								loading="lazy"
								onError={() => setFailed(true)}
								referrerPolicy="no-referrer"
								src={src}
							/>
						</button>
					)}
				{!disabled && (
					<>
						<span className="plan-image-toolbar" role="group" aria-label="Image controls">
							<button
								ref={editButton}
								type="button"
								className="plan-image-edit btn btn-icon btn-secondary"
								aria-label="Edit image"
								title="Edit image"
								onKeyDown={event => event.stopPropagation()}
								onClick={event => {
									event.preventDefault();
									event.stopPropagation();
									setEditing(true);
								}}
							>
								<PencilIcon size={14} aria-hidden="true" />
							</button>
							{!failed && width > 0 && (
								<button
									type="button"
									className="btn btn-icon btn-secondary"
									aria-label="Reset image size"
									title="Reset image size"
									onClick={event => {
										event.preventDefault();
										resize.reset();
									}}
								>
									<RestartIcon size={14} aria-hidden="true" />
								</button>
							)}
						</span>
						{!failed && resize.controls}
					</>
				)}
			</span>
			{editing && (
				<ImageEditor
					editor={editor}
					nodeKey={nodeKey}
					initialSrc={src}
					initialAlt={alt}
					onClose={() => {
						setEditing(false);
						requestAnimationFrame(() => editButton.current?.focus());
					}}
				/>
			)}
			{viewing && (
				<ImageLightbox
					src={src}
					alt={alt}
					onClose={() => {
						setViewing(false);
						requestAnimationFrame(() => viewButton.current?.focus());
					}}
				/>
			)}
		</>
	);
}

export function renderImage(node: ImageNode): unknown {
	return (
		<Image
			alt={node.getAlt()}
			src={node.getSrc()}
			width={node.getWidth()}
			nodeKey={node.getKey()}
		/>
	);
}
