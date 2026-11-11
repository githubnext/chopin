/**
 * The browser's own speech recognition, behind a small contract, and what to say when it cannot
 * be used. Nothing starts before `start()`, which is only ever the person pressing the button, and
 * audio goes nowhere but the browser's own recognizer: a browser that cannot say its recognition
 * runs on the device (`processLocally`) is treated as having none, since without it a browser may
 * send the audio to a speech service.
 */

import type { Part } from "./transcript";

/** The parts of a `SpeechRecognition` this uses, which is how a test stands one in. */
export interface NativeRecognition {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	processLocally?: boolean;
	start(): void;
	stop(): void;
	abort(): void;
	onstart: ((event: Event) => void) | null;
	onresult: ((event: NativeResultEvent) => void) | null;
	onerror: ((event: { error: string; message?: string }) => void) | null;
	onend: ((event: Event) => void) | null;
}

export type NativeResultEvent = {
	resultIndex: number;
	results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

export type RecognitionConstructor = {
	new(): NativeRecognition;
	available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
	install?: (options: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
};

type SpeechWindow = {
	SpeechRecognition?: RecognitionConstructor;
	webkitSpeechRecognition?: RecognitionConstructor;
};

/** The recognition this browser has, prefixed or not, only if it runs on the device. */
export function browserRecognition(win: SpeechWindow): RecognitionConstructor | undefined {
	let found = win.SpeechRecognition ?? win.webkitSpeechRecognition;
	return found && "processLocally" in found.prototype ? found : undefined;
}

/** Why dictation stopped without finishing, as the words a person reads. */
export type DictationFailure = "denied" | "no-device" | "language" | "network" | "failed";

export const FAILURE_WORDS: Record<DictationFailure, string> = {
	denied: "Microphone access is blocked. Allow it in your browser's settings to dictate.",
	"no-device": "No microphone was found.",
	language: "Dictation isn't available in your language on this device.",
	network: "Dictation lost its connection. Try again.",
	failed: "Dictation stopped unexpectedly. Try again.",
};

/** What a recognizer's error says, or nothing for one that is not a failure (silence, a stop). */
export function failureOf(code: string): DictationFailure | undefined {
	switch (code) {
		case "not-allowed":
		case "service-not-allowed":
			return "denied";
		case "audio-capture":
			return "no-device";
		case "language-not-supported":
			return "language";
		case "network":
			return "network";
		case "no-speech":
		case "aborted":
			return undefined;
		default:
			return "failed";
	}
}

export type RecognitionEvent =
	| { type: "listening" }
	| { type: "parts"; parts: Part[] }
	| { type: "failed"; failure: DictationFailure }
	| { type: "ended" };

export type Recognizer = {
	/** Starts listening. The browser asks for the microphone now, and not before. */
	start(): Promise<void>;
	/** Stops listening and reports what is left, then ends. */
	stop(): void;
	/** Stops at once and reports nothing more. */
	abort(): void;
};

export function createRecognizer(
	Native: RecognitionConstructor,
	options: { lang: string },
	emit: (event: RecognitionEvent) => void,
): Recognizer {
	let recognition = new Native();
	let silenced = false;
	recognition.lang = options.lang;
	recognition.continuous = true;
	recognition.interimResults = true;
	recognition.processLocally = true;
	recognition.onstart = () => emit({ type: "listening" });
	recognition.onresult = event => {
		if (silenced) return;
		let parts: Part[] = [];
		for (let index = event.resultIndex; index < event.results.length; index++) {
			let result = event.results[index]!;
			parts.push({ transcript: result[0].transcript, final: result.isFinal });
		}
		if (parts.length) emit({ type: "parts", parts });
	};
	recognition.onerror = event => {
		let failure = failureOf(event.error);
		if (failure && !silenced) emit({ type: "failed", failure });
	};
	recognition.onend = () => emit({ type: "ended" });
	return {
		async start() {
			// A device that has no model for the language is asked to fetch one, if it can, before
			// the microphone is: nothing is heard until it is there.
			let langs = [options.lang];
			if (Native.available) {
				let state = await Native.available({ langs, processLocally: true }).catch(() =>
					"available"
				);
				if (state === "unavailable") return void emit({ type: "failed", failure: "language" });
				if (state === "downloadable") {
					let installed = await Native.install?.({ langs, processLocally: true }).catch(() =>
						false
					);
					if (installed === false) return void emit({ type: "failed", failure: "language" });
				}
			}
			recognition.start();
		},
		stop() {
			recognition.stop();
		},
		abort() {
			silenced = true;
			recognition.abort();
		},
	};
}
