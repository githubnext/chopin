export type MotionKind = "collapse" | "content-swap" | "feedback" | "popover" | "sidebar";

export const MOTION_STATES = ["", "is-open", "is-closing"] as const;

let contracts = {
	collapse: { className: "motion-collapse", closeDuration: 250, states: MOTION_STATES },
	"content-swap": {
		className: "motion-content-swap",
		closeDuration: 250,
		states: MOTION_STATES,
	},
	feedback: { className: "motion-feedback", closeDuration: 180, states: MOTION_STATES },
	popover: { className: "motion-popover", closeDuration: 150, states: MOTION_STATES },
	sidebar: { className: "motion-sidebar", closeDuration: 180, states: MOTION_STATES },
} as const satisfies Record<
	MotionKind,
	{ className: string; closeDuration: number; states: typeof MOTION_STATES }
>;

export function motionContract<Kind extends MotionKind>(kind: Kind): (typeof contracts)[Kind] {
	return contracts[kind];
}
