import type { ReactNode } from "react";

import { useTransitionPresence } from "./transition-presence";

import type { PresencePhase } from "./transition-presence";

export type MotionDisclosureContract = {
	readonly className: string;
	readonly closeDuration: number;
	readonly contentClassName: string;
};

export function disclosureAccessibility(phase: PresencePhase) {
	let active = phase !== "closing";
	return { ariaHidden: active ? undefined : "true" as const, inert: !active };
}

export function MotionDisclosure(
	{ children, className = "", id, immediately, motion, open, surface }: {
		children: ReactNode;
		className?: string;
		id: string;
		immediately: boolean;
		motion: MotionDisclosureContract;
		open: boolean;
		surface: string;
	},
) {
	let presence = useTransitionPresence(open ? true : undefined, motion.closeDuration, immediately);
	if (presence.phase === "closed") return null;
	let accessibility = disclosureAccessibility(presence.phase);
	return (
		<div
			aria-hidden={accessibility.ariaHidden}
			className={`${motion.className} ${presence.className} ${className}`.trim()}
			data-motion-disclosure={surface}
			id={id}
			inert={accessibility.inert}
		>
			<div className={motion.contentClassName}>{children}</div>
		</div>
	);
}

export function MotionDisclosureIcon(
	{ className, closed, open, opened }: {
		className: string;
		closed: ReactNode;
		open: boolean;
		opened: ReactNode;
	},
) {
	let state = open ? "open" : "closed";
	return (
		<span
			aria-hidden="true"
			className={`${className} inline-flex`}
			data-feedback-icon={state}
			data-motion-feedback="icon"
			key={state}
		>
			{open ? opened : closed}
		</span>
	);
}
