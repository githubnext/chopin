import type { Agenda } from "@chopin/protocol";
import type { Lease } from "./model";

export type AgendaOwner = {
	userId: string;
	userHandle: string;
	sessionId: string;
	generation: number;
	credentialRevision: number;
};
export type AgendaRecord = Omit<Agenda.View, "questions" | "delegatedBy"> & {
	questions: Omit<Agenda.Question, "request">[];
	owner?: AgendaOwner;
	/** Reservations are durable before an isolated model session can open. */
	assessment?: { id: string; kind: "generate" | "assess" };
};
export type AgendaRun = {
	id: string;
	channelId: string;
	generation: number;
	questionId: string;
	/** The immutable public query; never derived from private assessment output. */
	question: string;
	owner: AgendaOwner;
	workspaceId?: string;
	createdAt: string;
	deadline: string;
};
export type SaveAgenda = {
	record: AgendaRecord;
	expectedRevision: number;
	/** A launch intent is committed in the same transaction as its question/counter. */
	run?: AgendaRun;
	lease: Lease;
};
export interface AgendaStore {
	get(channelId: string): Promise<AgendaRecord | undefined>;
	save(input: SaveAgenda): Promise<AgendaRecord>;
	active(): Promise<string[]>;
	run(channelId: string, requestId: string): Promise<AgendaRun | undefined>;
	linkRun(input: {
		channelId: string;
		requestId: string;
		workspaceId: string;
		lease: Lease;
	}): Promise<void>;
	/** Deletes are driven by the parent-channel cascade. */
}
