import type { Frame, Request } from "./index";

/** Provisional document synthesis from saved ordinary Chat. */
export declare namespace DocumentDevelopment {
	export type State = Frame & {
		kind: "document-development:state";
		paused: boolean;
		pending: boolean;
		generated: number;
		protected: number;
		lastOutcome?: "updated" | "unchanged" | "failed" | "stale";
	};
	export type Control = Frame & { kind: "document-development:control"; paused: boolean };
	export type RecoverySummary = { id: string; digest: string; preview: string };
	export type RecoveryState = Frame & {
		kind: "document-development:recovery-state";
		items: RecoverySummary[];
	};
	export type RecoveryRead = Frame & {
		kind: "document-development:recovery-read";
		id: string;
		digest: string;
	};
	export type RecoveryReadReply = Frame & {
		kind: "document-development:recovery-read";
		item: { id: string; digest: string; source: string };
	};
	export type RecoveryResolve = Frame & {
		kind: "document-development:recovery-resolve";
		id: string;
		digest: string;
		action: "add" | "dismiss";
	};
	export type Incoming = Request<Control | RecoveryRead | RecoveryResolve>;
	export type Outgoing = State | RecoveryState | RecoveryReadReply;
}
