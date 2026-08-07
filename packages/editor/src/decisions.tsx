/**
 * The sidecar.
 *
 * Everything the plan is waiting on, and everything it has settled: questions
 * the agent asked, and comments the room made on the prose. Both are decisions
 * in the same sense, so they share one list rather than two tabs — an accepted
 * comment *is* a decision, and would otherwise have to pick a side.
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

import { DraftCard, ThreadCard } from "./comments";
import { useQuestionnaires } from "./questionnaires";
import { useThreads } from "./threads";
import { QuestionnaireCard } from "./widgets/questionnaire";

import type { Transport } from "@chopin/question/react";
import type { QuestionnaireEntry, QuestionnaireStore } from "./questionnaires";
import type { ThreadStore } from "./threads";

export type DecisionsProps = {
	store: QuestionnaireStore;
	threads: ThreadStore;
	wire?: Transport;
	connected?: boolean;
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

export function Decisions({ connected, reveal, store, threads, wire }: DecisionsProps) {
	let entries = useQuestionnaires(store);
	let state = useThreads(threads);
	let content = useRef<HTMLDivElement>(null);
	let [history, setHistory] = useHistory();

	// Leaving the pane should not leave the prose lit. A highlight belongs to
	// the pointer that asked for it, and a pin to the pane that set it.
	useEffect(() => () => {
		store.release();
		threads.release();
	}, [store, threads]);

	useEffect(() => {
		if (!reveal) return;
		let id = CSS.escape(reveal.widget);
		// Either kind of card. An id addressed at a pane that only knows how to
		// find one of them fails by scrolling nowhere, which says nothing.
		let target = content.current?.querySelector<HTMLElement>(
			`[data-plan-sidecar-questionnaire="${id}"], [data-plan-sidecar-thread="${id}"]`,
		);
		target?.scrollIntoView({ block: "center", behavior: "smooth" });
	}, [entries, reveal, state.threads]);

	let open = state.threads.filter(view => view.thread.status === "open");
	let accepted = state.threads.filter(view => view.thread.status === "accepted");
	let waiting = entries.filter(undecided);
	let settled = entries.filter(entry => !undecided(entry));

	let outstanding = waiting.length + open.length;
	let resolved = settled.length + accepted.length;

	let card = (view: (typeof state.threads)[number]) => (
		<ThreadCard
			applied={view.applied}
			busy={!connected}
			focused={state.focused === view.thread.id}
			key={view.thread.id}
			onAccept={() => threads.accept(view.thread.id)}
			onBlur={() => threads.focus(undefined)}
			onDismiss={() => threads.dismiss(view.thread.id)}
			onFocus={() => threads.focus(view.thread.id)}
			onReply={text => threads.reply(view.thread.id, text)}
			onRetry={() => threads.retry(view.thread.id)}
			onReveal={() => threads.reveal(view.thread.id)}
			onTyping={writing => threads.announce(view.thread.id, writing)}
			quote={view.quote}
			view={view}
			writing={state.writing[view.thread.id]}
		/>
	);

	let question = (entry: QuestionnaireEntry) => (
		<QuestionnaireCard
			connected={connected}
			key={entry.id}
			onQuestionEnter={question => store.highlight(entry.id, question)}
			onQuestionLeave={() => store.clear()}
			onQuestionSelect={question => store.reveal(entry.id, question)}
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
				{outstanding > 0 && (
					<span className="text-sm text-text-tertiary tabular-nums">{outstanding}</span>
				)}
			</header>

			<div className="min-h-0 flex-1 overflow-auto p-3" ref={content}>
				{state.draft && (
					<div className="mb-3">
						<DraftCard
							busy={!connected}
							onCancel={() => threads.draft(undefined)}
							onSend={text => threads.start(text)}
							quote={state.draft.quote}
						/>
					</div>
				)}

				{state.error && (
					<p className="mb-3 rounded-md bg-destructive-wash px-2 py-1.5 text-sm text-destructive-ink ring-hairline">
						{state.error} Select the passage again.
					</p>
				)}

				{outstanding === 0 && resolved === 0 && !state.draft
					? (
						<p className="m-0 text-sm text-text-secondary">
							Select any of the plan to comment on it. Questions the agent asks appear here too, and
							both stay as a record of what was decided.
						</p>
					)
					: (
						<div className="flex flex-col gap-3">
							{waiting.map(question)}
							{open.map(card)}
						</div>
					)}

				{resolved > 0 && (
					<div className={outstanding > 0 || state.draft ? "mt-3" : ""}>
						<button
							aria-expanded={history}
							className="w-full rounded-md px-1 py-1 text-left text-sm text-text-quaternary hover:text-text-primary"
							data-press="wide"
							onClick={() => setHistory(value => !value)}
							type="button"
						>
							{history ? "▾" : "▸"} <span className="tabular-nums">{resolved}</span> resolved
						</button>
						{history && (
							<div className="mt-2 flex flex-col gap-3">
								{accepted.map(card)}
								{settled.map(question)}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
