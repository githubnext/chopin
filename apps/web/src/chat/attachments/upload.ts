/**
 * Checking a file in the browser and sending its bytes to the server, which checks it again. No
 * React: `add`, progress, `remove` and retry of the composer are these functions, so whatever draws
 * a chip is driven by the same calls.
 */

import {
	attachmentPath,
	attachmentsPath,
	checkAttachment,
	checkAttachmentSize,
	refusalText,
} from "@chopin/protocol/attachment";

import type {
	AttachmentKind,
	AttachmentLimits,
	AttachmentRefusal,
} from "@chopin/protocol/attachment";
import type { Chat } from "@chopin/protocol";

/** An upload the server turned down, or that never reached it. */
export class UploadError extends Error {
	constructor(
		readonly refusal: AttachmentRefusal,
		message: string,
		/** Whether sending it again could help: it did not get through, rather than being refused. */
		readonly retry: boolean,
	) {
		super(message);
		this.name = "UploadError";
	}
}

export type Inspected =
	| { ok: true; kind: AttachmentKind; mimeType: string }
	| { ok: false; refusal: AttachmentRefusal; message: string };

/**
 * What a file is, before any upload: its size against the cap first (so a large file is never
 * read), then its bytes, by the same check the server makes.
 */
export async function inspectFile(file: File, limits: AttachmentLimits): Promise<Inspected> {
	let size = checkAttachmentSize(file.size, limits);
	if (size) {
		return { ok: false, refusal: size, message: refusalText(size, { name: file.name, limits }) };
	}
	let bytes = new Uint8Array(await file.arrayBuffer());
	let checked = checkAttachment({ name: file.name, type: file.type, bytes }, limits);
	if (!checked.ok) {
		return {
			ok: false,
			refusal: checked.reason,
			message: refusalText(checked.reason, { name: file.name, limits }),
		};
	}
	return { ok: true, kind: checked.kind, mimeType: checked.mimeType };
}

/** The part of an `XMLHttpRequest` an upload uses, so a test can stand in for it. */
export type UploadRequest =
	& Pick<
		XMLHttpRequest,
		"open" | "send" | "abort" | "setRequestHeader" | "status" | "responseText"
	>
	& {
		upload: { addEventListener(type: "progress", listener: (event: ProgressEvent) => void): void };
		addEventListener(type: "load" | "error" | "abort", listener: () => void): void;
	};

export type UploadInput = {
	channelId: string;
	file: File;
	name: string;
	signal?: AbortSignal;
	/** 0 to 100, as the bytes go. */
	onProgress?: (percent: number) => void;
	request?: () => UploadRequest;
};

function failure(request: UploadRequest, name: string): UploadError {
	let body: { reason?: unknown; error?: unknown } = {};
	try {
		body = JSON.parse(request.responseText) as typeof body;
	} catch { /* Not the server's own answer: a proxy's page, say. */ }
	let reason = typeof body.reason === "string" ? body.reason as AttachmentRefusal : undefined;
	if (reason) {
		let message = typeof body.error === "string" && body.error
			? body.error
			: refusalText(reason, { name });
		return new UploadError(reason, message, false);
	}
	// A refusal the server did not give a reason for: its own trouble, which may pass.
	return new UploadError(
		"upload-failed",
		refusalText("upload-failed", { name }),
		request.status >= 500,
	);
}

/** Sends one file's bytes, answering with the file as the server kept it. */
export function uploadFile(input: UploadInput): Promise<Chat.Attachment> {
	let { channelId, file, name } = input;
	return new Promise((resolve, reject) => {
		let request = (input.request ?? (() => new XMLHttpRequest() as unknown as UploadRequest))();
		let query = `name=${encodeURIComponent(name)}&type=${encodeURIComponent(file.type)}`;
		request.open("POST", `${attachmentsPath(channelId)}?${query}`);
		request.setRequestHeader("content-type", "application/octet-stream");
		request.upload.addEventListener("progress", event => {
			if (event.lengthComputable && event.total > 0) {
				input.onProgress?.(Math.min(100, Math.round(event.loaded / event.total * 100)));
			}
		});
		request.addEventListener("load", () => {
			if (request.status === 201) {
				try {
					resolve((JSON.parse(request.responseText) as { attachment: Chat.Attachment }).attachment);
					return;
				} catch { /* Answered, but not as a file the server kept. */ }
			}
			reject(failure(request, name));
		});
		request.addEventListener(
			"error",
			() => reject(new UploadError("upload-failed", refusalText("upload-failed", { name }), true)),
		);
		request.addEventListener(
			"abort",
			() => reject(new UploadError("upload-failed", "The upload was stopped.", false)),
		);
		let stop = () => request.abort();
		if (input.signal?.aborted) return stop();
		input.signal?.addEventListener("abort", stop, { once: true });
		request.send(file);
	});
}

/** Takes back a file that was uploaded and not sent. A failure leaves bytes nobody can read. */
export async function discardUpload(
	channelId: string,
	id: string,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	try {
		await fetcher(attachmentPath(channelId, id), { method: "DELETE" });
	} catch { /* The server forgets an upload nobody sent within a day. */ }
}
