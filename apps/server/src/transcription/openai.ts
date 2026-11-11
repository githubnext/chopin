import { audioFileName } from "./audio";

import type { AudioType } from "./audio";

/** Turns a recording into words. A provider is one of these; nothing else here knows which. */
export type Transcriber = (
	recording: { bytes: Uint8Array; type: AudioType },
	signal?: AbortSignal,
) => Promise<string>;

/**
 * OpenAI's audio transcription: the recording is sent to `api.openai.com` with the deployment's own
 * key and the model its operator named, and the text comes back. Nothing is kept here.
 */
export function openaiTranscriber(
	options: { model: string; apiKey: string; fetch?: typeof fetch },
): Transcriber {
	let send = options.fetch ?? fetch;
	return async (recording, signal) => {
		let form = new FormData();
		form.set("model", options.model);
		form.set("response_format", "json");
		form.set(
			"file",
			new Blob([recording.bytes as BlobPart], { type: recording.type }),
			audioFileName(recording.type),
		);
		let response = await send("https://api.openai.com/v1/audio/transcriptions", {
			method: "POST",
			headers: { authorization: `Bearer ${options.apiKey}` },
			body: form,
			...(signal ? { signal } : {}),
		});
		if (!response.ok) throw new Error(`transcription provider answered ${response.status}`);
		let body = await response.json() as { text?: unknown };
		if (typeof body.text !== "string") throw new Error("transcription provider sent no text");
		return body.text;
	};
}
