import { describe, expect, it } from "bun:test";

import { browserRecognition, createRecognizer, FAILURE_WORDS, failureOf } from "./recognizer";
import { begin, flush, follow, merge, shown } from "./transcript";
import { record, transcribe, TranscriptionFailed } from "./server-recording";
import { dictationSource } from "./use-dictation";

import type { NativeRecognition, NativeResultEvent, RecognitionEvent } from "./recognizer";

/**
 * A stand-in for the browser's recognizer, as the Web Speech API reports itself: a list of results
 * that grows, a `resultIndex` saying which ones changed, and events when it starts, hears, fails
 * and ends. It listens to nothing: a test says what it heard.
 */
class FakeRecognition implements NativeRecognition {
	static instances: FakeRecognition[] = [];
	static availability: string | undefined;
	static installs = 0;
	static available = async () => FakeRecognition.availability ?? "available";
	static install = async () => {
		FakeRecognition.installs++;
		return true;
	};
	lang = "";
	continuous = false;
	interimResults = false;
	processLocally: boolean | undefined;
	started = 0;
	stopped = 0;
	aborted = 0;
	onstart: NativeRecognition["onstart"] = null;
	onresult: NativeRecognition["onresult"] = null;
	onerror: NativeRecognition["onerror"] = null;
	onend: NativeRecognition["onend"] = null;
	#results: Array<{ isFinal: boolean; 0: { transcript: string } }> = [];
	constructor() {
		FakeRecognition.instances.push(this);
	}
	get processLocallyInPrototype() {
		return true;
	}
	start() {
		this.started++;
		this.onstart?.(new Event("start"));
	}
	stop() {
		this.stopped++;
		this.onend?.(new Event("end"));
	}
	abort() {
		this.aborted++;
		this.onend?.(new Event("end"));
	}
	/** The browser reports what it heard: results from `index` changed. */
	hear(...heard: Array<[string, boolean]>) {
		let index = this.#results.length;
		for (let [transcript, isFinal] of heard) this.#results.push({ isFinal, 0: { transcript } });
		this.onresult?.({ resultIndex: index, results: this.#results } as NativeResultEvent);
	}
	/** The recognizer firms up the last result it was working on, then says more. */
	settleLast(transcript: string, ...more: Array<[string, boolean]>) {
		let index = this.#results.length - 1;
		this.#results[index] = { isFinal: true, 0: { transcript } };
		for (let [text, isFinal] of more) this.#results.push({ isFinal, 0: { transcript: text } });
		this.onresult?.({ resultIndex: index, results: this.#results } as NativeResultEvent);
	}
}
Object.defineProperty(FakeRecognition.prototype, "processLocally", {
	value: undefined,
	writable: true,
});

function recognizer() {
	FakeRecognition.instances = [];
	FakeRecognition.availability = undefined;
	FakeRecognition.installs = 0;
	let events: RecognitionEvent[] = [];
	let made = createRecognizer(FakeRecognition, { lang: "en-US" }, event => events.push(event));
	return { made, events, native: () => FakeRecognition.instances[0]! };
}

describe("words a person says, put in the draft where they were", () => {
	it("writes what is final at the caret, with a space where typing would put one", () => {
		let state = begin(5);
		let said = merge("Hello world", state, [{ transcript: " brave ", final: true }]);
		expect(said).toMatchObject({ text: "Hello brave world", caret: 11, changed: true });
		expect(said.state).toEqual({ anchor: 11, interim: "" });
	});

	it("shows what is interim beside the caret without writing it, and replaces it with the next report", () => {
		let first = merge("Plan: ", begin(6), [{ transcript: "add the", final: false }]);
		expect(first).toMatchObject({ text: "Plan: ", changed: false });
		expect(first.state).toEqual({ anchor: 6, interim: "add the" });
		expect(shown("Plan: ", first.state)).toEqual({ at: 6, text: "add the" });
		let second = merge("Plan: ", first.state, [{ transcript: "add the cap", final: false }]);
		expect(second.state.interim).toBe("add the cap");
		// What was final stays, what was interim is gone: the words come back as final.
		let done = merge("Plan: ", second.state, [{ transcript: "add the cap", final: true }]);
		expect(done.text).toBe("Plan: add the cap");
		expect(done.state).toEqual({ anchor: 17, interim: "" });
		expect(shown(done.text, done.state)).toBeUndefined();
	});

	it("runs finals one after another and leaves what is around the caret alone", () => {
		let said = merge("Start  end", begin(6), [
			{ transcript: "one", final: true },
			{ transcript: "two", final: true },
			{ transcript: "three", final: false },
		]);
		expect(said.text).toBe("Start one two end");
		expect(said.state).toEqual({ anchor: 13, interim: "three" });
		// The next report goes where the last words ended.
		let more = merge(said.text, said.state, [{ transcript: "four", final: true }]);
		expect(more.text).toBe("Start one two four end");
	});

	it("spaces by what is around: none at the start, none before punctuation, none after a space", () => {
		expect(merge("", begin(0), [{ transcript: "Hello", final: true }]).text).toBe("Hello");
		expect(merge("Hello", begin(5), [{ transcript: ", world", final: true }]).text).toBe(
			"Hello, world",
		);
		expect(merge("Hello ", begin(6), [{ transcript: "world", final: true }]).text).toBe(
			"Hello world",
		);
		expect(merge("Hello\nworld", begin(6), [{ transcript: "big", final: true }]).text).toBe(
			"Hello\nbig world",
		);
		expect(merge("Hello.", begin(5), [{ transcript: "again", final: true }]).text).toBe(
			"Hello again.",
		);
	});

	it("says nothing for an empty result, and keeps an anchor that the draft has shrunk under", () => {
		expect(merge("Hi", begin(2), [{ transcript: "  ", final: true }])).toMatchObject({
			text: "Hi",
			changed: false,
		});
		expect(merge("Hi", { anchor: 40, interim: "" }, [{ transcript: "there", final: true }]).text)
			.toBe(
				"Hi there",
			);
	});

	it("follows the person's caret and drops what was only shown", () => {
		let state = { anchor: 6, interim: "add the cap" };
		expect(follow(state, 2)).toEqual({ anchor: 2, interim: "" });
		// The caret the words just written put it at is not the person moving it.
		let same = { anchor: 2, interim: "still said" };
		expect(follow(same, 2)).toBe(same);
	});

	it("settles what is shown when a message is sent mid-sentence, so what they saw is what goes", () => {
		let settled = flush("Plan: ", { anchor: 6, interim: "add the cap" });
		expect(settled).toMatchObject({ text: "Plan: add the cap", caret: 17, changed: true });
		expect(flush("Plan: ", begin(6))).toMatchObject({ text: "Plan: ", changed: false });
	});
});

describe("the browser's recognition, as dictation uses it", () => {
	it("is used only where it runs on the device, prefixed or not", () => {
		expect(browserRecognition({})).toBeUndefined();
		let withLocal = class extends FakeRecognition {};
		Object.defineProperty(withLocal.prototype, "processLocally", { value: false, writable: true });
		expect(browserRecognition({ SpeechRecognition: withLocal })).toBe(withLocal);
		expect(browserRecognition({ webkitSpeechRecognition: withLocal })).toBe(withLocal);
		let remoteOnly = class {} as never;
		expect(browserRecognition({ SpeechRecognition: remoteOnly })).toBeUndefined();
	});

	it("asks nothing of the microphone until it is started, then turns the browser's reports into parts", async () => {
		let { made, events, native } = recognizer();
		expect(native().started).toBe(0);
		expect(native()).toMatchObject({
			lang: "en-US",
			continuous: true,
			interimResults: true,
			processLocally: true,
		});
		await made.start();
		expect(native().started).toBe(1);
		native().hear(["hello wor", false]);
		native().settleLast("hello world", ["and more", false]);
		expect(events).toEqual([
			{ type: "listening" },
			{ type: "parts", parts: [{ transcript: "hello wor", final: false }] },
			{
				type: "parts",
				parts: [
					{ transcript: "hello world", final: true },
					{ transcript: "and more", final: false },
				],
			},
		]);
	});

	it("runs a whole utterance through the merge: interim, then final, at the caret and around the words", async () => {
		FakeRecognition.instances = [];
		FakeRecognition.availability = undefined;
		let text = "Please  today";
		let state = begin(7);
		let heard = createRecognizer(FakeRecognition, { lang: "en-US" }, event => {
			if (event.type !== "parts") return;
			let merged = merge(text, state, event.parts);
			text = merged.text;
			state = merged.state;
		});
		await heard.start();
		let native = FakeRecognition.instances[0]!;
		native.hear(["ship the", false]);
		expect(text).toBe("Please  today");
		expect(shown(text, state)).toEqual({ at: 7, text: "ship the" });
		native.settleLast("ship the");
		expect(text).toBe("Please ship the today");
		expect(shown(text, state)).toBeUndefined();
		native.hear(["cap fix", false]);
		expect(shown(text, state)).toEqual({ at: 15, text: " cap fix" });
		native.settleLast("cap fix");
		expect(text).toBe("Please ship the cap fix today");
	});

	it("stops by asking the browser for what is left, and at once without it", async () => {
		let { made, events, native } = recognizer();
		await made.start();
		made.stop();
		expect(native().stopped).toBe(1);
		expect(events.at(-1)).toEqual({ type: "ended" });
		let second = recognizer();
		await second.made.start();
		second.made.abort();
		expect(second.native().aborted).toBe(1);
		// Nothing it says after an abort is reported as a failure or as words.
		second.native().hear(["late", true]);
		second.native().onerror?.({ error: "network" });
		expect(second.events.filter(event => event.type === "parts" || event.type === "failed"))
			.toEqual([]);
	});

	it("reports a failure in plain words: a blocked microphone, none, a language, the network", async () => {
		for (
			let [code, failure] of [
				["not-allowed", "denied"],
				["service-not-allowed", "denied"],
				["audio-capture", "no-device"],
				["language-not-supported", "language"],
				["network", "network"],
				["bad-grammar", "failed"],
			] as const
		) {
			expect(failureOf(code)).toBe(failure);
		}
		// Silence and a stop are not failures.
		expect(failureOf("no-speech")).toBeUndefined();
		expect(failureOf("aborted")).toBeUndefined();
		let { made, events, native } = recognizer();
		await made.start();
		native().onerror?.({ error: "not-allowed" });
		expect(events.at(-1)).toEqual({ type: "failed", failure: "denied" });
		expect(FAILURE_WORDS.denied).toBe(
			"Microphone access is blocked. Allow it in your browser's settings to dictate.",
		);
		expect(FAILURE_WORDS["no-device"]).toBe("No microphone was found.");
	});

	it("does not start where the device has no model for the language, and fetches one it can", async () => {
		FakeRecognition.instances = [];
		FakeRecognition.availability = "unavailable";
		let events: RecognitionEvent[] = [];
		let made = createRecognizer(FakeRecognition, { lang: "xx" }, event => events.push(event));
		await made.start();
		expect(FakeRecognition.instances[0]!.started).toBe(0);
		expect(events).toEqual([{ type: "failed", failure: "language" }]);

		FakeRecognition.instances = [];
		FakeRecognition.availability = "downloadable";
		FakeRecognition.installs = 0;
		let again = createRecognizer(FakeRecognition, { lang: "en-US" }, () => {});
		await again.start();
		expect(FakeRecognition.installs).toBe(1);
		expect(FakeRecognition.instances[0]!.started).toBe(1);

		let WithoutInstall = class extends FakeRecognition {
			static override install = undefined as never;
		};
		FakeRecognition.instances = [];
		FakeRecognition.availability = "downloadable";
		let missingInstall: RecognitionEvent[] = [];
		await createRecognizer(WithoutInstall, { lang: "xx" }, event => missingInstall.push(event))
			.start();
		expect(FakeRecognition.instances[0]!.started).toBe(0);
		expect(missingInstall).toEqual([{ type: "failed", failure: "language" }]);
	});
});

describe("choosing where speech becomes words", () => {
	let Recorder = {} as unknown as typeof MediaRecorder;
	let media = { getUserMedia: async () => ({}) };

	it("uses server transcription in every browser where the deployment configured it, never the browser's recognizer", () => {
		let server = { provider: "OpenAI", maxBytes: 5_242_880 };
		expect(
			dictationSource(
				{ SpeechRecognition: FakeRecognition, MediaRecorder: Recorder },
				media,
				server,
			),
		).toEqual({ kind: "server", provider: "OpenAI", maxBytes: 5_242_880 });
		expect(dictationSource({ MediaRecorder: Recorder }, media, server)).toEqual({
			kind: "server",
			provider: "OpenAI",
			maxBytes: 5_242_880,
		});
		// Never falls back to the browser's recognizer where server transcription is configured.
		expect(dictationSource({ SpeechRecognition: FakeRecognition }, media, server)).toBeUndefined();
		expect(
			dictationSource(
				{ SpeechRecognition: FakeRecognition, MediaRecorder: Recorder },
				undefined,
				server,
			),
		).toBeUndefined();
	});

	it("waits until the server has said whether transcription is configured, and uses on-device recognition only where it is off", () => {
		expect(
			dictationSource({ SpeechRecognition: FakeRecognition, MediaRecorder: Recorder }, media, null),
		).toBeUndefined();
		expect(
			dictationSource(
				{ SpeechRecognition: FakeRecognition, MediaRecorder: Recorder },
				media,
				undefined,
			),
		).toEqual({ kind: "browser", Native: FakeRecognition });
		expect(dictationSource({ MediaRecorder: Recorder }, media, undefined)).toBeUndefined();
	});
});

/** A `MediaRecorder` that records nothing: the spec hands it what it "heard", a slice at a time. */
class FakeRecorder extends EventTarget {
	static made: FakeRecorder[] = [];
	state: "inactive" | "recording" = "inactive";
	mimeType = "audio/webm;codecs=opus";
	slice: number | undefined;
	constructor(readonly stream: { stopped: number }) {
		super();
		FakeRecorder.made.push(this);
	}
	start(slice?: number) {
		this.slice = slice;
		this.state = "recording";
	}
	/** One slice of what the recorder heard, as `dataavailable` hands it over. */
	hear(bytes: number) {
		this.dispatchEvent(
			Object.assign(new Event("dataavailable"), { data: new Blob([new Uint8Array(bytes)]) }),
		);
	}
	stop() {
		this.state = "inactive";
		this.hear(10);
		this.dispatchEvent(new Event("stop"));
	}
}

function microphone() {
	let stream = { stopped: 0, getTracks: () => [{ stop: () => stream.stopped++ }] };
	return {
		stream,
		media: { getUserMedia: async () => stream as unknown as MediaStream },
	};
}

/** A transcription route that answers the way this deployment's does, in pieces cut anywhere. */
function standIn(pieces: string[], status = 200) {
	let seen: Array<{ url: string; method?: string; type: string | null; size: number }> = [];
	let fetcher = (async (url: string, init: RequestInit) => {
		seen.push({
			url,
			method: init.method,
			type: new Headers(init.headers).get("content-type"),
			size: (init.body as Blob).size,
		});
		let encoder = new TextEncoder();
		return new Response(
			new ReadableStream({
				start(controller) {
					for (let piece of pieces) controller.enqueue(encoder.encode(piece));
					controller.close();
				},
			}),
			{ status },
		);
	}) as unknown as typeof fetch;
	return { seen, fetcher };
}

describe("a recording, through the deployment's transcription", () => {
	it("records in slices until stopped, then gives back all of it and lets go of the microphone", async () => {
		FakeRecorder.made = [];
		let { stream, media } = microphone();
		let full = 0;
		let recording = await record(media, FakeRecorder as unknown as typeof MediaRecorder, {
			maxBytes: 1000,
			full: () => full++,
		});
		let recorder = FakeRecorder.made[0]!;
		expect(recorder.slice).toBe(1000);
		recorder.hear(100);
		recorder.hear(100);
		let audio = await recording.stop();
		expect(audio?.size).toBe(210);
		expect(audio?.type).toBe("audio/webm;codecs=opus");
		expect(stream.stopped).toBe(1);
		expect(full).toBe(0);
	});

	it("says it is full once, before one more slice could take it past what the server takes", async () => {
		FakeRecorder.made = [];
		let { media } = microphone();
		let full = 0;
		let recording = await record(media, FakeRecorder as unknown as typeof MediaRecorder, {
			maxBytes: 999,
			full: () => full++,
		});
		let recorder = FakeRecorder.made[0]!;
		recorder.hear(200);
		recorder.hear(200);
		expect(full).toBe(0);
		// 600 heard, and two more slices of 200 would make 1000, past 999: it stops here, not past it.
		recorder.hear(200);
		expect(full).toBe(1);
		recorder.hear(200);
		expect(full).toBe(1);
		let audio = await recording.stop();
		expect(audio!.size).toBeLessThanOrEqual(999);
	});

	it("throws a discarded recording away", async () => {
		FakeRecorder.made = [];
		let { stream, media } = microphone();
		let recording = await record(media, FakeRecorder as unknown as typeof MediaRecorder, {
			maxBytes: 1000,
			full: () => {},
		});
		FakeRecorder.made[0]!.hear(100);
		recording.discard();
		expect(await recording.stop()).toBeUndefined();
		expect(stream.stopped).toBe(1);
	});

	it("sends the recording to the document's own route and tells each word as it comes back", async () => {
		let { seen, fetcher } = standIn([
			'{"delta":" Ship"}\n{"del',
			'ta":" it"}\n',
			'{"text":"Ship it."}\n',
		]);
		let heard: string[] = [];
		let audio = new Blob([new Uint8Array(42)], { type: "audio/webm" });
		expect(await transcribe("room/1", audio, sofar => heard.push(sofar), undefined, fetcher)).toBe(
			"Ship it.",
		);
		expect(heard).toEqual([" Ship", " Ship it"]);
		expect(seen).toEqual([{
			url: "/api/channels/room%2F1/transcriptions",
			method: "POST",
			type: "audio/webm",
			size: 42,
		}]);
	});

	it("fails plainly: too long for the server, a provider that stopped part way, or no words at the end", async () => {
		let audio = new Blob([new Uint8Array(1)], { type: "audio/webm" });
		let tooLong = await transcribe("r", audio, () => {}, undefined, standIn([], 413).fetcher)
			.catch(error => error);
		expect(tooLong).toBeInstanceOf(TranscriptionFailed);
		expect(tooLong.tooLong).toBe(true);
		for (
			let pieces of [
				['{"delta":"half"}\n{"error":"the recording could not be transcribed"}\n'],
				['{"delta":"half"}\n'],
			]
		) {
			let failed = await transcribe("r", audio, () => {}, undefined, standIn(pieces).fetcher)
				.catch(error => error);
			expect(failed).toBeInstanceOf(TranscriptionFailed);
			expect(failed.tooLong).toBe(false);
		}
		let refused = await transcribe("r", audio, () => {}, undefined, standIn([], 502).fetcher)
			.catch(error => error);
		expect(refused.tooLong).toBe(false);
	});
});
