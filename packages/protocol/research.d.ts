import type { Frame } from "./index";

type KIND<K extends string> = Frame & { kind: K };

/**
 * Durable research work attached to a document.
 *
 * Workspaces are read and mutated over HTTP. The parent document socket only
 * announces that one changed, so clients can invalidate their HTTP state.
 */
export declare namespace Research {
	export type Outgoing = Changed;

	export type Origin = "sidebar" | "planner";
	export type TurnKind = "initial" | "follow-up" | "search-more";
	export type MessageAuthorKind = "member" | "agent" | "system";

	export type JobLinkIds = {
		readonly evidenceJobId?: string;
		readonly answerJobId?: string;
	};

	export type WorkspaceSummary = {
		readonly id: string;
		readonly channelId: string;
		readonly title: string;
		readonly proposedQuestion: string;
		readonly confirmedQuery?: string;
		readonly origin: Origin;
		readonly originMessageId?: string;
		readonly createdBy: string;
		readonly confirmedBy?: string;
		readonly revision: number;
		readonly createdAt: string;
		readonly updatedAt: string;
	};

	/** One immutable message in the workspace transcript. */
	export type Message = {
		readonly id: string;
		readonly workspaceId: string;
		readonly sequence: number;
		readonly turnId?: string;
		readonly authorKind: MessageAuthorKind;
		readonly userId?: string;
		readonly userHandle?: string;
		readonly text: string;
		readonly sourceJobId?: string;
		readonly createdAt: string;
	};

	/** One immutable research request and the jobs assigned to answer it. */
	export type Turn = JobLinkIds & {
		readonly id: string;
		readonly workspaceId: string;
		readonly ordinal: number;
		readonly kind: TurnKind;
		readonly question: string;
		readonly requestedBy: string;
		readonly createdAt: string;
		readonly updatedAt: string;
	};

	export type WorkspaceDetail = {
		readonly workspace: WorkspaceSummary;
		readonly turns: readonly Turn[];
		readonly messages: readonly Message[];
	};

	/** A persisted workspace mutation invalidated parent-channel HTTP state. */
	export type Changed = KIND<"research:changed"> & {
		workspaceId: string;
		revision: number;
	};
}
