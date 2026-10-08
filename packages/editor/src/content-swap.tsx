import { useLayoutEffect, useRef } from "react";

import { useTransitionPresence } from "./transition-presence";

import type { ReactNode } from "react";

export type ContentSwapMotion = {
	readonly className: string;
	readonly closeDuration: number;
};

export type ContentSwapLayerProps = {
	active: boolean;
	children: ReactNode;
	className?: string;
	immediately: boolean;
	motion: ContentSwapMotion;
	onClosed?: () => void;
	/** Laid out but unseen and inert, so it can load before it is revealed. */
	staged?: boolean;
};

export function ContentSwapLayer(
	{ active, children, className, immediately, motion, onClosed, staged }: ContentSwapLayerProps,
) {
	let presence = useTransitionPresence(
		active ? true : undefined,
		motion.closeDuration,
		immediately,
	);
	let notifiedClosed = useRef(false);
	let onClosedRef = useRef(onClosed);
	onClosedRef.current = onClosed;

	let closable = onClosed !== undefined;
	// Before paint, so whatever replaces a closed layer lands in the same frame. A
	// layer that closed before it had a listener reports once one arrives.
	useLayoutEffect(() => {
		if (active) {
			notifiedClosed.current = false;
			return;
		}
		if (presence.phase !== "closed" || notifiedClosed.current || !onClosedRef.current) return;
		notifiedClosed.current = true;
		onClosedRef.current();
	}, [active, closable, presence.phase]);

	let inactive = !active;
	return (
		<div
			aria-hidden={inactive || undefined}
			className={`${motion.className} ${presence.className}${className ? ` ${className}` : ""}`}
			data-content-swap-state={staged ? "staged" : active ? presence.phase : "outgoing"}
			hidden={presence.phase === "closed" && !staged}
			inert={inactive}
		>
			{children}
		</div>
	);
}
