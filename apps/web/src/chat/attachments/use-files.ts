/**
 * The files of the message being written: `add`, their progress, `remove`, `retry`, and a send
 * that waits for them. The whole of what a composer does with files, as one hook driven by a
 * document's caps; whatever draws a chip is given `files` and these calls and keeps no state.
 *
 * What checks and uploads a file is `upload.ts`, loaded when the first file is added.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { claimsImage, refusalText } from "@chopin/protocol/attachment";

import { filesReducer, readiness, refusalFor, sentIds, viewFiles } from "./files";

import type { AttachmentLimits } from "@chopin/protocol/attachment";
import type { Chat } from "@chopin/protocol";
import type { DraftFile, FileView } from "./files";

export type FilesSettled =
	| { ok: true; ids: string[]; files: Chat.Attachment[] }
	| { ok: false; failed: FileView[] };

export type FilesControl = {
	/** The files as they are drawn: each with its state, progress and reason. */
	files: FileView[];
	/** Adds the files in order. One that cannot go is shown with why, never dropped silently. */
	add: (files: Iterable<File>) => void;
	/** Takes a file out, stopping its upload and taking back what the server already holds. */
	remove: (id: string) => void;
	/** Uploads a file that did not get through again. */
	retry: (id: string) => void;
	/** Forgets the files once a message has been sent with them. The server keeps them. */
	clear: () => void;
	/** The browser's own copy of a file, for its thumbnail. */
	source: (id: string) => File | undefined;
	uploading: number;
	failed: number;
	/** Whether every file is uploaded and fit to send (also true with none). */
	ready: boolean;
	/** The ids a send names, in the order the files were added. */
	ids: () => string[];
	/** The files as the server kept them, for the message to show before its own entry arrives. */
	sent: () => Chat.Attachment[];
	/** Resolves once no upload is running: with the ids to send, or with the files that failed. */
	settled: () => Promise<FilesSettled>;
};

type Config = {
	channelId: string;
	/** Absent where the server takes no files: `add` then does nothing. */
	limits: AttachmentLimits | undefined;
	/** False where the message is for a model that cannot read images. */
	imagesAllowed: boolean;
};

export function useFiles({ channelId, limits, imagesAllowed }: Config): FilesControl {
	let [files, dispatch] = useReducer(filesReducer, [] as readonly DraftFile[]);
	let latest = useRef(files);
	latest.current = files;
	let sources = useRef(new Map<string, { file: File; abort: AbortController }>());
	let views = useMemo(() => viewFiles(files, { imagesAllowed }), [files, imagesAllowed]);
	let state = readiness(views);
	let viewsRef = useRef(views);
	viewsRef.current = views;
	let waiting = useRef<Array<() => void>>([]);
	let room = useRef({ channelId, limits });
	room.current = { channelId, limits };

	let outcome = useCallback((): FilesSettled => {
		let failed = viewsRef.current.filter(view => view.state === "error");
		if (failed.length) return { ok: false, failed };
		return {
			ok: true,
			ids: sentIds(latest.current),
			files: latest.current.flatMap(file => file.sent ? [file.sent] : []),
		};
	}, []);

	useEffect(() => {
		if (state.uploading === 0) { for (let resolve of waiting.current.splice(0)) resolve(); }
	}, [state.uploading]);

	let start = useCallback(async (id: string) => {
		let source = sources.current.get(id);
		let { limits: caps, channelId: target } = room.current;
		if (!source || !caps) return;
		let { file, abort } = source;
		let upload = await import("./upload");
		let fail = (refusal: Parameters<typeof refusalText>[0], message: string, retry: boolean) => {
			if (!abort.signal.aborted) dispatch({ type: "failed", id, refusal, message, retry });
		};
		try {
			let inspected = await upload.inspectFile(file, caps);
			if (abort.signal.aborted) return;
			if (!inspected.ok) return fail(inspected.refusal, inspected.message, false);
			dispatch({ type: "read", id, kind: inspected.kind, mimeType: inspected.mimeType });
			let sent = await upload.uploadFile({
				channelId: target,
				file,
				name: file.name,
				signal: abort.signal,
				onProgress: progress => {
					if (!abort.signal.aborted) dispatch({ type: "progress", id, progress });
				},
			});
			if (abort.signal.aborted) {
				void upload.discardUpload(target, sent.id);
				return;
			}
			dispatch({ type: "uploaded", id, sent });
		} catch (error) {
			let failure = error as { refusal?: Parameters<typeof refusalText>[0]; retry?: boolean };
			fail(
				failure.refusal ?? "upload-failed",
				error instanceof Error ? error.message : refusalText("upload-failed", { name: file.name }),
				failure.retry ?? true,
			);
		}
	}, []);

	let add = useCallback((chosen: Iterable<File>) => {
		let caps = room.current.limits;
		if (!caps) return;
		let carried = [...latest.current];
		for (let file of chosen) {
			let id = crypto.randomUUID();
			let draft: DraftFile = {
				id,
				name: file.name || "File",
				kind: claimsImage(file.name, file.type) ? "image" : "file",
				size: file.size,
				mimeType: file.type,
				status: { type: "running", reason: "uploading", progress: 0 },
			};
			let refused = refusalFor(carried, file.size, caps);
			if (refused) {
				draft = {
					...draft,
					status: {
						type: "incomplete",
						reason: "error",
						refusal: refused.refusal,
						message: refused.message,
						retry: false,
					},
				};
			} else sources.current.set(id, { file, abort: new AbortController() });
			carried.push(draft);
			dispatch({ type: "add", file: draft });
			if (!refused) void start(id);
		}
	}, [start]);

	let remove = useCallback((id: string) => {
		let source = sources.current.get(id);
		let held = latest.current.find(file => file.id === id)?.sent;
		source?.abort.abort();
		sources.current.delete(id);
		dispatch({ type: "remove", id });
		if (held) {
			void import("./upload").then(upload => upload.discardUpload(room.current.channelId, held.id));
		}
	}, []);

	let retry = useCallback((id: string) => {
		let source = sources.current.get(id);
		if (!source) return;
		let again = { file: source.file, abort: new AbortController() };
		sources.current.set(id, again);
		dispatch({ type: "retry", id });
		void start(id);
	}, [start]);

	let clear = useCallback(() => {
		sources.current.clear();
		dispatch({ type: "clear" });
	}, []);

	// A composer that goes away stops what it was uploading; the server forgets what nobody sent.
	useEffect(() => {
		let held = sources.current;
		return () => {
			for (let { abort } of held.values()) abort.abort();
		};
	}, []);

	let settled = useCallback(
		() =>
			new Promise<void>(resolve => {
				if (readiness(viewsRef.current).uploading === 0) resolve();
				else waiting.current.push(resolve);
			}).then(outcome),
		[outcome],
	);

	return {
		files: views,
		add,
		remove,
		retry,
		clear,
		source: id => sources.current.get(id)?.file,
		uploading: state.uploading,
		failed: state.failed,
		ready: state.ready,
		ids: () => sentIds(latest.current),
		sent: () => latest.current.flatMap(file => file.sent ? [file.sent] : []),
		settled,
	};
}
