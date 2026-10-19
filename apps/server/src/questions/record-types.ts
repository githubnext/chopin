import type { ConversationPlan, Plan as Wired, Question } from "@chopin/protocol";
import type { Definition } from "@chopin/question";

export type OptionOrigin = {
	origin: "chat" | "planner" | "human";
	rationale?: string;
	by?: string;
	source?: ConversationPlan.SourceRef;
};

export type DecisionEntry = {
	choices: string[];
	/** Written answers, including legacy custom answers, keyed by question. */
	answers?: { [questionId: string]: string };
	owner: string;
	at: number;
	/** The settled decision's why, kept when it is reopened. */
	why?: string;
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
	origin: "planner" | "conversation" | "human";
	threadId?: string;
	owner?: string;
	decidedAt?: number;
	choices?: string[];
	history: DecisionEntry[];
	prose?: Wired.Anchor[];
	/** Anchored Planner captures continue only after an explicitly saved answer. */
	followUp?: { scope: string; target: Wired.Anchor[]; appliedGeneration?: number };
	optionOrigins: { [optionId: string]: OptionOrigin };
	editors: string[];
	/** Durable request keys for shared option appends, bounded by the option limit. */
	appended?: { [key: string]: string };
	findings?: Question.Finding[];
	/** The decision's own child document. */
	childId?: string;
	/** One plain sentence on why the decision went this way; only a settled decision has one. */
	why?: string;
	/** Who wrote `why`. Absent when Chopin drafted it, so a person's words are never replaced. */
	whyBy?: string;
};
