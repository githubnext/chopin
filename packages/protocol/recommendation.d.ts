/** Evidence available to an advisory assessment; it does not establish Build eligibility. */
export type RecommendationChanged = {
	kind: "recommendation:changed";
	ts: number;
};

export type RecommendationEvidence = {
	id: string;
	kind: "document" | "discussion" | "decision" | "repository" | "investigation" | "research";
	label: string;
	detail: string;
};

export type BuildRecommendation = {
	kind: "build" | "clarify" | "investigate";
	title: string;
	/** The smallest coherent outcome; a proposal, never an approved graph. */
	scope: string;
	reasons: string[];
	/** Concrete prerequisites for the proposed scope. */
	dependencies: string[];
	/** Broader questions that need not prevent that scope. */
	optional: string[];
	/** IDs from the supplied evidence only. */
	evidenceIds: string[];
	/** A proposed discussion prompt; sent to the Planner only by a person's press. */
	nextAction: string;
};

export type RecommendationSnapshot =
	| { state: "unavailable" }
	| { state: "pending" | "failed" | "quiet"; key: string }
	| {
		state: "ready";
		key: string;
		planRevision: number;
		recommendation: BuildRecommendation;
		evidence: RecommendationEvidence[];
	};
