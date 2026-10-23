import { createToolPreference } from "@github-ui/playground/preferences";
import { createToolbarBridge } from "@github-ui/playground/toolbar";
import { simulateTyping } from "@github-ui/playground/typing";
import { displayName, type Source } from "./plans";
import { type BeatContext, script, type Where } from "./script";
import type { PlanStore } from "./store";

export type DirectorState =
	| { beat: number; labels: string[]; playing: boolean; auto: boolean }
	| null;

export type DirectorAction =
	| { type: "play" }
	| { type: "play-all" }
	| { type: "stop" }
	| { type: "reset" }
	| { type: "jump"; beat: number };

export let directorBridge = createToolbarBridge<DirectorState, DirectorAction>("chopin/director");

export let typingSpeeds = [80, 160, 240, 320, 480, 640] as const;

/** People type at this speed; Copilot types twice as fast. */
export let typingSpeed = createToolPreference({
	namespace: "chopin",
	key: "demo/typing-speed",
	version: 1,
	defaultValue: 160 as number,
	validate: (value): value is number =>
		typeof value === "number" && typingSpeeds.some(speed => speed === value),
});

let labels = script.map(beat => beat.label);

let store: PlanStore | null = null;
let beat = 0;
let playing = false;
let auto = false;
let run: AbortController | null = null;
let messageCount = 0;

function publish() {
	directorBridge.publishState(store ? { beat, labels, playing, auto } : null);
}

function sleep(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		let timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		let abort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

function locate(body: string, where: Where) {
	if (where === "end") return body.length;
	let index = body.indexOf(where.after);
	if (index < 0) throw new Error(`Demo anchor not found: ${where.after}`);
	return index + where.after.length;
}

function context(planStore: PlanStore, signal: AbortSignal, instant: boolean): BeatContext {
	let state = planStore.get;
	let set = planStore.set;

	let say = (author: string, body: string, sources?: Source[]) => {
		messageCount += 1;
		let message = { id: `demo-${messageCount}`, author, body, at: "just now", sources };
		set(current => ({ messages: [...current.messages, message] }));
	};

	let type = (login: string, text: string, onUpdate: (prefix: string) => void) =>
		simulateTyping(text, onUpdate, {
			signal,
			wordsPerMinute: Math.min(1000, typingSpeed.get() * (login === "copilot" ? 2 : 1)),
		});

	let editing = (login: string, pos: number) => {
		set({
			cursor: { login, pos },
			activity: { login, text: `${displayName(login)} is editing` },
			updated: "just now",
			updatedBy: login,
		});
	};

	let done = () => set({ cursor: null, activity: null });

	return {
		instant,
		state,
		set,
		say,
		wait: ms => (instant ? Promise.resolve() : sleep(ms, signal)),
		async compose(author, text) {
			if (!instant) {
				await type(author, text, prefix => set({ composer: prefix }));
				await sleep(500, signal);
			}
			set({ composer: "" });
			say(author, text);
		},
		async insert(login, where, text) {
			let body = state().body;
			let pos = locate(body, where);
			let write = (typed: string) => body.slice(0, pos) + typed + body.slice(pos);
			if (instant) {
				set({ body: write(text), updated: "just now", updatedBy: login });
				return;
			}
			editing(login, pos);
			await type(login, text, prefix => {
				set({ body: write(prefix), cursor: { login, pos: pos + prefix.length } });
			});
			await sleep(300, signal);
			done();
		},
		async place(login, where, text) {
			let body = state().body;
			let pos = locate(body, where);
			let written = body.slice(0, pos) + text + body.slice(pos);
			if (instant) {
				set({ body: written, updated: "just now", updatedBy: login });
				return;
			}
			editing(login, pos);
			await sleep(700, signal);
			set({ body: written, cursor: { login, pos: pos + text.length } });
			await sleep(500, signal);
			done();
		},
		async replace(login, find, text) {
			let body = state().body;
			let start = body.indexOf(find);
			if (start < 0) throw new Error(`Demo text not found: ${find}`);
			let write = (middle: string) =>
				body.slice(0, start) + middle + body.slice(start + find.length);
			if (instant) {
				set({ body: write(text), updated: "just now", updatedBy: login });
				return;
			}
			let end = find.length;
			editing(login, start + end);
			await sleep(500, signal);
			while (end > 0) {
				end = Math.max(0, end - 3);
				set({ body: write(find.slice(0, end)), cursor: { login, pos: start + end } });
				await sleep(18, signal);
			}
			await sleep(250, signal);
			await type(login, text, prefix => {
				set({ body: write(prefix), cursor: { login, pos: start + prefix.length } });
			});
			await sleep(300, signal);
			done();
		},
	};
}

function stopRun() {
	run?.abort(new DOMException("Demo stopped", "AbortError"));
	run = null;
	playing = false;
	auto = false;
}

async function fastForward(target: number) {
	if (!store) return;
	stopRun();
	store.reset();
	messageCount = 0;
	let controller = new AbortController();
	for (let index = 0; index < target; index++) {
		await script[index]?.run(context(store, controller.signal, true));
	}
	store.set({ cursor: null, activity: null });
	beat = target;
	publish();
}

async function play(all: boolean) {
	if (!store || playing) return;
	if (beat >= script.length) await fastForward(0);
	let planStore = store;
	let controller = new AbortController();
	run = controller;
	playing = true;
	auto = all;
	publish();
	try {
		for (;;) {
			let current = script[beat];
			if (!current) break;
			await current.run(context(planStore, controller.signal, false));
			beat += 1;
			publish();
			if (!all || beat >= script.length) break;
			await sleep(1500, controller.signal);
		}
	} catch (error) {
		if (!controller.signal.aborted) throw error;
		return;
	} finally {
		if (run === controller) {
			run = null;
			playing = false;
			auto = false;
			publish();
		}
	}
}

/** Starts the next beat when a presenter performs the matching action in the page. */
export function cue(id: string) {
	let current = script[beat];
	if (!store || playing || !current || (current.cue ?? current.id) !== id) return false;
	void play(false);
	return true;
}

export function attachDirector(planStore: PlanStore) {
	store = planStore;
	publish();
	let unsubscribe = directorBridge.onAction(action => {
		switch (action.type) {
			case "play":
				void play(false);
				break;
			case "play-all":
				void play(true);
				break;
			case "stop":
				// Rewinds to the start of the interrupted beat so a retake starts clean.
				if (playing) void fastForward(beat);
				break;
			case "reset":
				void fastForward(0);
				break;
			case "jump":
				void fastForward(Math.max(0, Math.min(script.length, action.beat)));
				break;
		}
	});
	return () => {
		unsubscribe();
		stopRun();
		store = null;
		publish();
	};
}
