import { useEffect, useReducer, useRef } from "react";

import type { TransitionEventHandler } from "react";

export type PresencePhase = "closed" | "opening" | "open" | "closing";
export type PresenceAction = "open" | "close" | "finish";

export type TransitionPresence<T> = {
	className: "" | "is-open" | "is-closing";
	mounted: boolean;
	onTransitionEnd: TransitionEventHandler<HTMLElement>;
	phase: PresencePhase;
	value: T | undefined;
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

export function presenceValue<T>(
	value: T | undefined,
	latest: T | undefined,
	phase: PresencePhase,
): T | undefined {
	return phase === "closed" ? undefined : value ?? latest;
}

export function presenceClass(phase: PresencePhase): TransitionPresence<unknown>["className"] {
	return phase === "open" ? "is-open" : phase === "closing" ? "is-closing" : "";
}

function duration(raw: string, fallback: number): number {
	let value = Number.parseFloat(raw);
	if (!Number.isFinite(value)) return fallback;
	if (raw.endsWith("ms")) return value;
	if (raw.endsWith("s")) return value * 1000;
	return fallback;
}

export function closeDelay(raw: string, fallback: number, immediately: boolean): number {
	return immediately ? 0 : duration(raw, fallback) + 50;
}

function immediate(): boolean {
	return typeof window !== "undefined"
		&& (matchMedia("(prefers-reduced-motion: reduce)").matches
			|| document.documentElement.dataset.motionInput === "keyboard");
}

export function useTransitionPresence<T>(
	value: T | undefined,
	closeDuration: string,
	fallback: number,
): TransitionPresence<T> {
	let latest = useRef<T | undefined>(value);
	let open = value !== undefined;
	let [phase, dispatch] = useReducer(
		transitionPresence,
		open ? "open" : "closed",
	);
	let immediately = immediate();
	let resolved = resolvedPresence(phase, open, immediately);
	let presented = presenceValue(value, latest.current, resolved);

	useEffect(() => {
		if (value !== undefined) latest.current = value;
	}, [value]);
	useEffect(() => {
		dispatch(open ? "open" : "close");
		if (immediately) dispatch("finish");
	}, [immediately, open]);
	useEffect(() => {
		if (immediately) return;
		if (resolved === "opening") {
			let frame = requestAnimationFrame(() => dispatch("finish"));
			return () => cancelAnimationFrame(frame);
		}
		if (resolved !== "closing") return;
		let raw = getComputedStyle(document.documentElement).getPropertyValue(closeDuration).trim();
		let timer = window.setTimeout(() => dispatch("finish"), closeDelay(raw, fallback, immediately));
		return () => window.clearTimeout(timer);
	}, [closeDuration, fallback, immediately, resolved]);

	return {
		className: presenceClass(resolved),
		mounted: presented !== undefined,
		onTransitionEnd: event => {
			if (resolved === "closing" && event.target === event.currentTarget) dispatch("finish");
		},
		phase: resolved,
		value: presented,
	};
}
