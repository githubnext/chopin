import { useEffect, useMemo, useRef, useState } from "react";
import { SidebarSimpleIcon } from "@phosphor-icons/react";
import {
	advanceDecisionView,
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
import * as Api from "./api";
import { HostedApp, HostedFailure, HostedLoading, HostedLogin } from "./hosted";
import { Wire } from "./wire";
import { paneId, usePaneOpen, Workspace } from "./workspace";

import type { Session } from "@chopin/protocol";
import type { DecisionView, DecisionViewState } from "@chopin/editor";
import type { Status } from "./wire";

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
			<SidebarSimpleIcon aria-hidden="true" size={18} />
		</button>
	);
}

function Header(
	{
		chatOpen,
		members,
		onToggleChat,
		onResetAgent,
		reason,
		label,
		status,
	}: {
		chatOpen: boolean;
		members: Session.Member[];
		onToggleChat: () => void;
		onResetAgent?: () => Promise<void>;
		reason?: string;
		label: string;
		status: Status;
	},
) {
	let [resetting, setResetting] = useState(false);
	let [resetError, setResetError] = useState(false);

	async function resetAgent() {
		if (!onResetAgent || resetting) return;
		setResetting(true);
		setResetError(false);
		try {
			await onResetAgent();
		} catch {
			setResetError(true);
		} finally {
			setResetting(false);
		}
	}

	return (
		<header className="hairline-b flex h-12 shrink-0 items-center gap-3 px-4">
			<PaneToggle onToggle={onToggleChat} open={chatOpen} />
			<span className="text-sm font-semibold">chopin</span>
			<span className="truncate text-sm text-text-tertiary">{label}</span>
			<span className={`text-sm ${TONE[status]}`}>
				{status === "connected" ? reason : reason ?? status}
			</span>
			<div
				aria-label={`People here: ${members.map(member => member.handle).join(", ")}`}
				className="ml-auto flex items-center [&>*+*]:-ml-1.5"
			>
				{members.map(member => <Face handle={member.handle} key={member.client} ring size={24} />)}
			</div>
			{onResetAgent && (
				<button
					className="btn btn-sm btn-ghost"
					disabled={resetting}
					onClick={() => void resetAgent()}
					type="button"
				>
					{resetting ? "Resetting..." : resetError ? "Reset failed" : "New planner session"}
				</button>
			)}
		</header>
	);
}

export function RoomWorkspace(
	{
		agent = true,
		canEdit = true,
		handle,
		label,
		onResetAgent,
		room,
	}: {
		agent?: boolean;
		canEdit?: boolean;
		handle: string;
		label: string;
		onResetAgent?: () => Promise<void>;
		room: string;
	},
) {
	let [wire, setWire] = useState<Wire>();
	let [status, setStatus] = useState<Status>("connecting");
	let [reason, setReason] = useState<string>();
	let [members, setMembers] = useState<Session.Member[]>([]);
	let [effectiveCanEdit, setEffectiveCanEdit] = useState(canEdit);
	let user = useMemo(() => cursor(handle), [handle]);
	let [chatOpen, setChatOpen] = usePaneOpen("chat");
	let [questions] = useState(() => new QuestionnaireStore());
	let [threads] = useState(() => new ThreadStore());
	let [reveal, setReveal] = useState<{ widget: string; token: number }>();
	let [planScrollTop, setPlanScrollTop] = useState(0);
	let entries = useQuestionnaires(questions);
	let unanswered = countUnanswered(entries);
	let hasPlanContent = useHasPlanContent(questions);
	let [decisionView, setDecisionView] = useState<DecisionViewState>(() => {
		let stored = localStorage.getItem("chopin:view:document");
		return {
			phase: "initial",
			preferred: stored === "decisions" ? "decisions" : "plan",
		};
	});
	let view = visibleDecisionView(decisionView, hasPlanContent, unanswered);
	let previousUnanswered = useRef(unanswered);
	let [attention, setAttention] = useState(false);

	useEffect(() => {
		setDecisionView(state => advanceDecisionView(state, hasPlanContent, unanswered));
	}, [hasPlanContent, unanswered]);

	useEffect(() => {
		let previous = previousUnanswered.current;
		previousUnanswered.current = unanswered;
		if (!decisionAttention(previous, unanswered)) return;
		setAttention(true);
		let timer = window.setTimeout(() => setAttention(false), 200);
		return () => window.clearTimeout(timer);
	}, [unanswered]);

	let selectView = (next: DecisionView) => {
		setDecisionView(state => ({ ...state, preferred: next }));
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
		setEffectiveCanEdit(canEdit);
	}, [canEdit, room]);

	useEffect(() => {
		let socket = new Wire({
			channelId: room,
			onStatus: (next, why) => {
				setStatus(next);
				setReason(why);
			},
		});
		setWire(socket);

		let off = [
			socket.on<Session.Hello>("session:hello", frame => {
				setMembers(frame.members);
				setEffectiveCanEdit(frame.canEdit);
			}),
			socket.on<Session.Presence>("session:presence", frame => setMembers(frame.members)),
			socket.on<Session.Access>("session:access", frame => setEffectiveCanEdit(frame.canEdit)),
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
					agent={agent}
					connected={status === "connected" && effectiveCanEdit}
					handle={handle}
					wire={wire}
				/>
			}
			chatOpen={chatOpen}
			header={
				<Header
					chatOpen={chatOpen}
					members={members}
					onToggleChat={() => setChatOpen(value => !value)}
					onResetAgent={effectiveCanEdit ? onResetAgent : undefined}
					reason={status === "connected" && !effectiveCanEdit ? "view only" : reason}
					label={label}
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
					connected={status === "connected" && effectiveCanEdit}
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
					readOnly={!effectiveCanEdit}
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
	let [session, setSession] = useState<Api.Session>();
	let [error, setError] = useState<unknown>();

	useEffect(() => {
		let active = true;
		Api.session().then(value => {
			if (active) setSession(value);
		}, reason => {
			if (active) setError(reason);
		});
		return () => {
			active = false;
		};
	}, []);

	if (error) return <HostedFailure error={error} />;
	if (!session) return <HostedLoading />;
	if (!session.user) return <HostedLogin />;
	return <HostedApp Workspace={RoomWorkspace} agent={session.agent} user={session.user} />;
}
