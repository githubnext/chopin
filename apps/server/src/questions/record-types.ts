import type { ConversationPlan, Plan as Wired } from "@chopin/protocol";
import type { Definition } from "@chopin/question";

export type OptionOrigin = {
	origin: "chat" | "planner" | "human";
	rationale?: string;
	by?: string;
	source?: ConversationPlan.SourceRef;
};

export type DecisionEntry = {
	choices: string[];
	/** Text for older answers without durable option IDs, keyed by question. */
	answers?: { [questionId: string]: string };
	owner: string;
	at: number;
};

export type Record = {
	id: string;
	definition: Definition;
	/** "answered" is the stored status of a decided card. */
	status: "open" | "answered" | "reopened" | "discarded" | "cancelled" | "expired";
	answers?: { [question: string]: string };
	resolver?: string;
	at?: number;
	anchors?: Wired.WidgetAnchors;
	origin: "planner" | "conversation";
	threadId?: string;
	owner?: string;
	decidedAt?: number;
	choices?: string[];
	history: DecisionEntry[];
	prose?: Wired.Anchor[];
	optionOrigins: { [optionId: string]: OptionOrigin };
	editors: string[];
	/** Durable request keys for shared option appends, bounded by the option limit. */
	appended?: { [key: string]: string };
};
