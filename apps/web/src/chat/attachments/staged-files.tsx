/**
 * The files of the message being written, above its field: assistant-ui's own staged-file chips
 * (`ComposerAttachments` and `ComposerAttachmentChip` of its Composer, copied and recorded), driven
 * by `useFiles` through props. A chip is a file's icon, name and size, a bar along its foot while it
 * uploads, and its remove button; the chip has no place for trying an upload again or for removing a
 * file that did not go, so Chopin's own icon buttons are drawn there through the recorded `actions`
 * extension point, and an image's picture takes the box of the icon through `icon`.
 */

import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";

import { CloseIcon, ImageIcon, RestartIcon, WarningIcon } from "@chopin/icons";
import {
	ComposerAttachmentChip,
	ComposerAttachments,
} from "@/components/assistant-ui/elements/composer";
import { chipProps } from "./files";

import type { ComposerAttachment } from "@/components/assistant-ui/elements/composer";
import type { FileView } from "./files";

type Glyph = ComponentType<{ className?: string }>;

/** A file the browser or the server refused is never drawn as the picture it claimed to be. */
const Refused: Glyph = () => <WarningIcon className="icon-danger" size={16} />;

/** The browser's own URL for a file's bytes, for as long as it is drawn. */
function useFileUrl(file: File | undefined): string | undefined {
	let [url, setUrl] = useState<string>();
	useEffect(() => {
		if (!file) return setUrl(undefined);
		let made = URL.createObjectURL(file);
		setUrl(made);
		return () => URL.revokeObjectURL(made);
	}, [file]);
	return url;
}

/** The picture of one image, as the icon of its chip. */
function pictureOf(id: string, source: (id: string) => File | undefined): Glyph {
	return function Picture() {
		let url = useFileUrl(source(id));
		return url
			? <img alt="" className="composer-file-thumb" src={url} />
			: <ImageIcon size={16} />;
	};
}

export type StagedFilesProps = {
	files: readonly FileView[];
	/** The browser's own copy of a file, for its picture. */
	source: (id: string) => File | undefined;
	onRemove: (id: string) => void;
	onRetry: (id: string) => void;
};

export default function StagedFiles({ files, onRemove, onRetry, source }: StagedFilesProps) {
	// One component per image for as long as it is staged, so its picture is not made again on
	// every render.
	let pictures = useRef(new Map<string, Glyph>());
	let staged = new Set(files.map(view => view.id));
	for (let id of pictures.current.keys()) if (!staged.has(id)) pictures.current.delete(id);
	let sourceRef = useRef(source);
	sourceRef.current = source;
	let picture = (id: string): Glyph => {
		let known = pictures.current.get(id);
		if (known) return known;
		let made = pictureOf(id, id => sourceRef.current(id));
		pictures.current.set(id, made);
		return made;
	};
	let refused = files.filter(view => view.state === "error");
	return (
		<div className="composer-staging">
			{/* A reason that appears is said once; the chip shows it for as long as the file stays. */}
			<p className="sr-only" role="alert">
				{refused.map(view => `${view.name}. ${view.error}`).join(" ")}
			</p>
			<ComposerAttachments aria-label="Files to send" role="list">
				{files.map(view => {
					let chip = chipProps(view);
					let attachment: ComposerAttachment = {
						...chip,
						id: view.id,
						...(view.state === "error"
							? { icon: Refused }
							: view.kind === "image"
							? { icon: picture(view.id) }
							: {}),
						...(view.state === "done" ? {} : {
							actions: (
								<>
									{view.retry && (
										<button
											aria-label={`Try ${view.name} again`}
											className="btn btn-icon-xs btn-ghost"
											data-chopin-control=""
											onClick={() => onRetry(view.id)}
											type="button"
										>
											<RestartIcon aria-hidden="true" size={12} />
										</button>
									)}
									<button
										aria-label={`Remove ${view.name}`}
										className="btn btn-icon-xs btn-ghost"
										data-chopin-control=""
										onClick={() => onRemove(view.id)}
										type="button"
									>
										<CloseIcon aria-hidden="true" size={12} />
									</button>
								</>
							),
						}),
					};
					return (
						<ComposerAttachmentChip
							attachment={attachment}
							data-file-id={view.id}
							key={view.id}
							onRemove={onRemove}
							role="listitem"
						/>
					);
				})}
			</ComposerAttachments>
		</div>
	);
}
