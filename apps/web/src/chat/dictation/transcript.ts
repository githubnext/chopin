/**
 * What speech becomes in a draft, with no browser in it. Words the recognizer is sure of (a final
 * result) are written into the draft where the person was dictating, spaced as typing would be;
 * words it is still working on (an interim result) are only shown, beside that place, and are
 * replaced by the next result. The draft stays ordinary text the person can edit at any time.
 */

/** One result as the recognizer reports it. */
export type Part = { transcript: string; final: boolean };

/** Where the next words go, and what is being said but not yet settled. */
export type Dictation = {
	/** The offset in the draft the next final result is written at. */
	anchor: number;
	/** What the recognizer is still working on, shown beside `anchor`; never in the draft. */
	interim: string;
};

export function begin(caret: number): Dictation {
	return { anchor: caret, interim: "" };
}

/** A space between what is there and what is said, where typing would put one. */
function lead(before: string, spoken: string): string {
	return before && !/\s$/.test(before) && !/^[\s.,;:!?)\]}]/.test(spoken) ? " " : "";
}

function trail(after: string, spoken: string): string {
	return after && !/^[\s.,;:!?)\]}]/.test(after) && !/\s$/.test(spoken) ? " " : "";
}

function settle(text: string, at: number, spoken: string): { text: string; at: number } {
	let before = text.slice(0, at);
	let after = text.slice(at);
	let inserted = lead(before, spoken) + spoken + trail(after, spoken);
	return { text: before + inserted + after, at: at + inserted.length };
}

export type Merged = {
	text: string;
	state: Dictation;
	/** Where the caret goes: after the words just written. */
	caret: number;
	/** Whether the draft changed. */
	changed: boolean;
};

/**
 * One report of the recognizer: its final results are written at the anchor, one after another, and
 * the interim ones become what is shown beside it. An empty result says nothing.
 */
export function merge(text: string, state: Dictation, parts: readonly Part[]): Merged {
	let next = text;
	let at = Math.min(state.anchor, text.length);
	let interim: string[] = [];
	let changed = false;
	for (let part of parts) {
		let spoken = part.transcript.trim();
		if (!spoken) continue;
		if (part.final) {
			let written = settle(next, at, spoken);
			next = written.text;
			at = written.at;
			changed = true;
		} else interim.push(spoken);
	}
	return {
		text: next,
		state: { anchor: at, interim: interim.join(" ") },
		caret: at,
		changed,
	};
}

/**
 * Settles what is shown as if it were final, for a message sent while the person is still
 * speaking: what they saw is what is sent.
 */
export function flush(text: string, state: Dictation): Merged {
	return merge(text, state, state.interim ? [{ transcript: state.interim, final: true }] : []);
}

/**
 * The person typed or moved the caret: dictation follows them, and what was only shown is dropped,
 * since the words it stood for will be reported again. A caret that has not moved from the anchor
 * (the one the words just written put it at) changes nothing.
 */
export function follow(state: Dictation, caret: number): Dictation {
	return state.anchor === caret ? state : { anchor: caret, interim: "" };
}

/** What is shown beside the anchor: the interim words, led by the space they will have. */
export function shown(text: string, state: Dictation): { at: number; text: string } | undefined {
	if (!state.interim) return undefined;
	let at = Math.min(state.anchor, text.length);
	return { at, text: lead(text.slice(0, at), state.interim) + state.interim };
}
