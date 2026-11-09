import { expect, test } from "bun:test";

import {
	advance,
	currentStep,
	finish,
	initialPlayback,
	pause,
	play,
	restart,
	running,
	settle,
	step,
} from "./playback";

test("playback counts the step being played from the first step", () => {
	let playback = initialPlayback(8, false);
	expect(running(playback)).toBe(true);
	expect(currentStep(playback, 8)).toBe(1);
	playback = advance(playback, 8, 3);
	expect(currentStep(playback, 8)).toBe(3);
	expect(advance(playback, 8, 2)).toEqual(playback);
	// Reaching the last step keeps playing until it has drawn, then holds it.
	expect(finish(playback, 8)).toBe(playback);
	let last = advance(playback, 8, 8);
	expect(running(last)).toBe(true);
	expect(finish(last, 8)).toEqual({ kind: "paused", at: 8 });
});

test("arrows do nothing while playing and move a paused playback within its ends", () => {
	let playing = advance(initialPlayback(5, false), 5, 2);
	expect(step(playing, 5, 1)).toBe(playing);
	let paused = pause(playing, 5);
	expect(paused).toEqual({ kind: "paused", at: 2 });
	expect(step(paused, 5, -1)).toEqual({ kind: "paused", at: 1 });
	expect(step(step(paused, 5, -1), 5, -1)).toEqual({ kind: "paused", at: 1 });
	expect(step({ kind: "paused", at: 5 }, 5, 1)).toEqual({ kind: "paused", at: 5 });
	let finished = finish(advance(playing, 5, 5), 5);
	expect(step(finished, 5, -1)).toEqual({ kind: "paused", at: 4 });
});

test("play resumes from the paused step, or starts again from the last one", () => {
	expect(play({ kind: "paused", at: 3 }, 6)).toEqual({ kind: "playing", from: 3, at: 3 });
	expect(play({ kind: "paused", at: 6 }, 6)).toEqual(restart());
	expect(play(finish(advance(restart(), 6, 6), 6), 6)).toEqual(restart());
});

test("reduced motion opens on the whole diagram without playing", () => {
	let playback = initialPlayback(4, true);
	expect(playback).toEqual({ kind: "paused", at: 4 });
	expect(running(playback)).toBe(false);
});

test("a diagram the host found far from the reader opens on its whole drawing; near it, or not yet placed, it plays", () => {
	// Far: held on its last step, as reduced motion holds it, and as playing ends.
	expect(initialPlayback(6, false, false)).toEqual({ kind: "paused", at: 6 });
	expect(initialPlayback(6, false, false)).toEqual(finish(advance(restart(), 6, 6), 6));
	// Near the reader, or with no host that says (the gallery), it plays from the first step.
	expect(initialPlayback(6, false, true)).toEqual(restart());
	expect(initialPlayback(6, false, undefined)).toEqual(restart());
	// Reduced motion opens on the whole drawing wherever the diagram is.
	expect(initialPlayback(6, true, true)).toEqual({ kind: "paused", at: 6 });
	expect(initialPlayback(6, true, false)).toEqual({ kind: "paused", at: 6 });
});

test("a diagram found far from the reader after it began playing settles on its last step; one the reader paused keeps its own", () => {
	let playing = advance(initialPlayback(6, false), 6, 2);
	expect(settle(playing, 6)).toEqual({ kind: "paused", at: 6 });
	expect(running(settle(playing, 6))).toBe(false);
	expect(settle(initialPlayback(6, false), 6)).toEqual({ kind: "paused", at: 6 });
	let paused = pause(playing, 6);
	expect(settle(paused, 6)).toBe(paused);
});
