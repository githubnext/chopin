/**
 * Dictation as a hook: one button's worth of state. A press starts listening (only then does the
 * browser ask for the microphone), speech is written into the draft at the caret as it settles
 * and shown beside the caret while it is interim, and listening stops on another press, on
 * Escape, on send, when the page is hidden, and when the composer goes. Nothing runs in the
 * background, and what an event reports after a stop is ignored.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { browserRecognition, createRecognizer, FAILURE_WORDS } from "./recognizer";
import { begin, flush, follow, merge, shown } from "./transcript";

import type { DictationFailure, RecognitionConstructor, Recognizer } from "./recognizer";
import type { Dictation } from "./transcript";

export type DictationSource =
	| { kind: "browser"; Native: RecognitionConstructor }
	| { kind: "server"; provider: string };

/**
 * Where speech is turned into words: the browser's own recognition if it runs on the device,
 * else the deployment's transcription if it set one up, else nowhere, and there is no button.
 */
export function dictationSource(
	win: Parameters<typeof browserRecognition>[0] & { MediaRecorder?: unknown },
	media: unknown,
	transcription: { provider: string } | undefined,
): DictationSource | undefined {
	let Native = browserRecognition(win);
	if (Native) return { kind: "browser", Native };
	return transcription && win.MediaRecorder && media
		? { kind: "server", provider: transcription.provider }
		: undefined;
}

export type DictationPhase = "idle" | "starting" | "listening" | "transcribing";

export type DictationControl = {
	source: "browser" | "server";
	phase: DictationPhase;
	/** Seconds of speech so far, while listening. */
	seconds: number;
	/** What is being said and not yet settled, and where it is shown. */
	interim: { at: number; text: string } | undefined;
	/** Why it stopped, in words; until the next press or until it is dismissed. */
	failure: string | undefined;
	dismiss: () => void;
	/** What a screen reader is told of it: started, stopped, or why not. */
	announcement: string;
	toggle: () => void;
	/** Starts listening, as pressing the button does while it is idle. */
	start: () => void;
	/** Stops, as Escape does. */
	stop: () => void;
	/** The person typed or moved the caret. */
	follow: (caret: number) => void;
	/** Settles what is shown into `text` and stops listening, for a message sent while speaking. */
	settle: (text: string) => { text: string; at: number; caret: number } | undefined;
	active: boolean;
};

type Draft = { text: string; caret: number };

export function useDictation(options: {
	source: DictationSource | undefined;
	room: string;
	lang: string;
	read: () => Draft;
	/** Puts `text` in the draft: `from` is where words were added, `caret` where it ends up. */
	write: (text: string, caret: number, from: number) => void;
}): DictationControl | undefined {
	let { source, room } = options;
	let latest = useRef(options);
	latest.current = options;
	let [phase, setPhase] = useState<DictationPhase>("idle");
	let [seconds, setSeconds] = useState(0);
	let [failure, setFailure] = useState<string>();
	let [announcement, setAnnouncement] = useState("");
	let [state, setState] = useState<Dictation>(() => begin(0));
	let current = useRef<Dictation>(state);
	let recognizer = useRef<Recognizer>(undefined);
	let recording = useRef<import("./server-recording").Recording>(undefined);
	let running = useRef(false);
	let timer = useRef<ReturnType<typeof setInterval>>(undefined);

	let update = useCallback((next: Dictation) => {
		current.current = next;
		setState(next);
	}, []);

	let finish = useCallback((words?: string) => {
		running.current = false;
		clearInterval(timer.current);
		recognizer.current = undefined;
		recording.current = undefined;
		setPhase("idle");
		setSeconds(0);
		// A failure is told by its own alert, which a screen reader hears once; only a plain stop is announced here.
		if (words) setFailure(words);
		setAnnouncement(words ? "" : "Dictation stopped");
		update({ anchor: current.current.anchor, interim: "" });
	}, [update]);

	let report = useCallback((spoken: string, final: boolean) => {
		let { text } = latest.current.read();
		let from = Math.min(current.current.anchor, text.length);
		let merged = merge(text, current.current, [{ transcript: spoken, final }]);
		if (merged.changed) latest.current.write(merged.text, merged.caret, from);
		update(merged.state);
	}, [update]);

	let startBrowser = useCallback((Native: RecognitionConstructor) => {
		let made = createRecognizer(Native, { lang: latest.current.lang }, event => {
			if (made !== recognizer.current) return;
			switch (event.type) {
				case "listening":
					setPhase("listening");
					setAnnouncement("Dictation started");
					timer.current = setInterval(() => setSeconds(value => value + 1), 1000);
					return;
				case "parts": {
					let { text } = latest.current.read();
					let from = Math.min(current.current.anchor, text.length);
					let merged = merge(text, current.current, event.parts);
					if (merged.changed) latest.current.write(merged.text, merged.caret, from);
					update(merged.state);
					return;
				}
				case "failed":
					finish(FAILURE_WORDS[event.failure]);
					return;
				case "ended": {
					// What was still being said when it stopped stays: the person saw it.
					let { text } = latest.current.read();
					let from = Math.min(current.current.anchor, text.length);
					let settled = flush(text, current.current);
					if (settled.changed) latest.current.write(settled.text, settled.caret, from);
					finish();
				}
			}
		});
		recognizer.current = made;
		void made.start().catch(() => finish(FAILURE_WORDS.failed));
	}, [finish, update]);

	let startServer = useCallback(async () => {
		let { record, microphoneFailure } = await import("./server-recording");
		try {
			let made = await record(navigator.mediaDevices, MediaRecorder);
			if (!running.current) return made.discard();
			recording.current = made;
			setPhase("listening");
			setAnnouncement("Dictation started");
			timer.current = setInterval(() => setSeconds(value => value + 1), 1000);
		} catch (error) {
			finish(FAILURE_WORDS[microphoneFailure(error) as DictationFailure]);
		}
	}, [finish]);

	let stopServer = useCallback(async () => {
		let made = recording.current;
		if (!made) return finish();
		clearInterval(timer.current);
		setPhase("transcribing");
		setAnnouncement("Transcribing");
		let audio = await made.stop();
		if (!audio) return finish();
		try {
			let { transcribe } = await import("./server-recording");
			let words = await transcribe(latest.current.room, audio);
			if (running.current) report(words, true);
			finish();
		} catch {
			finish("The recording couldn't be transcribed. Try again.");
		}
	}, [finish, report]);

	let start = useCallback(() => {
		if (!latest.current.source || running.current) return;
		running.current = true;
		setFailure(undefined);
		setSeconds(0);
		setPhase("starting");
		update(begin(latest.current.read().caret));
		if (latest.current.source.kind === "browser") startBrowser(latest.current.source.Native);
		else void startServer();
	}, [startBrowser, startServer, update]);

	let stop = useCallback(() => {
		if (!running.current) return;
		if (recognizer.current) recognizer.current.stop();
		else void stopServer();
	}, [stopServer]);

	/** Ends it at once and reports nothing more, for a composer that is going. */
	let abort = useCallback(() => {
		if (!running.current) return;
		recognizer.current?.abort();
		recording.current?.discard();
		finish();
	}, [finish]);

	// Never in the background: hidden, or gone, it stops, and it does not come back by itself.
	useEffect(() => {
		let hidden = () => {
			if (document.visibilityState === "hidden") abort();
		};
		document.addEventListener("visibilitychange", hidden);
		window.addEventListener("pagehide", abort);
		return () => {
			document.removeEventListener("visibilitychange", hidden);
			window.removeEventListener("pagehide", abort);
		};
	}, [abort]);
	useEffect(() => abort, [abort, room]);

	if (!source) return undefined;
	let text = latest.current.read().text;
	return {
		source: source.kind,
		phase,
		seconds,
		interim: shown(text, state),
		failure,
		dismiss: () => setFailure(undefined),
		announcement,
		toggle: () => (running.current ? stop() : start()),
		start,
		stop,
		follow: caret => {
			if (!running.current) return;
			let next = follow(current.current, caret);
			if (next !== current.current) update(next);
		},
		settle: draft => {
			if (!running.current) return undefined;
			let settled = flush(draft, current.current);
			let from = Math.min(current.current.anchor, draft.length);
			abort();
			return { text: settled.text, at: from, caret: settled.caret };
		},
		active: phase !== "idle",
	};
}
