import type { HybridMarkdownEditorRef } from "@github-ui/hybrid-markdown-editor/types";
import { createToolPreference } from "@github-ui/playground/preferences";
import { createToolbarBridge } from "@github-ui/playground/toolbar";
import { simulateTyping } from "@github-ui/playground/typing";
import { displayName } from "./plans";
import { type BeatContext, script, type Where } from "./script";
import type { PlanStore } from "./store";

type View = NonNullable<HybridMarkdownEditorRef["view"]>;

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
let getView: () => View | null = () => null;
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

function reveal(view: View, pos: number) {
	requestAnimationFrame(() => {
		let block = view.lineBlockAt(Math.min(pos, view.state.doc.length));
		let scroller = view.scrollDOM;
		let rect = scroller.getBoundingClientRect();
		let top = view.documentTop + block.top;
		let bottom = view.documentTop + block.bottom;
		let margin = 48;
		if (bottom > rect.bottom - margin) scroller.scrollTop += bottom - (rect.bottom - margin);
		else if (top < rect.top + margin) scroller.scrollTop -= rect.top + margin - top;
		let frame = scroller.getBoundingClientRect();
		if (frame.bottom > window.innerHeight) {
			window.scrollBy({ top: frame.bottom - window.innerHeight + 16 });
		}
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

	let say = (author: string, body: string) => {
		messageCount += 1;
		set(current => ({
			messages: [...current.messages, { id: `demo-${messageCount}`, author, body, at: "just now" }],
		}));
	};

	let type = (login: string, text: string, onUpdate: (prefix: string) => void) =>
		simulateTyping(text, onUpdate, {
			signal,
			wordsPerMinute: Math.min(1000, typingSpeed.get() * (login === "copilot" ? 2 : 1)),
		});

	let view = async () => {
		for (let tries = 0; tries < 60; tries++) {
			let current = getView();
			if (current) return current;
			await sleep(50, signal);
		}
		return null;
	};

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
			let editor = instant ? null : await view();
			if (!editor) {
				set({
					body: body.slice(0, pos) + text + body.slice(pos),
					updated: "just now",
					updatedBy: login,
				});
				return;
			}
			editing(login, pos);
			let typed = "";
			await type(login, text, prefix => {
				editor.dispatch({
					changes: { from: pos + typed.length, insert: prefix.slice(typed.length) },
				});
				typed = prefix;
				set({ cursor: { login, pos: pos + typed.length } });
				reveal(editor, pos + typed.length);
			});
			await sleep(300, signal);
			done();
		},
		async replace(login, find, text) {
			let body = state().body;
			let start = body.indexOf(find);
			if (start < 0) throw new Error(`Demo text not found: ${find}`);
			let editor = instant ? null : await view();
			if (!editor) {
				set({
					body: body.slice(0, start) + text + body.slice(start + find.length),
					updated: "just now",
					updatedBy: login,
				});
				return;
			}
			let end = start + find.length;
			editing(login, end);
			reveal(editor, end);
			await sleep(500, signal);
			while (end > start) {
				let next = Math.max(start, end - 3);
				editor.dispatch({ changes: { from: next, to: end } });
				end = next;
				set({ cursor: { login, pos: end } });
				await sleep(18, signal);
			}
			await sleep(250, signal);
			let typed = "";
			await type(login, text, prefix => {
				editor.dispatch({
					changes: { from: start + typed.length, insert: prefix.slice(typed.length) },
				});
				typed = prefix;
				set({ cursor: { login, pos: start + typed.length } });
				reveal(editor, start + typed.length);
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
	if (!store || playing || script[beat]?.id !== id) return false;
	void play(false);
	return true;
}

export function attachDirector(planStore: PlanStore, viewGetter: () => View | null) {
	store = planStore;
	getView = viewGetter;
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
		getView = () => null;
		publish();
	};
}
