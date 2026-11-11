/**
 * Dictation where the browser has no speech recognition of its own and the deployment set up
 * server transcription: the microphone is opened when the person presses the button, a recording is
 * made on this device, and only when they stop does it go to the server, which sends it to the
 * provider named in the tooltip. Nothing leaves the browser before that.
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

export async function record(
	media: Media,
	Recorder: typeof MediaRecorder,
): Promise<Recording> {
	let stream = await media.getUserMedia({ audio: true });
	let chunks: Blob[] = [];
	let recorder = new Recorder(stream);
	let finished = Promise.withResolvers<Blob | undefined>();
	let kept = true;
	recorder.addEventListener("dataavailable", event => {
		if (event.data.size > 0) chunks.push(event.data);
	});
	recorder.addEventListener("stop", () => {
		for (let track of stream.getTracks()) track.stop();
		finished.resolve(
			kept && chunks.length
				? new Blob(chunks, { type: recorder.mimeType || chunks[0]!.type })
				: undefined,
		);
	});
	recorder.start();
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

/** Sends a recording to the document's transcription and gives back the words. */
export async function transcribe(
	channelId: string,
	audio: Blob,
	fetcher: typeof fetch = fetch,
): Promise<string> {
	let response = await fetcher(`/api/channels/${encodeURIComponent(channelId)}/transcriptions`, {
		method: "POST",
		headers: { "content-type": audio.type || "application/octet-stream" },
		body: audio,
	});
	if (!response.ok) throw new Error(`transcription answered ${response.status}`);
	let body = await response.json() as { text?: unknown };
	if (typeof body.text !== "string") throw new Error("transcription sent no text");
	return body.text;
}
