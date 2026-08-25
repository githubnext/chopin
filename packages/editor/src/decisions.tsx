/**
 * The focused questionnaire view.
 *
 * Unanswered cards stay in document order, because the first is where a room
 * resumes its work. Resolved history starts closed: it remains available without
 * making a long-lived room open below the questions that still need an answer.
 */

import { useEffect, useId, useRef, useState } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";

import { MotionDisclosure, MotionDisclosureIcon } from "./disclosure-motion";
import { useQuestionnaires } from "./questionnaires";
import { QuestionnaireCard } from "./widgets/questionnaire";

import type { Transport } from "@chopin/question/react";
import type { MotionDisclosureContract } from "./disclosure-motion";
import type { QuestionnaireEntry, QuestionnaireStore } from "./questionnaires";

export type DecisionsProps = {
	store: QuestionnaireStore;
	motion: MotionDisclosureContract;
	motionImmediately?: () => boolean;
	wire?: Transport;
	connected?: boolean;
	headingId?: string;
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

let HISTORY = "chopin:decisions:resolved";

/** Resolved history stays closed unless the reader explicitly opened it. */
function useHistory() {
	let [history, setHistory] = useState(() => localStorage.getItem(HISTORY) === "true");

	useEffect(() => {
		localStorage.setItem(HISTORY, String(history));
	}, [history]);

	return [history, setHistory] as const;
}

export function Decisions(
	{ connected, headingId, motion, motionImmediately, onShowPlan, reveal, store, wire }:
		DecisionsProps,
) {
	let entries = useQuestionnaires(store);
	let content = useRef<HTMLDivElement>(null);
	let heading = useRef<HTMLHeadingElement>(null);
	let focusedQuestionnaire = useRef<HTMLElement | undefined>(undefined);
	let revealed = useRef<number | undefined>(undefined);
	let [history, setHistory] = useHistory();
	let historyId = useId();

	// Leaving the pane should not leave the prose lit. A highlight belongs to
	// the pointer that asked for it, and a pin to the pane that set it.
	useEffect(() => () => {
		store.release();
	}, [store]);

	useEffect(() => {
		if (!reveal || revealed.current === reveal.token) return;
		revealed.current = reveal.token;
		let id = CSS.escape(reveal.widget);
		let target = content.current?.querySelector<HTMLElement>(
			`[data-plan-sidecar-questionnaire="${id}"]`,
		);
		if (target) {
			target.scrollIntoView({ block: "center" });
			target.tabIndex = -1;
			target.focus({ preventScroll: true });
		} else heading.current?.focus();
	}, [entries, reveal]);

	// Removing a focused card sends focus to body without a blur event. Remember
	// the actual card so its removal can hand focus to the remaining work.
	useEffect(() => {
		let previous = focusedQuestionnaire.current;
		if (!previous || previous.isConnected || document.activeElement !== document.body) return;
		focusedQuestionnaire.current = undefined;
		let next = entries.find(undecided);
		let target = next
			? content.current?.querySelector<HTMLElement>(
				`[data-plan-sidecar-questionnaire="${CSS.escape(next.id)}"]`,
			)
			: undefined;
		if (target) {
			target.tabIndex = -1;
			target.focus({ preventScroll: true });
		} else heading.current?.focus({ preventScroll: true });
	}, [entries]);

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
			<h2 className="sr-only" id={headingId} ref={heading} tabIndex={-1}>Decisions</h2>

			<div
				className="plan-decisions-content min-h-0 flex-1 overflow-auto"
				data-plan-decisions-scroll=""
				onBlurCapture={event => {
					let next = event.relatedTarget;
					if (next instanceof Node && !event.currentTarget.contains(next)) {
						focusedQuestionnaire.current = undefined;
					}
				}}
				onFocusCapture={event => {
					focusedQuestionnaire.current = (event.target as HTMLElement).closest<HTMLElement>(
						"[data-plan-sidecar-questionnaire]",
					) ?? undefined;
				}}
				ref={content}
			>
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
					<div className={`min-w-0 ${outstanding > 0 ? "mt-3" : ""}`}>
						<button
							aria-controls={historyId}
							aria-expanded={history}
							className="btn btn-sm btn-ghost h-auto min-h-6 w-full flex-wrap justify-start gap-2 text-left"
							data-press="wide"
							onClick={() => setHistory(value => !value)}
							type="button"
						>
							<MotionDisclosureIcon open={history}>
								<CaretRightIcon size={16} weight="bold" />
							</MotionDisclosureIcon>
							<span className="tabular-nums">{resolved}</span>
							<span>resolved</span>
						</button>
						<MotionDisclosure
							className="plan-decision-history-motion"
							id={historyId}
							immediately={motionImmediately?.() ?? false}
							motion={motion}
							open={history}
							surface="decision-history"
						>
							<div className="mt-2 flex flex-col gap-3">
								{settled.map(question)}
							</div>
						</MotionDisclosure>
					</div>
				)}
			</div>
		</div>
	);
}
