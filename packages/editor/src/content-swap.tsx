import { useEffect, useRef } from "react";

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
};

export function ContentSwapLayer(
	{ active, children, className, immediately, motion, onClosed }: ContentSwapLayerProps,
) {
	let presence = useTransitionPresence(
		active ? true : undefined,
		motion.closeDuration,
		immediately,
	);
	let notifiedClosed = useRef(false);
	let onClosedRef = useRef(onClosed);
	onClosedRef.current = onClosed;

	useEffect(() => {
		if (active) {
			notifiedClosed.current = false;
			return;
		}
		if (presence.phase !== "closed" || notifiedClosed.current) return;
		notifiedClosed.current = true;
		onClosedRef.current?.();
	}, [active, presence.phase]);

	let inactive = !active;
	return (
		<div
			aria-hidden={inactive || undefined}
			className={`${motion.className} ${presence.className}${className ? ` ${className}` : ""}`}
			data-content-swap-state={active ? presence.phase : "outgoing"}
			hidden={presence.phase === "closed"}
			inert={inactive}
		>
			{children}
		</div>
	);
}
