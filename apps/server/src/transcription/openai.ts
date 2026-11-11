import { audioFileName } from "./audio";

import type { AudioType } from "./audio";

/** What a transcription reports as it goes: words added to the end, then the whole text. */
export type TranscriptEvent = { delta: string } | { text: string };

/**
 * Turns a recording into words. A provider is one of these; nothing else here knows which. It
 * resolves once the provider has taken the recording (and rejects if it refused it), and its events
 * end with the whole text.
 */
export type Transcriber = (
	recording: { bytes: Uint8Array; type: AudioType },
	signal?: AbortSignal,
) => Promise<AsyncIterable<TranscriptEvent>>;

/** OpenAI streams the transcription of a whole file for every model but `whisper-1`. */
function streams(model: string): boolean {
	return !model.startsWith("whisper");
}

/** The JSON `data:` of one server-sent event, if it has any. */
function* eventData(block: string): Generator<unknown> {
	let data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line =>
		line.slice(5).trimStart()
	).join("\n");
	if (!data || data === "[DONE]") return;
	try {
		yield JSON.parse(data) as unknown;
	} catch {
		// Not an event this reads.
	}
}

/** The JSON `data:` of each server-sent event in a stream of them. */
async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
	let decoder = new TextDecoder();
	let pending = "";
	for await (let chunk of body) {
		pending += decoder.decode(chunk, { stream: true });
		let blocks = pending.split(/\r?\n\r?\n/);
		pending = blocks.pop()!;
		for (let block of blocks) yield* eventData(block);
	}
	yield* eventData(pending + decoder.decode());
}

/**
 * OpenAI's audio transcription: the recording is sent to `api.openai.com` with the deployment's own
 * key and the model its operator named, and the words come back as the model writes them, where it
 * streams them. Nothing is kept here.
 */
export function openaiTranscriber(
	options: { model: string; apiKey: string; fetch?: typeof fetch },
): Transcriber {
	let send = options.fetch ?? fetch;
	let stream = streams(options.model);
	return async (recording, signal) => {
		let form = new FormData();
		// Only what every model takes: `gpt-transcribe` refuses the older models' `language`, and its
		// answer is JSON by default.
		form.set("model", options.model);
		if (stream) form.set("stream", "true");
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
		if (!stream || !response.body) {
			let body = await response.json() as { text?: unknown };
			if (typeof body.text !== "string") throw new Error("transcription provider sent no text");
			let text = body.text;
			return (async function*() {
				yield { text };
			})();
		}
		let body = response.body;
		return (async function*() {
			for await (let event of serverSentEvents(body)) {
				let { type, delta, text } = event as { type?: unknown; delta?: unknown; text?: unknown };
				if (type === "transcript.text.delta" && typeof delta === "string") yield { delta };
				if (type === "transcript.text.done" && typeof text === "string") return yield { text };
			}
			throw new Error("transcription provider sent no text");
		})();
	};
}
