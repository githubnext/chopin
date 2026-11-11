import { describe, expect, it } from "bun:test";

import { browserRecognition, createRecognizer, FAILURE_WORDS, failureOf } from "./recognizer";
import { begin, flush, follow, merge, shown } from "./transcript";

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
	});
});
