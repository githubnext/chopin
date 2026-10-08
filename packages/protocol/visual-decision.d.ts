import type { Frame, Request } from "./index";

export declare namespace VisualDecision {
	export type Values = { optionPadding: 4 | 6 | 8; selectedColor: string };
	export type Definition = {
		specimen: "decision-card-v1";
		bundleDigest: string;
		baseline: Values;
		controls: [
			{ id: "optionPadding"; type: "number"; min: 4; max: 8; step: 2 },
			{ id: "selectedColor"; type: "color"; format: "#RRGGBB" },
		];
	};
	export type Saved = { revision: number; values: Values; by: string; at: string };
	export type State = {
		id: string;
		definition: Definition;
		revision: number;
		values: Values;
		saved?: Saved;
	};
	export type Result =
		| { ok: true; state: State }
		| {
			ok: false;
			reason: "stale" | "saving" | "saved" | "invalid";
			state?: State;
			message?: string;
		};
	export type Incoming =
		| Request<Frame & { kind: "visual-decision:create"; key: string }>
		| Request<Frame & { kind: "visual-decision:open"; id: string }>
		| Request<
			Frame & { kind: "visual-decision:edit"; id: string; key: string; patch: Partial<Values> }
		>
		| Request<Frame & { kind: "visual-decision:save"; id: string; revision: number }>;
	export type Outgoing =
		| (Frame & {
			kind:
				| "visual-decision:create"
				| "visual-decision:open"
				| "visual-decision:edit"
				| "visual-decision:save";
		} & Result)
		| (Frame & { kind: "visual-decision:changed"; state: State });
}
