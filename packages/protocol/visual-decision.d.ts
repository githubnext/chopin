import type { Frame, Request } from "./index";

export declare namespace VisualDecision {
	export type Values = Record<string, number | string>;
	export type Control =
		| {
			type: "number";
			id: string;
			label: string;
			unit: string;
			min: number;
			max: number;
			step: number;
		}
		| { type: "color"; id: string; label: string };
	export type Definition = {
		schema: "visual-decision@1";
		title: string;
		requestId: string;
		artifact: { ref: string; digest: string };
		definitionRevision: string;
		controls: Control[];
		baseline: Values;
	};
	export type Saved = {
		decisionId: string;
		requestId: string;
		definitionRevision: string;
		artifactDigest: string;
		revision: number;
		values: Values;
		by: string;
		at: string;
	};
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
		| Request<Frame & { kind: "visual-decision:open"; id: string }>
		| Request<Frame & { kind: "visual-decision:edit"; id: string; key: string; patch: Values }>
		| Request<
			Frame & {
				kind: "visual-decision:save";
				id: string;
				revision: number;
				definitionRevision: string;
			}
		>;
	export type Outgoing =
		| (Frame & {
			kind: "visual-decision:open" | "visual-decision:edit" | "visual-decision:save";
		} & Result)
		| (Frame & { kind: "visual-decision:changed"; state: State });
}
