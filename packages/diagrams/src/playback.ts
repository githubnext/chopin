/**
 * Playback through a diagram's motion steps (1…steps).
 *
 * Playing advances `at` once per stagger from `from`; it has finished when `at`
 * reaches the last step. Paused holds one step. Step arrows only move a
 * playback that is not running, so a click never races the animation.
 */
export type Playback =
	| { kind: "playing"; from: number; at: number }
	| { kind: "paused"; at: number };

/** Reduced motion never plays on its own: it opens on the whole diagram. */
export function initialPlayback(steps: number, reduced: boolean): Playback {
	return reduced ? { kind: "paused", at: steps } : { kind: "playing", from: 0, at: 0 };
}

export function running(playback: Playback, steps: number): boolean {
	return playback.kind === "playing" && playback.at < steps;
}

/** The step the counter shows. Playing from the start counts as step 1 at once. */
export function currentStep(playback: Playback, steps: number): number {
	return Math.min(steps, Math.max(1, playback.at));
}

export function advance(playback: Playback, steps: number, to: number): Playback {
	if (playback.kind !== "playing") return playback;
	return { ...playback, at: Math.min(steps, Math.max(playback.at, to)) };
}

export function pause(playback: Playback, steps: number): Playback {
	return { kind: "paused", at: currentStep(playback, steps) };
}

/** Resume from the step on screen, or from the start once the last step is reached. */
export function play(playback: Playback, steps: number): Playback {
	let at = currentStep(playback, steps);
	return at >= steps ? restart() : { kind: "playing", from: at, at };
}

export function restart(): Playback {
	return { kind: "playing", from: 0, at: 0 };
}

export function step(playback: Playback, steps: number, delta: number): Playback {
	if (running(playback, steps)) return playback;
	let at = Math.min(steps, Math.max(1, currentStep(playback, steps) + delta));
	return { kind: "paused", at };
}
