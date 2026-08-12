import { useEffect, useMemo, useRef, useState } from "react";
import {
	countUnanswered,
	cursor,
	Decisions,
	Face,
	PlanEditor,
	QuestionnaireStore,
	ThreadStore,
	useHasPlanContent,
	useQuestionnaires,
	visibleDecisionView,
} from "@chopin/editor";

import { Chat } from "./chat/chat";
import { decisionAttention, DecisionViewControl } from "./decision-view-control";
import * as Identity from "./identity";
import { Wire } from "./wire";
import { paneId, usePaneOpen, Workspace } from "./workspace";

import type { Session } from "@chopin/protocol";
import type { DecisionView } from "@chopin/editor";
import type { Status } from "./wire";

/**
 * Claim a handle.
 *
 * Deliberately not a login. The field exists so that two windows are two
 * people, which is the whole of what identity has to achieve here.
 */
function SignIn({ onDone }: { onDone: (handle: string) => void }) {
	let [value, setValue] = useState("");
	let valid = Identity.validHandle(value);

	return (
		<div className="flex h-full items-center justify-center">
			<form
				className="flex w-80 flex-col gap-3"
				onSubmit={event => {
					event.preventDefault();
					if (!valid) return;
					Identity.remember(value);
					onDone(value);
				}}
			>
				<label className="text-sm font-medium" htmlFor="handle">GitHub handle</label>
				<input
					autoFocus
					className="field px-3 py-2 text-sm"
					id="handle"
					onChange={event => setValue(event.target.value.trim())}
					placeholder="octocat"
					value={value}
				/>
				<p className="text-sm text-text-secondary">
					Unverified. Used for your cursor, your face, and your name against decisions.
				</p>
				<button
					className="btn btn-md btn-primary"
					disabled={!valid}
					type="submit"
				>
					Join
				</button>
			</form>
		</div>
	);
}

const TONE: Record<Status, string> = {
	connecting: "text-text-tertiary",
	connected: "text-text-tertiary",
	reconnecting: "text-warning-ink",
	denied: "text-destructive-ink",
	closed: "text-text-tertiary",
};

function PaneToggle({ onToggle, open }: { onToggle: () => void; open: boolean }) {
	return (
		<button
			aria-controls={paneId("chat")}
			aria-expanded={open}
			aria-label={`${open ? "Hide" : "Show"} conversation pane`}
			className="btn btn-icon btn-ghost shrink-0"
			onClick={onToggle}
			type="button"
		>
			<svg aria-hidden="true" fill="none" height="18" viewBox="0 0 20 20" width="18">
				<rect height="13" rx="2" stroke="currentColor" width="15" x="2.5" y="3.5" />
				<path d="M8 3.5v13" stroke="currentColor" />
			</svg>
		</button>
	);
}

function Header(
	{
		chatOpen,
		members,
		onToggleChat,
		reason,
		room,
		status,
	}: {
		chatOpen: boolean;
		members: Session.Member[];
		onToggleChat: () => void;
		reason?: string;
		room: string;
		status: Status;
	},
) {
	return (
		<header className="hairline-b flex h-12 shrink-0 items-center gap-3 px-4">
			<PaneToggle onToggle={onToggleChat} open={chatOpen} />
			<span className="text-sm font-semibold">chopin</span>
			<span className="text-sm text-text-tertiary">/r/{room}</span>
			<span className={`text-sm ${TONE[status]}`}>
				{status === "connected" ? reason : reason ?? status}
			</span>
			<div
				aria-label={`People here: ${members.map(member => member.handle).join(", ")}`}
				className="ml-auto flex items-center [&>*+*]:-ml-1.5"
			>
				{members.map(member => <Face handle={member.handle} key={member.client} ring size={24} />)}
			</div>
		</header>
	);
}

function Room({ handle }: { handle: string }) {
	let [wire, setWire] = useState<Wire>();
	let [status, setStatus] = useState<Status>("connecting");
	let [reason, setReason] = useState<string>();
	let [members, setMembers] = useState<Session.Member[]>([]);
	let room = Identity.room();
	let user = useMemo(() => cursor(handle), [handle]);
	let [chatOpen, setChatOpen] = usePaneOpen("chat");
	// Written from inside the editor, read by the Decisions document view.
	let [questions] = useState(() => new QuestionnaireStore());
	let [threads] = useState(() => new ThreadStore());
	let [reveal, setReveal] = useState<{ widget: string; token: number }>();
	let [planScrollTop, setPlanScrollTop] = useState(0);
	let entries = useQuestionnaires(questions);
	let unanswered = countUnanswered(entries);
	let hasPlanContent = useHasPlanContent(questions);
	let [preferredView, setPreferredView] = useState<DecisionView>(() => {
		let stored = localStorage.getItem("chopin:view:document");
		return stored === "decisions" ? "decisions" : "plan";
	});
	let [enteredForcedOpening, setEnteredForcedOpening] = useState(false);
	let view = visibleDecisionView(
		preferredView,
		hasPlanContent,
		unanswered,
		enteredForcedOpening,
	);
	let previousUnanswered = useRef(unanswered);
	let [attention, setAttention] = useState(false);

	useEffect(() => {
		if (!hasPlanContent && unanswered > 0) setEnteredForcedOpening(true);
	}, [hasPlanContent, unanswered]);

	useEffect(() => {
		if (hasPlanContent) localStorage.setItem("chopin:view:document", preferredView);
	}, [hasPlanContent, preferredView]);

	useEffect(() => {
		let previous = previousUnanswered.current;
		previousUnanswered.current = unanswered;
		if (!decisionAttention(previous, unanswered)) return;
		setAttention(true);
		let timer = window.setTimeout(() => setAttention(false), 200);
		return () => window.clearTimeout(timer);
	}, [unanswered]);

	let selectView = (next: DecisionView) => {
		// A new room stays in its opening questions until prose proves the first
		// draft exists. Once there is prose, a person takes control of the view.
		if (hasPlanContent) setEnteredForcedOpening(false);
		setPreferredView(next);
		if (hasPlanContent) localStorage.setItem("chopin:view:document", next);
		if (next === "decisions") {
			let first = entries.find(entry =>
				entry.value.questions.some(question => question.answer === undefined)
			);
			setReveal({ widget: first?.id ?? "", token: Date.now() });
		}
	};

	let showPlan = (widget: string, question: string) => {
		selectView("plan");
		requestAnimationFrame(() => {
			questions.reveal(widget, question);
			let card = document.querySelector<HTMLElement>(
				`[data-document-view="plan"] article[data-plan-sidecar-questionnaire="${
					CSS.escape(widget)
				}"]`,
			);
			if (!card) return;
			card.tabIndex = -1;
			card.focus();
		});
	};

	useEffect(() => {
		let socket = new Wire({
			room,
			handle,
			key: Identity.key(),
			onStatus: (next, why) => {
				setStatus(next);
				setReason(why);
			},
		});
		setWire(socket);

		let off = [
			socket.on<Session.Hello>("session:hello", frame => setMembers(frame.members)),
			socket.on<Session.Presence>("session:presence", frame => setMembers(frame.members)),
			threads.listen(socket),
		];

		return () => {
			for (let unsubscribe of off) unsubscribe();
			socket.dispose();
			setWire(undefined);
		};
	}, [room, handle, threads]);

	return (
		<Workspace
			chat={
				<Chat
					connected={status === "connected"}
					handle={handle}
					onReveal={widget => {
						selectView("decisions");
						setReveal({ widget: widget || entries[0]?.id || "", token: Date.now() });
					}}
					waiting={unanswered}
					wire={wire}
				/>
			}
			chatOpen={chatOpen}
			header={
				<Header
					chatOpen={chatOpen}
					members={members}
					onToggleChat={() => setChatOpen(value => !value)}
					reason={reason}
					room={room}
					status={status}
				/>
			}
			controls={
				<DecisionViewControl
					attention={attention}
					onView={selectView}
					unanswered={unanswered}
					view={view}
				/>
			}
			decisions={
				<Decisions
					connected={status === "connected"}
					onShowPlan={showPlan}
					reveal={reveal}
					store={questions}
					wire={wire}
				/>
			}
			plan={
				<PlanEditor
					connection={status}
					onScrollTop={setPlanScrollTop}
					questions={questions}
					scrollTop={planScrollTop}
					threads={threads}
					user={user}
					wire={wire}
				/>
			}
			view={view}
		/>
	);
}

export function App() {
	let [handle, setHandle] = useState(Identity.handle);
	if (!handle) return <SignIn onDone={setHandle} />;
	return <Room handle={handle} />;
}
