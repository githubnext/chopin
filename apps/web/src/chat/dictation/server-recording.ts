/**
 * Dictation where the deployment set up server transcription, in every browser: the microphone is
 * opened when the person presses the button, a recording is made on this device, and only when they
 * stop does it go to this deployment's own server, which sends it to its transcription provider
 * and sends the words back as the provider writes them. Nothing leaves the browser before that,
 * and the recording stops by itself before it is longer than the server takes.
 */

import type { DictationFailure } from "./recognizer";

export type Recording = {
	/** Stops recording and gives back the audio, or nothing if it was discarded. */
	stop(): Promise<Blob | undefined>;
	/** Stops and throws the audio away. */
	discard(): void;
};

type Media = Pick<MediaDevices, "getUserMedia">;

/** A refusal of the microphone, as the browser names it, in the words a person reads. */
export function microphoneFailure(error: unknown): DictationFailure {
	let name = (error as { name?: string } | undefined)?.name;
	if (name === "NotAllowedError" || name === "SecurityError") return "denied";
	if (name === "NotFoundError" || name === "OverconstrainedError") return "no-device";
	return "failed";
}

/** How often the recorder hands over what it has, so its size is known as it grows. */
const SLICE_MS = 1000;

/**
 * Records until it is stopped, or until one more slice could take it past `maxBytes`, when it calls
 * `full` once: the person stops it then, so what is sent is never more than the server takes.
 */
export async function record(
	media: Media,
	Recorder: typeof MediaRecorder,
	options: { maxBytes: number; full: () => void },
): Promise<Recording> {
	let stream = await media.getUserMedia({ audio: true });
	let chunks: Blob[] = [];
	let recorder = new Recorder(stream);
	let finished = Promise.withResolvers<Blob | undefined>();
	let kept = true;
	let total = 0;
	let largest = 0;
	let told = false;
	recorder.addEventListener("dataavailable", event => {
		if (event.data.size <= 0) return;
		chunks.push(event.data);
		total += event.data.size;
		largest = Math.max(largest, event.data.size);
		// The last slice comes after the stop: room is left for it, twice over.
		if (!told && recorder.state === "recording" && total + 2 * largest > options.maxBytes) {
			told = true;
			options.full();
		}
	});
	recorder.addEventListener("stop", () => {
		for (let track of stream.getTracks()) track.stop();
		finished.resolve(
			kept && chunks.length
				? new Blob(chunks, { type: recorder.mimeType || chunks[0]!.type })
				: undefined,
		);
	});
	recorder.start(SLICE_MS);
	return {
		stop() {
			if (recorder.state !== "inactive") recorder.stop();
			return finished.promise;
		},
		discard() {
			kept = false;
			if (recorder.state !== "inactive") recorder.stop();
			else for (let track of stream.getTracks()) track.stop();
		},
	};
}

/** Why a recording was not turned into words. */
export class TranscriptionFailed extends Error {
	constructor(readonly tooLong: boolean) {
		super(tooLong ? "the recording is too long" : "the recording could not be transcribed");
	}
}

/**
 * Sends a recording to the document's transcription and gives back the words, telling `heard` what
 * has been written so far each time more comes back.
 */
export async function transcribe(
	channelId: string,
	audio: Blob,
	heard: (sofar: string) => void,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
): Promise<string> {
	let response = await fetcher(`/api/channels/${encodeURIComponent(channelId)}/transcriptions`, {
		method: "POST",
		headers: { "content-type": audio.type || "application/octet-stream" },
		body: audio,
		...(signal ? { signal } : {}),
	});
	if (!response.ok || !response.body) throw new TranscriptionFailed(response.status === 413);
	let decoder = new TextDecoder();
	let pending = "";
	let sofar = "";
	let read = (line: string): string | undefined => {
		if (!line.trim()) return undefined;
		let event = JSON.parse(line) as { delta?: unknown; text?: unknown };
		if (typeof event.text === "string") return event.text;
		if (typeof event.delta !== "string") throw new TranscriptionFailed(false);
		sofar += event.delta;
		heard(sofar);
		return undefined;
	};
	let reader = response.body.getReader();
	while (true) {
		let { done, value } = await reader.read();
		if (done) break;
		pending += decoder.decode(value, { stream: true });
		let lines = pending.split("\n");
		pending = lines.pop()!;
		for (let line of lines) {
			let text = read(line);
			if (text !== undefined) {
				void reader.cancel();
				return text;
			}
		}
	}
	let text = read(pending + decoder.decode());
	if (text === undefined) throw new TranscriptionFailed(false);
	return text;
}
