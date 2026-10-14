let RENEW_AFTER = 2000;
let IDLE_AFTER = 2500;

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

/** A short lease renewed only by user edits, never by a stored draft. */
export class TypingReporter {
	#send: (active: boolean) => void;
	#clock: Clock;
	#active = false;
	#renewed = 0;
	#cancel: (() => void) | undefined;

	constructor(send: (active: boolean) => void, timing: Clock = clock) {
		this.#send = send;
		this.#clock = timing;
	}

	change(): void {
		let now = this.#clock.now();
		if (!this.#active || now - this.#renewed >= RENEW_AFTER) {
			this.#send(true);
			this.#renewed = now;
		}
		this.#active = true;
		this.#cancel?.();
		this.#cancel = this.#clock.after(() => this.stop(), IDLE_AFTER);
	}

	stop(): void {
		this.#cancel?.();
		this.#cancel = undefined;
		if (!this.#active) return;
		this.#active = false;
		this.#send(false);
	}
}
