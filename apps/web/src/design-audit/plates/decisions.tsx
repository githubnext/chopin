import { DecisionCard, Decisions, QuestionnaireCard } from "@chopin/editor";
import { DECIDED, questionnaireFixtureStore } from "@chopin/editor/questionnaire-fixtures";

import { motionContract } from "../../motion-contract";
import { AuditPlate, StateLabel } from "../frame";

import type { Questionnaire } from "@chopin/dialect";
import type { ReactNode } from "react";

let DENSITY: Questionnaire = {
	id: "audit-density",
	questions: [{
		id: "q",
		header: "Navigation",
		prompt: "Which density should the navigation use?",
		multiple: false,
		options: [{ id: "compact", label: "Compact" }, { id: "comfortable", label: "Comfortable" }],
	}],
};

let ROLLOUT: Questionnaire = {
	id: "audit-rollout",
	questions: [{
		id: "q",
		header: "Rollout",
		prompt: "How should we introduce the new document workflow?",
		multiple: false,
		options: [{ id: "flag", label: "Behind a flag" }, { id: "all", label: "Everyone at once" }],
	}],
};

let DENSITY_DECIDED: Questionnaire = {
	...DENSITY,
	id: "audit-density-decided",
	by: "olivia",
	at: "2026-08-28T10:00:00.000Z",
	status: "decided",
	questions: DENSITY.questions.map(question => ({
		...question,
		answer: "Compact",
		choices: ["compact"],
	})),
};

let DECK = questionnaireFixtureStore([DENSITY, ROLLOUT]);
let SINGLE = questionnaireFixtureStore([{ ...ROLLOUT, id: "audit-rollout-single" }, {
	...DECIDED,
	id: "audit-auth-single",
}]);
let RESOLVED = questionnaireFixtureStore([DENSITY_DECIDED, { ...DECIDED, id: "audit-auth" }]);
let EMPTY = questionnaireFixtureStore([]);

let MOTION = motionContract("collapse");
let QUESTION_MOTION = { contract: motionContract("content-swap"), immediately: () => false };

function Pane({ label, store }: { label: string; store: typeof DECK }) {
	return (
		<Sample label={label}>
			<Decisions
				motion={MOTION}
				questionMotion={QUESTION_MOTION}
				self="maggieappleton"
				store={store}
			/>
		</Sample>
	);
}

function Sample({ children, label }: { children: ReactNode; label: string }) {
	return (
		<div className="design-audit-decisions-sample">
			<StateLabel>{label}</StateLabel>
			{children}
		</div>
	);
}

export function DecisionsPlate() {
	return (
		<AuditPlate
			description="The Decisions pane with an open deck, one open decision, resolved history, relation notes and no decisions."
			item="decisions"
			title="Decisions"
		>
			<div className="design-audit-decisions-grid">
				<Pane label="Two open decisions" store={DECK} />
				<Pane label="One open decision with history" store={SINGLE} />
				<Pane label="Resolved only" store={RESOLVED} />
				<Pane label="No decisions yet" store={EMPTY} />
				<Sample label="Resolved, related text removed and no related text">
					{/* Each card as Decisions lists it, with the relation its store would report. */}
					<div className="plan-decisions">
						<div className="design-audit-decisions-stack">
							<QuestionnaireCard
								presentation="list"
								relations={{ q: "orphaned" }}
								value={{ ...DECIDED, id: "audit-orphaned" }}
							/>
							<QuestionnaireCard
								presentation="list"
								relations={{ q: "empty" }}
								value={{ ...DENSITY_DECIDED, id: "audit-empty" }}
							/>
						</div>
					</div>
				</Sample>
				<Sample label="Accepted comment in the prose (legacy record)">
					<DecisionCard
						value={{
							at: "2026-08-28T10:00:00.000Z",
							by: "maggieappleton",
							id: "audit-decision",
							notes: [{
								by: "maggieappleton",
								text: "Use compact rows, with comfortable section spacing.",
							}],
							quote: "Navigation density",
						}}
					/>
				</Sample>
			</div>
		</AuditPlate>
	);
}
