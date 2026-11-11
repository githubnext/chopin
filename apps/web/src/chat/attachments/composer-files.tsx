/**
 * The files of the message being written, above its field: an image with its thumbnail, a text file
 * with its icon, each with its name and a line under it (its size, the percent while it uploads, or
 * why it failed), a bar along its foot while it uploads, and Retry and Remove. Presentational:
 * `useFiles` owns the state and this only draws it.
 */

import { useEffect, useState } from "react";

import { CloseIcon, ImageIcon, PageIcon, RestartIcon, WarningIcon } from "@chopin/icons";

import type { FileView } from "./files";
import "./attachments.css";

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

function Leading({ view, file }: { view: FileView; file: File | undefined }) {
	let url = useFileUrl(view.kind === "image" ? file : undefined);
	return (
		<span aria-hidden="true" className="composer-file-visual" data-kind={view.kind}>
			{url
				? <img alt="" className="composer-file-thumb" src={url} />
				: view.state === "error"
				? <WarningIcon className="composer-file-glyph" size={16} />
				: view.kind === "image"
				? <ImageIcon className="composer-file-glyph" size={16} />
				: <PageIcon size={16} />}
		</span>
	);
}

export type FileStripProps = {
	files: readonly FileView[];
	/** The browser's own copy of a file, for its thumbnail. */
	source: (id: string) => File | undefined;
	onRemove: (id: string) => void;
	onRetry: (id: string) => void;
	id?: string;
};

export default function FileStrip({ files, id, onRemove, onRetry, source }: FileStripProps) {
	return (
		<ul aria-label="Files to send" className="composer-files" id={id}>
			{files.map(view => (
				<li className="composer-file" data-kind={view.kind} data-state={view.state} key={view.id}>
					<Leading file={source(view.id)} view={view} />
					<span className="composer-file-text">
						<span className="composer-file-name" title={view.name}>{view.name}</span>
						{view.state === "error"
							? (
								<span className="composer-file-meta" data-error="" role="alert">
									{view.error}
								</span>
							)
							: <span className="composer-file-meta">{view.sizeLabel}</span>}
					</span>
					{view.retry && (
						<button
							aria-label={`Try ${view.name} again`}
							className="btn btn-icon-xs btn-ghost"
							onClick={() => onRetry(view.id)}
							type="button"
						>
							<RestartIcon aria-hidden="true" size={12} />
						</button>
					)}
					<button
						aria-label={`Remove ${view.name}`}
						className="btn btn-icon-xs btn-ghost"
						onClick={() =>
							onRemove(view.id)}
						type="button"
					>
						<CloseIcon aria-hidden="true" size={12} />
					</button>
					{view.state === "uploading" && (
						<span
							aria-label={`Uploading ${view.name}`}
							aria-valuemax={100}
							aria-valuemin={0}
							aria-valuenow={Math.round(view.progress)}
							className="composer-file-progress"
							role="progressbar"
						>
							<span style={{ width: `${view.progress}%` }} />
						</span>
					)}
				</li>
			))}
		</ul>
	);
}
