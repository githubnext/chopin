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
	/**
	 * Closed, the layer stays in the page, skipped (`content-visibility: hidden`), instead of being
	 * taken out of it, and no layer is made inert: a large layer shown again then keeps the styles and
	 * layout it had, where taking it out and making it inert restyled all of it on each switch. Skipped
	 * content is not drawn, focusable, found or exposed to assistive technology; the outgoing layer
	 * takes no pointer and is hidden from assistive technology while it leaves.
	 */
	retain?: boolean;
	/** Laid out but unseen and inert, so it can load before it is revealed. */
	staged?: boolean;
};

export function ContentSwapLayer(
	{ active, children, className, immediately, motion, onClosed, retain, staged }:
		ContentSwapLayerProps,
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
	let closed = presence.phase === "closed" && !staged;
	return (
		<div
			aria-hidden={inactive || undefined}
			className={`${motion.className} ${presence.className}${className ? ` ${className}` : ""}`}
			data-content-swap-state={staged
				? "staged"
				: active
				? presence.phase
				: retain && closed
				? "closed"
				: "outgoing"}
			hidden={closed && !retain}
			inert={inactive && !retain}
		>
			{children}
		</div>
	);
}
