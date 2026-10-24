import { registerPlaygroundDemoController } from "@github-ui/playground/demos";
import { createToolPreference } from "@github-ui/playground/preferences";
import { simulateTyping } from "@github-ui/playground/typing";
import { demoSlug, displayName, findPlan, planPath, presenter, type Source } from "./plans";
import { type BeatContext, script, type Where } from "./script";
import { type PlanStore, planStore } from "./store";

type DemoController = Parameters<typeof registerPlaygroundDemoController>[1];
type DemoState = ReturnType<DemoController["getState"]>;

export let demoId = "chopin/demo";
export let demoPath = planPath(findPlan(demoSlug)!);

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
let navigator: ((path: string) => void) | null = null;
let beat = 0;
let playing = false;
let auto = false;
// A tour that has started stays paused, never idle, until Stop; idle ends the player's ownership.
let started = false;
let failure: string | null = null;
let run: AbortController | null = null;
let messageCount = 0;
let listeners = new Set<() => void>();
let snapshot: DemoState = { status: "idle", progress: { current: 0, total: script.length } };

// Leaving the plan reloads the page, so the tour keeps its place for this tab.
let savedBeat = "chopin/demo-beat";

function status(): DemoState["status"] {
	if (failure) return "error";
	if (playing) return "playing";
	if (beat >= script.length) return "completed";
	return started || beat > 0 ? "paused" : "idle";
}

function publish() {
	if (store) sessionStorage.setItem(savedBeat, String(beat));
	snapshot = {
		status: status(),
		error: failure ?? undefined,
		progress: { current: beat, total: script.length, label: labels[beat] },
	};
	for (let listener of listeners) listener();
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
		navigate(path) {
			let go = navigator;
			// After the beat finishes, so the tour records it before the page unloads.
			if (!instant && go) setTimeout(() => go(path));
		},
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

/** Rebuilds the demo plan as it stands before `target`, without animation. */
export async function restoreBeat(planStore: PlanStore, target: number) {
	planStore.reset();
	messageCount = 0;
	let controller = new AbortController();
	for (let index = 0; index < target; index++) {
		await script[index]?.run(context(planStore, controller.signal, true));
	}
	planStore.set({ cursor: null, activity: null });
}

/** Performs one beat live; aborting leaves it partway, so callers restore its start. */
export function performBeat(planStore: PlanStore, index: number, signal: AbortSignal) {
	let current = script[index];
	if (!current) throw new RangeError(`No demo beat ${index}`);
	return current.run(context(planStore, signal, false));
}

export let beatCount = script.length;

async function replay(planStore: PlanStore, target: number) {
	await restoreBeat(planStore, target);
	beat = target;
}

let seeking = Promise.resolve();

/** Seeks run one at a time so overlapping controls never interleave two replays. */
function fastForward(target: number) {
	stopRun();
	let seek = seeking.then(async () => {
		if (!store) return;
		await replay(store, target);
		publish();
	});
	seeking = seek.catch(() => {});
	return seek;
}

/** Restores the demo plan to where this tab's tour left off. */
export function resumeTour() {
	let target = Number(sessionStorage.getItem(savedBeat));
	if (Number.isInteger(target) && target > 0 && target <= script.length) {
		void replay(planStore(demoSlug), target);
	}
}

async function play(all: boolean, signal?: AbortSignal) {
	if (!store) return;
	if (playing) {
		follow(signal);
		if (all && !auto) {
			auto = true;
			publish();
		}
		return;
	}
	failure = null;
	if (beat >= script.length) await fastForward(0);
	let planStore = store;
	let controller = new AbortController();
	run = controller;
	started = true;
	follow(signal);
	playing = true;
	auto = all;
	publish();
	try {
		for (;;) {
			if (beat >= script.length) break;
			await performBeat(planStore, beat, controller.signal);
			beat += 1;
			publish();
			if (!auto || beat >= script.length) break;
			await sleep(1500, controller.signal);
		}
	} catch (error) {
		if (controller.signal.aborted) return;
		console.error(error);
		failure = error instanceof Error ? error.message : String(error);
		if (run === controller) await fastForward(beat);
	} finally {
		if (run === controller) {
			run = null;
			playing = false;
			auto = false;
			publish();
		}
	}
}

/** The player aborts its signal on Stop, Restart, replacement, and teardown, but not Pause. */
function follow(signal?: AbortSignal) {
	let current = run;
	signal?.addEventListener("abort", () => {
		if (current && run === current) void interrupt();
	}, { once: true });
}

/** Stops live playback; a beat interrupted partway rewinds to its start. */
function interrupt() {
	return playing ? fastForward(beat) : Promise.resolve();
}

/** Starts the next beat when a presenter performs the matching action in the page. */
export function cue(id: string) {
	let current = script[beat];
	if (!store || playing || !current || (current.cue ?? current.id) !== id) return false;
	void play(false);
	return true;
}

function signedInAsPresenter() {
	let login = document.querySelector<HTMLMetaElement>('meta[name="user-login"]')?.content;
	return login === presenter;
}

/** Signs in as the presenter through the playground's local login; the player continues after reload. */
async function enterAsPresenter(navigate: (path: string) => void) {
	let body = new URLSearchParams({ login: presenter, return_to: demoPath });
	await fetch("/session", { method: "POST", body, redirect: "manual" });
	navigate(demoPath);
}

let demoController: DemoController = {
	async play({ signal, navigate }) {
		if (!signedInAsPresenter()) return enterAsPresenter(navigate);
		await play(true, signal);
	},
	pause: interrupt,
	async restart({ signal, navigate }) {
		failure = null;
		await fastForward(0);
		if (!signedInAsPresenter()) return enterAsPresenter(navigate);
		await play(true, signal);
	},
	async stop() {
		failure = null;
		started = false;
		await fastForward(0);
	},
	async next() {
		failure = null;
		await fastForward(Math.min(script.length, beat + 1));
	},
	async previous() {
		failure = null;
		await fastForward(playing ? beat : Math.max(0, beat - 1));
	},
	getState: () => snapshot,
	subscribe(listener) {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};

export function attachDirector(planStore: PlanStore, navigate: (path: string) => void) {
	store = planStore;
	navigator = navigate;
	publish();
	let unregister = registerPlaygroundDemoController(demoId, demoController);
	return () => {
		stopRun();
		store = null;
		navigator = null;
		publish();
		unregister();
	};
}
