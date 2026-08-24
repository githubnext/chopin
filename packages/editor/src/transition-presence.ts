import { useEffect, useReducer, useSyncExternalStore } from "react";

export type PresencePhase = "closed" | "opening" | "open" | "closing";
export type PresenceAction = "open" | "close" | "finish";
export type PresenceState<T> = {
	immediately: boolean;
	input: T | undefined;
	phase: PresencePhase;
	value: T | undefined;
};
export type PresenceStateAction<T> =
	| { immediately: boolean; type: "sync"; value: T | undefined }
	| { type: "finish" };

type PresenceClass = "" | "is-open" | "is-closing";
export type TransitionPresence<T> =
	| { className: ""; phase: "closed"; value: undefined }
	| {
		className: PresenceClass;
		phase: Exclude<PresencePhase, "closed">;
		value: T;
	};

export function transitionPresence(phase: PresencePhase, action: PresenceAction): PresencePhase {
	if (action === "open") return phase === "closed" ? "opening" : "open";
	if (action === "close") return phase === "closed" ? "closed" : "closing";
	if (phase === "opening") return "open";
	if (phase === "closing") return "closed";
	return phase;
}

export function resolvedPresence(
	phase: PresencePhase,
	open: boolean,
	immediately: boolean,
): PresencePhase {
	let next = open && phase === "opening"
		? phase
		: transitionPresence(phase, open ? "open" : "close");
	return immediately ? transitionPresence(next, "finish") : next;
}

export function presenceState<T>(
	state: PresenceState<T>,
	action: PresenceStateAction<T>,
): PresenceState<T> {
	if (action.type === "finish") {
		let phase = transitionPresence(state.phase, "finish");
		return { ...state, phase, value: phase === "closed" ? undefined : state.value };
	}
	let open = action.value !== undefined;
	let phase = resolvedPresence(state.phase, open, action.immediately);
	return {
		immediately: action.immediately,
		input: action.value,
		phase,
		value: phase === "closed" ? undefined : open ? action.value : state.value,
	};
}

export function presenceClass(phase: PresencePhase): TransitionPresence<unknown>["className"] {
	return phase === "open" ? "is-open" : phase === "closing" ? "is-closing" : "";
}

export function closeDelay(duration: number, immediately: boolean): number {
	return immediately ? 0 : duration + 50;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotion(): boolean {
	return typeof window !== "undefined"
		&& window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function subscribeReducedMotion(update: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	let query = window.matchMedia(REDUCED_MOTION_QUERY);
	query.addEventListener("change", update);
	return () => query.removeEventListener("change", update);
}

export function useTransitionPresence<T>(
	value: T | undefined,
	closeDuration: number,
	immediately: boolean,
): TransitionPresence<T> {
	let open = value !== undefined;
	let prefersReducedMotion = useSyncExternalStore(
		subscribeReducedMotion,
		reducedMotion,
		() => false,
	);
	let settleImmediately = immediately || prefersReducedMotion;
	let [state, dispatch] = useReducer(presenceState<T>, {
		immediately: settleImmediately,
		input: value,
		phase: open ? "open" : "closed",
		value,
	});
	if (state.input !== value || state.immediately !== settleImmediately) {
		dispatch({ immediately: settleImmediately, type: "sync", value });
	}
	let resolved = state.phase;
	let presented = state.value;
	useEffect(() => {
		if (settleImmediately) return;
		if (resolved === "opening") {
			let frame = requestAnimationFrame(() => dispatch({ type: "finish" }));
			return () => cancelAnimationFrame(frame);
		}
		if (resolved !== "closing") return;
		let timer = window.setTimeout(
			() => dispatch({ type: "finish" }),
			closeDelay(
				closeDuration,
				settleImmediately,
			),
		);
		return () => window.clearTimeout(timer);
	}, [closeDuration, resolved, settleImmediately]);

	if (resolved === "closed" || presented === undefined) {
		return { className: "", phase: "closed", value: undefined };
	}
	return { className: presenceClass(resolved), phase: resolved, value: presented };
}
