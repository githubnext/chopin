/**
 * The images and files a person is adding to a message, from the moment they are chosen to the
 * moment the message is sent: the state a composer keeps, with no browser in it.
 *
 * Each file moves from `running` (checked, then uploaded, with progress) to `complete`, or ends
 * `incomplete` with the reason in words and whether trying again could help. A file the browser
 * refuses before any upload, one over a cap, and one the document's model cannot read are
 * `incomplete` too, and are never dropped without a word: the person removes them.
 */

import { checkMessageAttachments, formatBytes, refusalText } from "@chopin/protocol/attachment";

import type {
	AttachmentKind,
	AttachmentLimits,
	AttachmentRefusal,
} from "@chopin/protocol/attachment";
import type { Chat } from "@chopin/protocol";

export type FileStatus =
	| { type: "running"; reason: "uploading"; progress: number }
	| { type: "complete" }
	| {
		type: "incomplete";
		reason: "error";
		refusal: AttachmentRefusal;
		message: string;
		retry: boolean;
	};

export type DraftFile = {
	/** This browser's own id for it, from the moment it is chosen. */
	id: string;
	name: string;
	kind: AttachmentKind;
	size: number;
	/** What the bytes are, once read; before then the type the browser declared. */
	mimeType: string;
	status: FileStatus;
	/** The file as the server kept it, once it has. */
	sent?: Chat.Attachment;
};

export type FilesAction =
	| { type: "add"; file: DraftFile }
	/** The bytes were read: what they are replaces what the name and declared type claimed. */
	| { type: "read"; id: string; kind: AttachmentKind; mimeType: string }
	| { type: "progress"; id: string; progress: number }
	| { type: "uploaded"; id: string; sent: Chat.Attachment }
	| { type: "failed"; id: string; refusal: AttachmentRefusal; message: string; retry: boolean }
	| { type: "retry"; id: string }
	| { type: "remove"; id: string }
	| { type: "clear" };

function change(
	files: readonly DraftFile[],
	id: string,
	update: (file: DraftFile) => DraftFile,
): readonly DraftFile[] {
	return files.map(file => file.id === id ? update(file) : file);
}

export function filesReducer(
	files: readonly DraftFile[],
	action: FilesAction,
): readonly DraftFile[] {
	switch (action.type) {
		case "add":
			return files.some(file => file.id === action.file.id) ? files : [...files, action.file];
		case "read":
			return change(files, action.id, file => ({
				...file,
				kind: action.kind,
				mimeType: action.mimeType,
			}));
		case "progress":
			return change(files, action.id, file =>
				file.status.type === "running"
					? { ...file, status: { ...file.status, progress: action.progress } }
					: file);
		case "uploaded":
			return change(files, action.id, file => ({
				...file,
				kind: action.sent.kind,
				mimeType: action.sent.mimeType,
				sent: action.sent,
				status: { type: "complete" },
			}));
		case "failed":
			return change(files, action.id, ({ sent: _, ...file }) => ({
				...file,
				status: {
					type: "incomplete",
					reason: "error",
					refusal: action.refusal,
					message: action.message,
					retry: action.retry,
				},
			}));
		case "retry":
			return change(files, action.id, file => ({
				...file,
				status: { type: "running", reason: "uploading", progress: 0 },
			}));
		case "remove":
			return files.filter(file => file.id !== action.id);
		case "clear":
			return files.length === 0 ? files : [];
	}
}

/** The size, count and total a file being added would bring the message to, for its refusal. */
export function refusalFor(
	files: readonly DraftFile[],
	size: number,
	limits: AttachmentLimits,
): { refusal: "too-many" | "too-much"; message: string } | undefined {
	// What was refused is not carried, so it does not count against the files that are.
	let carried = files.filter(file => file.status.type !== "incomplete").map(file => file.size);
	let refusal = checkMessageAttachments([...carried, size], limits);
	return refusal ? { refusal, message: refusalText(refusal, { limits }) } : undefined;
}

export type FileState = "uploading" | "done" | "error";

/** One file as the composer draws it. */
export type FileView = {
	id: string;
	name: string;
	kind: AttachmentKind;
	size: number;
	/** `12 KB`: the size in words, or the percent while it uploads. */
	sizeLabel: string;
	state: FileState;
	/** 0 to 100 while it uploads. */
	progress: number;
	/** Why it failed or was refused, in words. */
	error?: string;
	/** Whether trying again could help: only an upload that did not get through. */
	retry: boolean;
	/** The file as the server kept it, once it has. */
	sent?: Chat.Attachment;
};

/**
 * The files as the composer draws them. An image the document's model cannot read is shown as
 * refused whenever the message is for it, and is fine again when the message is not: the file itself
 * is untouched, so choosing the room instead brings it back.
 */
export function viewFiles(
	files: readonly DraftFile[],
	options: { imagesAllowed: boolean },
): FileView[] {
	return files.map(file => {
		let { status } = file;
		let unreadable = file.kind === "image" && !options.imagesAllowed
			&& status.type !== "incomplete";
		let base = { id: file.id, name: file.name, kind: file.kind, size: file.size };
		if (unreadable) {
			return {
				...base,
				sizeLabel: formatBytes(file.size),
				state: "error" as const,
				progress: 0,
				error: refusalText("images-unavailable"),
				retry: false,
				...(file.sent ? { sent: file.sent } : {}),
			};
		}
		if (status.type === "running") {
			return {
				...base,
				sizeLabel: `${Math.round(status.progress)}%`,
				state: "uploading" as const,
				progress: status.progress,
				retry: false,
			};
		}
		if (status.type === "incomplete") {
			return {
				...base,
				sizeLabel: formatBytes(file.size),
				state: "error" as const,
				progress: 0,
				error: status.message,
				retry: status.retry,
			};
		}
		return {
			...base,
			sizeLabel: formatBytes(file.size),
			state: "done" as const,
			progress: 100,
			retry: false,
			...(file.sent ? { sent: file.sent } : {}),
		};
	});
}

/** What stands between the files and a send: uploads still running, and files that cannot go. */
export function readiness(views: readonly FileView[]): {
	uploading: number;
	failed: number;
	ready: boolean;
} {
	let uploading = views.filter(view => view.state === "uploading").length;
	let failed = views.filter(view => view.state === "error").length;
	return { uploading, failed, ready: uploading === 0 && failed === 0 };
}

/** The ids a send names, in the order the files were added; only files the server has. */
export function sentIds(files: readonly DraftFile[]): string[] {
	return files.flatMap(file => file.sent && file.status.type === "complete" ? [file.sent.id] : []);
}

/** What a chip of the elements the composer will use takes: its name, a line under it and its state. */
export type ChipProps = {
	name: string;
	meta: string;
	state: FileState;
	progress: number;
	kind: "image" | "text";
};

export function chipProps(view: FileView): ChipProps {
	return {
		name: view.name,
		meta: view.state === "error" ? view.error ?? "" : view.sizeLabel,
		state: view.state,
		progress: view.progress,
		kind: view.kind === "image" ? "image" : "text",
	};
}

/** What a sent message's file takes: the id it is opened by, its name, size in words and kind. */
export type MessageFileProps = {
	id: string;
	name: string;
	size: string;
	kind: "image" | "file";
};

export function messageFileProps(file: Chat.Attachment): MessageFileProps {
	return { id: file.id, name: file.name, size: formatBytes(file.size), kind: file.kind };
}
