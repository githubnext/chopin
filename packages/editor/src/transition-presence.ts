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
	return matchMedia("(prefers-reduced-motion: reduce)").matches
		|| document.documentElement.dataset.motionInput === "keyboard";
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

	useEffect(() => dispatch(value === undefined ? "close" : "open"), [value]);
	useEffect(() => {
		if (phase === "opening") {
			let frame = requestAnimationFrame(() => dispatch("finish"));
			return () => cancelAnimationFrame(frame);
		}
		if (phase !== "closing") return;
		let raw = getComputedStyle(document.documentElement).getPropertyValue(closeDuration).trim();
		let timer = window.setTimeout(() => dispatch("finish"), closeDelay(raw, fallback, immediate()));
		return () => window.clearTimeout(timer);
	}, [closeDuration, fallback, phase]);

	return {
		className: presenceClass(phase),
		mounted: phase !== "closed" && latest.current !== undefined,
		onTransitionEnd: event => {
			if (phase === "closing" && event.target === event.currentTarget) dispatch("finish");
		},
		phase,
		value: phase === "closed" ? undefined : latest.current,
	};
}
