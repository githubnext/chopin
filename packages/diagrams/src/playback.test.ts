import { expect, test } from "bun:test";

import {
	advance,
	currentStep,
	initialPlayback,
	pause,
	play,
	restart,
	running,
	step,
} from "./playback";

test("playback counts the step being played from the first step", () => {
	let playback = initialPlayback(8, false);
	expect(running(playback, 8)).toBe(true);
	expect(currentStep(playback, 8)).toBe(1);
	playback = advance(playback, 8, 3);
	expect(currentStep(playback, 8)).toBe(3);
	expect(advance(playback, 8, 2)).toEqual(playback);
	expect(running(advance(playback, 8, 8), 8)).toBe(false);
});

test("arrows do nothing while playing and move a paused playback within its ends", () => {
	let playing = advance(initialPlayback(5, false), 5, 2);
	expect(step(playing, 5, 1)).toBe(playing);
	let paused = pause(playing, 5);
	expect(paused).toEqual({ kind: "paused", at: 2 });
	expect(step(paused, 5, -1)).toEqual({ kind: "paused", at: 1 });
	expect(step(step(paused, 5, -1), 5, -1)).toEqual({ kind: "paused", at: 1 });
	expect(step({ kind: "paused", at: 5 }, 5, 1)).toEqual({ kind: "paused", at: 5 });
	let finished = advance(playing, 5, 5);
	expect(step(finished, 5, -1)).toEqual({ kind: "paused", at: 4 });
});

test("play resumes from the paused step, or starts again from the last one", () => {
	expect(play({ kind: "paused", at: 3 }, 6)).toEqual({ kind: "playing", from: 3, at: 3 });
	expect(play({ kind: "paused", at: 6 }, 6)).toEqual(restart());
	expect(play(advance(restart(), 6, 6), 6)).toEqual(restart());
});

test("reduced motion opens on the whole diagram without playing", () => {
	let playback = initialPlayback(4, true);
	expect(playback).toEqual({ kind: "paused", at: 4 });
	expect(running(playback, 4)).toBe(false);
});
