export const LONG_PRESS_MS = 450;

export const LONG_PRESS_SLOP = 10;

type Timers = {
	set: (callback: () => void, ms: number) => unknown;
	clear: (handle: unknown) => void;
};

const BROWSER: Timers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class LongPress {
	fired = false;
	private handle: unknown;
	private origin: { x: number; y: number } | undefined;

	constructor(private onPress: () => void, private timers: Timers = BROWSER) {}

	start(x: number, y: number): void {
		this.cancel();
		this.fired = false;
		this.origin = { x, y };
		this.handle = this.timers.set(() => {
			this.handle = undefined;
			this.fired = true;
			this.onPress();
		}, LONG_PRESS_MS);
	}

	move(x: number, y: number): void {
		if (!this.origin || this.handle === undefined) return;
		if (Math.hypot(x - this.origin.x, y - this.origin.y) > LONG_PRESS_SLOP) this.cancel();
	}

	end(): boolean {
		let fired = this.fired;
		this.cancel();
		this.fired = false;
		return fired;
	}

	cancel(): void {
		if (this.handle !== undefined) this.timers.clear(this.handle);
		this.handle = undefined;
		this.origin = undefined;
	}
}
