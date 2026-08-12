/**
 * The focused questionnaire view.
 *
 * Unanswered cards stay in document order, because the first is where a room
 * resumes its work. Resolved history starts closed: it remains available without
 * making a long-lived room open below the questions that still need an answer.
 */

import { useEffect, useRef, useState } from "react";

import { Count } from "./count";
import { useQuestionnaires } from "./questionnaires";
import { QuestionnaireCard } from "./widgets/questionnaire";

import type { Transport } from "@chopin/question/react";
import type { QuestionnaireEntry, QuestionnaireStore } from "./questionnaires";

export type DecisionsProps = {
	store: QuestionnaireStore;
	wire?: Transport;
	connected?: boolean;
	/** Reveal the plan before taking the reader to a questionnaire's result. */
	onShowPlan?: (widget: string, question: string) => void;
	/**
	 * An item to bring into view.
	 *
	 * Carries a token as well as an id so asking for the same one twice still
	 * scrolls — naming it again means "show me", not "it is already open".
	 */
	reveal?: { widget: string; token: number };
};

function undecided(entry: QuestionnaireEntry): boolean {
	return entry.value.questions.some(question => question.answer === undefined);
}

/** Where the disclosure is remembered, with the other personal layout choices. */
let HISTORY = "chopin:decisions:resolved";

/**
 * Whether the resolved list is showing, remembered across reloads.
 *
 * Only an explicit open preference expands history. An absent or malformed
 * value means a room starts with its unanswered cards in view.
 */
function useHistory() {
	let [history, setHistory] = useState(() => localStorage.getItem(HISTORY) === "true");

	useEffect(() => {
		localStorage.setItem(HISTORY, String(history));
	}, [history]);

	return [history, setHistory] as const;
}

export function Decisions({ connected, onShowPlan, reveal, store, wire }: DecisionsProps) {
	let entries = useQuestionnaires(store);
	let content = useRef<HTMLDivElement>(null);
	let heading = useRef<HTMLHeadingElement>(null);
	let [history, setHistory] = useHistory();

	// Leaving the pane should not leave the prose lit. A highlight belongs to
	// the pointer that asked for it, and a pin to the pane that set it.
	useEffect(() => () => {
		store.release();
	}, [store]);

	useEffect(() => {
		if (!reveal) return;
		let id = CSS.escape(reveal.widget);
		let target = content.current?.querySelector<HTMLElement>(
			`[data-plan-sidecar-questionnaire="${id}"]`,
		);
		if (target) {
			target.scrollIntoView({ block: "center", behavior: "smooth" });
			target.tabIndex = -1;
			target.focus({ preventScroll: true });
		} else heading.current?.focus();
	}, [entries, reveal]);

	let waiting = entries.filter(undecided);
	let settled = entries.filter(entry => !undecided(entry));

	let outstanding = waiting.length;
	let resolved = settled.length;

	let question = (entry: QuestionnaireEntry) => (
		<QuestionnaireCard
			connected={connected}
			key={entry.id}
			onQuestionEnter={question => store.highlight(entry.id, question)}
			onQuestionLeave={() => store.clear()}
			onQuestionSelect={question => {
				if (onShowPlan) onShowPlan(entry.id, question);
				else store.reveal(entry.id, question);
			}}
			places={store.counts(entry.id)}
			value={entry.value}
			wire={wire}
		/>
	);

	return (
		<div className="plan-decisions">
			<header className="flex shrink-0 items-center gap-2 px-3 py-2 hairline-b">
				<h2
					className="text-sm font-semibold tracking-wide text-text-tertiary uppercase"
					ref={heading}
					tabIndex={-1}
				>
					Decisions
				</h2>
				{outstanding > 0 && <Count>{outstanding}</Count>}
			</header>

			<div className="min-h-0 flex-1 overflow-auto p-3" ref={content}>
				{outstanding === 0 && resolved === 0
					? (
						<p className="m-0 text-sm text-text-secondary">
							Questions the agent asks appear here and remain as a record of what was decided.
						</p>
					)
					: (
						<div className="flex flex-col gap-3">
							{waiting.map(question)}
						</div>
					)}

				{resolved > 0 && (
					<div className={outstanding > 0 ? "mt-3" : ""}>
						<button
							aria-expanded={history}
							className="btn btn-sm btn-ghost w-full justify-start text-left"
							data-press="wide"
							onClick={() => setHistory(value => !value)}
							type="button"
						>
							{history ? "▾" : "▸"} <span className="tabular-nums">{resolved}</span> resolved
						</button>
						{history && (
							<div className="mt-2 flex flex-col gap-3">
								{settled.map(question)}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
