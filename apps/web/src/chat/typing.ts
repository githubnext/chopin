let REPORT_EVERY = 2000;
let IDLE_AFTER = 5000;

type Clock = {
	now: () => number;
	after: (callback: () => void, delay: number) => () => void;
};

let clock: Clock = {
	now: () => performance.now(),
	after: (callback, delay) => {
		let timer = setTimeout(callback, delay);
		return () => clearTimeout(timer);
	},
};

/** What a composer tells the server: `ago` is how long before the report its latest edit was. */
export type TypingReport = { active: true; seq: number; ago: number } | {
	active: false;
	seq: number;
};

/** A report as `chat:typing` carries it: the edit of an active one placed on the server's clock. */
export type TypingFrame = { active: true; seq: number; at: number } | {
	active: false;
	seq: number;
};

/**
 * `report` as it is sent, its edit placed on the server's clock by `serverNow` (the connection's
 * reading of it, `Wire.serverNow`). An active report isn't sent before that clock is known: the
 * server can't tell when its edit was, and a later report or the stop says what it would have.
 */
export function typingFrame(
	report: TypingReport,
	serverNow: number | undefined,
): TypingFrame | undefined {
	if (!report.active) return { active: false, seq: report.seq };
	if (serverNow === undefined) return undefined;
	return { active: true, seq: report.seq, at: serverNow - report.ago };
}

let reports = 0;

/** Every report this tab sends is numbered after the one before, whichever composer sends it. */
function nextReport(): number {
	return ++reports;
}

/**
 * One composer's writing, as the server is told it: started only by a person's edit, never by a
 * stored draft, and ended at once by `stop` (send, a cleared draft, blur, disposal) or five seconds
 * after the last edit. At most one report that starts or renews is sent every two seconds: edits
 * between are told by one report when the two seconds are up, carrying how long ago the last was
 * made, so the server knows when the writing ends without hearing every key. A start soon after a
 * stop waits for that too, so turning it on and off sends at most one of each in two seconds.
 */
export class TypingReporter {
	#send: (report: TypingReport) => void;
	#clock: Clock;
	#active = false;
	#told = false;
	#reported: number | undefined;
	#lastEdit = 0;
	#edits = 0;
	#reportedEdits = 0;
	#cancelIdle: (() => void) | undefined;
	#cancelTrailing: (() => void) | undefined;

	constructor(send: (report: TypingReport) => void, timing: Clock = clock) {
		this.#send = send;
		this.#clock = timing;
	}

	change(): void {
		let now = this.#clock.now();
		this.#lastEdit = now;
		this.#edits++;
		this.#active = true;
		if (this.#reported === undefined || now - this.#reported >= REPORT_EVERY) this.#report();
		else this.#trail();
		this.#cancelIdle?.();
		this.#cancelIdle = this.#clock.after(() => this.stop(), IDLE_AFTER);
	}

	stop(): void {
		this.#cancelIdle?.();
		this.#cancelIdle = undefined;
		this.#cancelTrailing?.();
		this.#cancelTrailing = undefined;
		this.#active = false;
		if (!this.#told) return;
		this.#told = false;
		this.#send({ active: false, seq: nextReport() });
	}

	#report(): void {
		let now = this.#clock.now();
		this.#cancelTrailing?.();
		this.#cancelTrailing = undefined;
		this.#reported = now;
		this.#reportedEdits = this.#edits;
		this.#told = true;
		this.#send({ active: true, seq: nextReport(), ago: Math.round(now - this.#lastEdit) });
	}

	#trail(): void {
		if (this.#cancelTrailing) return;
		let due = this.#reported! + REPORT_EVERY - this.#clock.now();
		this.#cancelTrailing = this.#clock.after(() => {
			this.#cancelTrailing = undefined;
			if (this.#active && this.#edits > this.#reportedEdits) this.#report();
		}, due);
	}
}
