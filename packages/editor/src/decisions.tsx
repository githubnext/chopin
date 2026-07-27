/**
 * The decisions pane.
 *
 * Every question the plan has asked, open ones first. This is the only place a
 * questionnaire is answered: the plan node itself renders nothing, because a
 * form sitting inline in prose competes with the prose, and because a decision
 * is worth keeping visible after it has been made.
 *
 * Answering is collaborative. Everyone here is editing one draft, so what you
 * type appears under the other person's cursor, and whoever submits it is
 * recorded as having decided.
 */

import { useEffect, useRef } from "react";

import { useQuestionnaires } from "./questionnaires";
import { QuestionnaireCard } from "./widgets/questionnaire";

import type { Transport } from "@chopin/question/react";
import type { QuestionnaireEntry, QuestionnaireStore } from "./questionnaires";

export type DecisionsProps = {
	store: QuestionnaireStore;
	wire?: Transport;
	connected?: boolean;
	/**
	 * A questionnaire to bring into view.
	 *
	 * Carries a token as well as an id so asking for the same one twice still
	 * scrolls — naming it again means "show me", not "it is already open".
	 */
	reveal?: { widget: string; token: number };
};

function undecided(entry: QuestionnaireEntry): boolean {
	return entry.value.questions.some(question => question.answer === undefined);
}

export function Decisions({ connected, reveal, store, wire }: DecisionsProps) {
	let entries = useQuestionnaires(store);
	let content = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!reveal) return;
		let target = content.current?.querySelector<HTMLElement>(
			`[data-plan-sidecar-questionnaire="${CSS.escape(reveal.widget)}"]`,
		);
		target?.scrollIntoView({ block: "center", behavior: "smooth" });
	}, [entries, reveal]);

	// Undecided first: one of those is blocking somebody, the rest are history.
	let ordered = [...entries].sort((a, b) => Number(undecided(b)) - Number(undecided(a)));

	return (
		<div className="plan-decisions">
			<header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
				<span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
					Decisions
				</span>
				{entries.length > 0 && (
					<span className="text-xs text-muted-foreground">{entries.length}</span>
				)}
			</header>

			<div className="min-h-0 flex-1 overflow-auto p-3" ref={content}>
				{ordered.length === 0
					? (
						<p className="m-0 text-xs text-muted-foreground">
							Questions the agent asks appear here, and stay as a record of what was decided.
						</p>
					)
					: (
						<div className="flex flex-col gap-3">
							{ordered.map(entry => (
								<QuestionnaireCard
									connected={connected}
									key={entry.id}
									value={entry.value}
									wire={wire}
								/>
							))}
						</div>
					)}
			</div>
		</div>
	);
}
