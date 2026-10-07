export type MotionKind =
	| "collapse"
	| "content-swap"
	| "feedback"
	| "popover"
	| "route-swap"
	| "sidebar";

export const MOTION_STATES = ["", "is-open", "is-closing"] as const;

type MotionContract = {
	className: string;
	closeDuration: number;
	contentClassName?: string;
	states: typeof MOTION_STATES;
};

let contracts = {
	collapse: {
		className: "motion-collapse",
		closeDuration: 250,
		contentClassName: "motion-collapse-content",
		states: MOTION_STATES,
	},
	"content-swap": {
		className: "motion-content-swap",
		closeDuration: 250,
		states: MOTION_STATES,
	},
	feedback: { className: "motion-feedback", closeDuration: 180, states: MOTION_STATES },
	popover: { className: "motion-popover", closeDuration: 150, states: MOTION_STATES },
	// `closeDelay` adds 50ms, so the incoming route starts as the 80ms fade-out ends.
	"route-swap": { className: "motion-route-swap", closeDuration: 30, states: MOTION_STATES },
	sidebar: { className: "motion-sidebar", closeDuration: 180, states: MOTION_STATES },
} as const satisfies Record<MotionKind, MotionContract>;

export function motionContract<Kind extends MotionKind>(kind: Kind): (typeof contracts)[Kind] {
	return contracts[kind];
}
