/** One ephemeral, replaceable opportunity to join a human conversation. */
export type Contribution<T> = { id: string; actor: string; value: T };

export type InitiativeClock = {
	now(): number;
	set(callback: () => void, delay: number): unknown;
	clear(timer: unknown): void;
};

const clock: InitiativeClock = {
	now: Date.now,
	set: (callback, delay) => setTimeout(callback, delay),
	clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export const SOLO_SILENCE_MS = 1_500;
export const GROUP_SILENCE_MS = 15_000;
export const TYPING_LEASE_MS = 6_000;
const PARTICIPANT_WINDOW_MS = 120_000;
const OPPORTUNITY_LIFETIME_MS = 300_000;

type Opportunity<T> = {
	contribution: Contribution<T>;
	at: number;
	quietSince: number;
	controller?: AbortController;
	running?: boolean;
};

export type InitiativeSchedule<T> = {
	receive(contribution: Contribution<T>): void;
	typing(client: string, actor: string, active: boolean): void;
	depart(client: string): void;
	cancel(): void;
	pause(paused: boolean): void;
	close(): void;
};

export function createInitiativeSchedule<T, Move>(options: {
	clock?: InitiativeClock;
	soloMs?: number;
	groupMs?: number;
	paused?: boolean;
	admit(value: T): "ready" | "wait" | "drop";
	judge(value: T, signal: AbortSignal): Promise<Move | undefined>;
	/** Resolves after the normal Planner turn ends; false means admission raced with other work. */
	dispatch(value: T, move: Move, signal: AbortSignal, lifecycle: {
		started(): void;
		current(): boolean;
	}): Promise<boolean>;
}): InitiativeSchedule<T> {
	let time = options.clock ?? clock;
	let pending: Opportunity<T> | undefined;
	let active: { opportunity: Opportunity<T>; controller: AbortController } | undefined;
	let timer: unknown;
	let paused = !!options.paused;
	let closed = false;
	let seen = new Set<string>();
	let participants = new Map<string, number>();
	let typing = new Map<string, { actor: string; until: number }>();

	function prune(now: number) {
		for (let [actor, at] of participants) {
			if (now - at >= PARTICIPANT_WINDOW_MS) participants.delete(actor);
		}
		for (let [client, lease] of typing) {
			if (lease.until <= now) typing.delete(client);
		}
	}

	function due(opportunity: Opportunity<T>, now: number) {
		prune(now);
		let people = new Set([...participants.keys(), ...[...typing.values()].map(x => x.actor)]);
		let silence = people.size > 1
			? options.groupMs ?? GROUP_SILENCE_MS
			: options.soloMs ?? SOLO_SILENCE_MS;
		let at = opportunity.quietSince + silence;
		for (let lease of typing.values()) at = Math.max(at, lease.until + silence);
		return at;
	}

	function clearTimer() {
		if (timer !== undefined) time.clear(timer);
		timer = undefined;
	}

	function arm(delay?: number) {
		clearTimer();
		if (closed || paused || !pending || pending.controller) return;
		let now = time.now();
		let expires = pending.at + OPPORTUNITY_LIFETIME_MS;
		let at = Math.min(expires, delay === undefined ? due(pending, now) : now + delay);
		timer = time.set(() => {
			timer = undefined;
			void check();
		}, Math.max(1, at - now));
	}

	function current(opportunity: Opportunity<T>, controller: AbortController) {
		return !closed && !paused && pending === opportunity
			&& opportunity.controller === controller && !controller.signal.aborted
			&& time.now() - opportunity.at < OPPORTUNITY_LIFETIME_MS;
	}

	async function check() {
		let opportunity = pending;
		if (!opportunity || closed || paused || opportunity.controller) return;
		let now = time.now();
		if (now - opportunity.at >= OPPORTUNITY_LIFETIME_MS) {
			pending = undefined;
			return;
		}
		if (due(opportunity, now) > now) return arm();
		let admission = options.admit(opportunity.contribution.value);
		if (admission === "drop") {
			pending = undefined;
			return;
		}
		if (admission === "wait" || active) return arm(1_000);
		let controller = new AbortController();
		opportunity.controller = controller;
		try {
			let move = await options.judge(opportunity.contribution.value, controller.signal);
			if (!current(opportunity, controller)) return;
			if (move === undefined) {
				pending = undefined;
				return;
			}
			if (due(opportunity, time.now()) > time.now()) return;
			let fresh = options.admit(opportunity.contribution.value);
			if (fresh === "drop") {
				pending = undefined;
				return;
			}
			if (fresh === "wait") return;
			active = { opportunity, controller };
			let dispatched = await options.dispatch(
				opportunity.contribution.value,
				move,
				controller.signal,
				{
					started: () => {
						if (current(opportunity, controller)) opportunity.running = true;
					},
					current: () =>
						current(opportunity, controller) && due(opportunity, time.now()) <= time.now(),
				},
			);
			if (current(opportunity, controller) && dispatched) pending = undefined;
		} catch {
			// A failed judgment is quiet and consumed; only fresh human input can retry it.
			if (current(opportunity, controller)) pending = undefined;
		} finally {
			if (active?.controller === controller) active = undefined;
			if (opportunity.controller === controller) {
				opportunity.controller = undefined;
				opportunity.running = false;
			}
			arm();
		}
	}

	function cancel() {
		clearTimer();
		pending?.controller?.abort();
		active?.controller.abort();
		pending = undefined;
	}

	return {
		receive(contribution) {
			if (closed || seen.has(contribution.id)) return;
			seen.add(contribution.id);
			if (seen.size > 128) seen.delete(seen.values().next().value!);
			let now = time.now();
			prune(now);
			participants.delete(contribution.actor);
			participants.set(contribution.actor, now);
			if (participants.size > 32) participants.delete(participants.keys().next().value!);
			cancel();
			if (paused) return;
			pending = { contribution, at: now, quietSince: now };
			arm();
		},
		typing(client, actor, isTyping) {
			if (closed) return;
			let now = time.now();
			prune(now);
			if (isTyping) {
				if (!typing.has(client) && typing.size >= 64) return;
				typing.set(client, { actor, until: now + TYPING_LEASE_MS });
			} else typing.delete(client);
			if (pending && !pending.running) {
				pending.quietSince = now;
				pending.controller?.abort();
				pending.controller = undefined;
				arm();
			}
		},
		depart(client) {
			typing.delete(client);
			arm();
		},
		cancel,
		pause(value) {
			paused = value;
			cancel();
		},
		close() {
			closed = true;
			cancel();
			typing.clear();
			participants.clear();
			seen.clear();
		},
	};
}
