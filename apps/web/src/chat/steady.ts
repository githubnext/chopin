import { useRef } from "react";

/**
 * The room renders Chat again for its own reasons (someone's presence, a document's activity, a key
 * typed in the composer), each time with new objects and new functions that say what the last ones
 * said. The transcript is memoized, and these keep what it is given the same while it means the
 * same thing: a long transcript is hundreds of messages, and rendering them again for nothing made
 * typing and hovering lag.
 */

type Callback = (...args: never[]) => unknown;

/** Whether `before` and `after` hold the same values, functions aside, and the same functions present. */
export function sameFields(before: object | undefined, after: object | undefined): boolean {
	if (before === after) return true;
	if (!before || !after) return false;
	let keys = Object.keys(after);
	if (Object.keys(before).length !== keys.length) return false;
	for (let key of keys) {
		let was = (before as Record<string, unknown>)[key];
		let is = (after as Record<string, unknown>)[key];
		if (typeof was === "function" && typeof is === "function") continue;
		if (!Object.is(was, is)) return false;
	}
	return true;
}

/** One function for the component's lifetime that calls the latest `callback`, or nothing. */
export function useSteadyCallback<F extends Callback>(callback: F | undefined): F | undefined {
	let latest = useRef(callback);
	latest.current = callback;
	let steady = useRef<F>(undefined);
	steady.current ??= ((...args: Parameters<F>) => latest.current!(...args)) as F;
	return callback ? steady.current : undefined;
}

/**
 * `value` as it was last time while its fields are the same; its functions are called through to
 * the latest ones, so what was kept never calls a function from an earlier render.
 */
export function useSteadyFields<T extends object | undefined>(value: T): T {
	let latest = useRef(value);
	latest.current = value;
	let kept = useRef<{ from: T; steady: T }>(undefined);
	if (!kept.current || !sameFields(kept.current.from, value)) {
		let steady = value && Object.fromEntries(
			Object.entries(value).map(([key, field]) => [
				key,
				typeof field === "function"
					? (...args: unknown[]) =>
						((latest.current as Record<string, Callback>)[key] as (...a: unknown[]) => unknown)(
							...args,
						)
					: field,
			]),
		) as T;
		kept.current = { from: value, steady };
	}
	return kept.current.steady;
}
