/**
 * The sidecar.
 *
 * Everything the plan is waiting on, and everything it has settled: questions
 * the agent asked. Comments stay where they were made, as document chrome.
 *
 * Outstanding items come first, in document order, because one of those is
 * blocking somebody. Everything resolved follows, showing: it is the record of
 * what the room settled, and a decision nobody can see is one that gets made a
 * second time. The disclosure stays because resolved items are kept forever and
 * a long-lived plan will out-scroll the pane — and which way it is left is
 * remembered, since collapsing it and finding it open again on the next load
 * reads as a toggle that does not work. A dismissed thread is not shown at all;
 * the transcript is where it left its trace.
 *
 * An item also knows where it lives. Hovering a question lights the passage it
 * concerns; hovering a comment lights the phrase it marks. Clicking either goes
 * there — which is the only way to reach the prose an accepted comment
 * produced, since a `<Decision>` draws nothing in the document and the pane is
 * the whole of where it can be seen. The highlight is written to the DOM rather
 * than the document — it is one reader's pointer, not a fact about the plan,
 * and putting it in the document would send it to everybody else and make it
 * undoable.
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

/** Where the disclosure is remembered, alongside the pane widths. */
let HISTORY = "chopin:decisions:resolved";

/**
 * Whether the resolved list is showing, remembered across reloads.
 *
 * Anything other than the one stored string reads as open, so an absent key and
 * a corrupt one both mean nobody has collapsed this — which is the default.
 */
function useHistory() {
	let [history, setHistory] = useState(() => localStorage.getItem(HISTORY) !== "false");

	useEffect(() => {
		localStorage.setItem(HISTORY, String(history));
	}, [history]);

	return [history, setHistory] as const;
}

export function Decisions({ connected, onShowPlan, reveal, store, wire }: DecisionsProps) {
	let entries = useQuestionnaires(store);
	let content = useRef<HTMLDivElement>(null);
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
		target?.scrollIntoView({ block: "center", behavior: "smooth" });
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
				<span className="text-sm font-semibold tracking-wide text-text-tertiary uppercase">
					Decisions
				</span>
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
