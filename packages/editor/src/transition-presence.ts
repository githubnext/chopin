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
	let next = transitionPresence(phase, open ? "open" : "close");
	return immediately ? transitionPresence(next, "finish") : next;
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
	let latest = useRef(value);
	if (value !== undefined) latest.current = value;
	let [phase, dispatch] = useReducer(
		transitionPresence,
		value === undefined ? "closed" : "open",
	);
	let immediately = immediate();
	let resolved = resolvedPresence(phase, value !== undefined, immediately);

	useEffect(() => {
		dispatch(value === undefined ? "close" : "open");
		if (immediately) dispatch("finish");
	}, [immediately, value]);
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
		mounted: resolved !== "closed" && latest.current !== undefined,
		onTransitionEnd: event => {
			if (resolved === "closing" && event.target === event.currentTarget) dispatch("finish");
		},
		phase: resolved,
		value: resolved === "closed" ? undefined : latest.current,
	};
}
