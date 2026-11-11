/**
 * The files of the message being written, above its field: assistant-ui's own staged-file chips
 * (`ComposerAttachments` and `ComposerAttachmentChip` of its Composer, copied and recorded), driven
 * by `useFiles` through props and drawn as Slack's composer draws them (`media.css`): an image as a
 * square of its picture with a ring while it uploads, any other file as a card of its type's
 * coloured icon, its name and its type, and each with its remove button on its corner. The chip has
 * no place for trying an upload again, for removing a file that did not go, or for the ring, so
 * Chopin's own are drawn there through the recorded `actions` extension point, and an image's
 * picture or a file's type takes the box of the icon through `icon`.
 */

import { useEffect, useRef, useState } from "react";
import type { ComponentType, CSSProperties } from "react";

import { CloseIcon, ImageIcon, RestartIcon, WarningIcon } from "@chopin/icons";
import {
	ComposerAttachmentChip,
	ComposerAttachments,
} from "@/components/assistant-ui/elements/composer";
import { FileKindIcon } from "../media/file-icon";
import { fileType } from "../media/layout";
import { chipProps } from "./files";
import "../media/media.css";

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

/** A file's type, as the icon of its chip. */
function typeOf(name: string): Glyph {
	let { kind } = fileType(name);
	return function Type() {
		return <FileKindIcon kind={kind} />;
	};
}

/** How far an image has uploaded, as Slack's ring over its picture. */
function Progress({ progress }: { progress: number }) {
	let done = Math.min(100, Math.max(0, progress));
	return (
		<span
			aria-hidden="true"
			className="composer-file-ring"
			style={{ "--progress": `${done}%` } as CSSProperties}
		/>
	);
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
	let types = useRef(new Map<string, Glyph>());
	let type = (name: string): Glyph => {
		let known = types.current.get(name);
		if (known) return known;
		let made = typeOf(name);
		types.current.set(name, made);
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
					let image = view.kind === "image" && view.state !== "error";
					let attachment: ComposerAttachment = {
						...chip,
						id: view.id,
						...(view.state === "error"
							? { icon: Refused }
							: view.kind === "image"
							? { icon: picture(view.id) }
							: { icon: type(view.name) }),
						...(view.state === "done" ? {} : {
							actions: (
								<>
									{image && view.state === "uploading" && <Progress progress={view.progress} />}
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
							data-kind={image ? "image" : "file"}
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
