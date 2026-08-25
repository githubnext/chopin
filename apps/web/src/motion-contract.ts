export type MotionKind = "popover" | "sidebar";

export const MOTION_STATES = ["", "is-open", "is-closing"] as const;

let contracts = {
	popover: { className: "motion-popover", closeDuration: 150 },
	sidebar: { className: "motion-sidebar", closeDuration: 180 },
} as const satisfies Record<MotionKind, { className: string; closeDuration: number }>;

export function motionContract(kind: MotionKind): (typeof contracts)[MotionKind] {
	return contracts[kind];
}
