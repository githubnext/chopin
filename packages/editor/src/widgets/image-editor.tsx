import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { $getNodeByKey } from "lexical";

import { $isImageNode, HOSTED_IMAGE_PATH, IMAGE_PROTOCOLS } from "@chopin/dialect";

import { checkUrl } from "../toolbar/url";

import type { LexicalEditor } from "lexical";

const RULES = { protocols: IMAGE_PROTOCOLS, relative: HOSTED_IMAGE_PATH };

export function ImageEditor(
	{ editor, nodeKey, initialSrc, initialAlt, onClose }: {
		editor: LexicalEditor;
		nodeKey: string;
		initialSrc: string;
		initialAlt: string;
		onClose: () => void;
	},
) {
	let dialog = useRef<HTMLDialogElement>(null);
	let urlField = useRef<HTMLInputElement>(null);
	let problemId = useId();
	let [url, setUrl] = useState(initialSrc);
	let [alt, setAlt] = useState(initialAlt);
	let [problem, setProblem] = useState<string>();

	useLayoutEffect(() => {
		let element = dialog.current;
		if (!element?.open) element?.showModal();
		urlField.current?.focus();
		return () => {
			if (element?.open) element.close();
		};
	}, []);

	return createPortal(
		<dialog
			ref={dialog}
			aria-label="Edit image"
			className="plan-image-editor"
			data-focus-boundary=""
			onCancel={event => {
				event.preventDefault();
				onClose();
			}}
		>
			<form
				noValidate
				onSubmit={event => {
					event.preventDefault();
					let checked = checkUrl(url, RULES);
					if (!checked.url) return setProblem(checked.problem);
					let updated = false;
					editor.update(() => {
						let image = $getNodeByKey(nodeKey);
						if (!$isImageNode(image)) return;
						image.setSrc(checked.url).setAlt(alt);
						updated = true;
					}, { discrete: true });
					if (updated) onClose();
					else setProblem("This image is no longer in the document.");
				}}
			>
				<h2 className="text-lg font-semibold">Edit image</h2>
				<label className="plan-image-editor-field text-sm">
					Image URL
					<input
						ref={urlField}
						aria-describedby={problem ? problemId : undefined}
						aria-invalid={problem ? true : undefined}
						className="field"
						inputMode="url"
						spellCheck={false}
						type="text"
						value={url}
						onChange={event => {
							setUrl(event.target.value);
							setProblem(undefined);
						}}
					/>
				</label>
				<label className="plan-image-editor-field text-sm">
					Alternative text
					<input
						className="field"
						type="text"
						value={alt}
						onChange={event => setAlt(event.target.value)}
					/>
				</label>
				<p className="text-xs text-text-tertiary">Leave empty for a decorative image.</p>
				{problem && (
					<p id={problemId} className="text-xs text-destructive-ink" role="alert">{problem}</p>
				)}
				<div className="plan-image-editor-actions">
					<button className="btn btn-sm btn-ghost" type="button" onClick={onClose}>
						Cancel
					</button>
					<button className="btn btn-sm btn-primary" type="submit">Save</button>
				</div>
			</form>
		</dialog>,
		document.body,
	);
}
