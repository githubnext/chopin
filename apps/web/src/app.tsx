import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwiseIcon, DotsThreeIcon } from "@phosphor-icons/react";
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
import { RepositoryPicker } from "./repository-picker";
import { Wire } from "./wire";
import { useWorkspaceMode, useWorkspaceState, Workspace } from "./workspace";
import { presentWorkspace } from "./workspace-model";

import type { Session } from "@chopin/protocol";
import type { DecisionView, DecisionViewState } from "@chopin/editor";
import type { Status } from "./wire";

function Header(
	{
		members,
		onResetAgent,
		label,
		repository,
	}: {
		members: Session.Member[];
		onResetAgent?: () => Promise<void>;
		label: string;
		repository: Api.Repository;
	},
) {
	let [resetting, setResetting] = useState(false);
	let [resetError, setResetError] = useState(false);
	let resetLabel = resetting ? "Resetting..." : resetError ? "Reset failed" : "New planner session";

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
		<header className="room-header hairline-b relative flex min-h-12 shrink-0 flex-nowrap items-center gap-2 px-2 py-2 sm:h-12 sm:gap-3 sm:px-4 sm:py-0">
			<a className="hidden text-sm font-semibold sm:inline" href="/">chopin</a>
			<span aria-hidden="true" className="hidden h-4 hairline-l sm:block" />
			<RepositoryPicker current={repository} />
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<span aria-hidden="true" className="hidden text-sm text-text-tertiary sm:inline">/</span>
				<span className="min-w-0 flex-1 truncate text-sm text-text-tertiary" title={label}>
					{label}
				</span>
			</div>
			<div
				aria-label={`People here: ${members.map(member => member.handle).join(", ")}`}
				className="room-members ml-auto flex shrink-0 items-center"
				role="group"
			>
				{members.map(member => (
					<span className="room-member-face -ml-1.5 first:ml-0" key={member.client}>
						<Face handle={member.handle} ring size={24} />
					</span>
				))}
				{members.length > 3 && (
					<span
						aria-hidden="true"
						className="room-member-overflow ml-1 hidden text-sm text-text-tertiary"
					>
						+{members.length - 3}
					</span>
				)}
			</div>
			{onResetAgent && (
				<button
					aria-label={resetLabel}
					className="btn btn-sm btn-ghost hidden sm:inline-flex"
					disabled={resetting}
					onClick={() => void resetAgent()}
					type="button"
				>
					<ArrowClockwiseIcon aria-hidden="true" className="lg:hidden" size={16} />
					<span className="hidden lg:inline">{resetLabel}</span>
				</button>
			)}
			{onResetAgent && (
				<details className="room-secondary-actions sm:hidden">
					<summary
						aria-label="More room actions"
						className="btn btn-icon btn-ghost cursor-pointer list-none"
						role="button"
					>
						<DotsThreeIcon aria-hidden="true" size={18} weight="bold" />
					</summary>
					<div className="absolute right-2 top-full z-30 mt-1 min-w-44 rounded-lg bg-page p-1 ring-hairline shadow-overlay">
						<button
							className="btn btn-md btn-ghost w-full justify-start"
							disabled={resetting}
							onClick={() => void resetAgent()}
							type="button"
						>
							<ArrowClockwiseIcon aria-hidden="true" size={16} />
							<span className="ml-1">{resetLabel}</span>
						</button>
					</div>
				</details>
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
		repository,
		room,
	}: {
		agent?: boolean;
		canEdit?: boolean;
		handle: string;
		label: string;
		onResetAgent?: () => Promise<void>;
		repository: Api.Repository;
		room: string;
	},
) {
	let [wire, setWire] = useState<Wire>();
	let [status, setStatus] = useState<Status>("connecting");
	let [members, setMembers] = useState<Session.Member[]>([]);
	let [effectiveCanEdit, setEffectiveCanEdit] = useState(canEdit);
	let user = useMemo(() => cursor(handle), [handle]);
	let mode = useWorkspaceMode();
	let [workspace, dispatch] = useWorkspaceState();
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
	let workspacePresentation = presentWorkspace(workspace, mode, view);
	let conversationActive = workspacePresentation.conversationVisible;
	let [conversationActivity, setConversationActivity] = useState({ unread: 0, busy: false });
	let onConversationActivity = useCallback(
		(event: { type: "message" | "working"; busy: boolean }) => {
			setConversationActivity(current => ({
				busy: event.busy,
				unread: event.type === "message" && !conversationActive
					? current.unread + 1
					: current.unread,
			}));
		},
		[conversationActive],
	);

	useEffect(() => {
		setDecisionView(state => advanceDecisionView(state, hasPlanContent, unanswered));
	}, [hasPlanContent, unanswered]);

	useEffect(() => {
		if (!conversationActive) return;
		setConversationActivity(current => current.unread === 0 ? current : { ...current, unread: 0 });
	}, [conversationActive]);

	useEffect(() => {
		let previous = previousUnanswered.current;
		previousUnanswered.current = unanswered;
		if (!decisionAttention(previous, unanswered)) return;
		setAttention(true);
		let timer = window.setTimeout(() => setAttention(false), 200);
		return () => window.clearTimeout(timer);
	}, [unanswered]);

	let selectView = (next: DecisionView, revealFirst = true) => {
		setDecisionView(state => ({ ...state, preferred: next }));
		if (hasPlanContent) localStorage.setItem("chopin:view:document", next);
		if (next === "decisions" && revealFirst) {
			let first = entries.find(entry =>
				entry.value.questions.some(question => question.answer === undefined)
			);
			setReveal({ widget: first?.id ?? "", token: Date.now() });
		}
	};

	let selectDestination = (destination: "plan" | "decisions") => {
		selectView(destination, mode === "split");
		dispatch({ type: "set-conversation", open: false });
	};

	let setDesktopConversationOpen = (open: boolean) => {
		dispatch({ type: "set-desktop-conversation", open });
		if (!open) dispatch({ type: "set-conversation", open: false });
	};

	let showPlan = (widget: string, question: string) => {
		selectDestination("plan");
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
			onAuthenticationRequired: () => location.assign("/"),
			onStatus: next => {
				setStatus(next);
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
					active={conversationActive}
					agent={agent}
					connected={status === "connected" && effectiveCanEdit}
					handle={handle}
					onActivity={onConversationActivity}
					wire={wire}
				/>
			}
			conversationActivity={conversationActivity}
			header={
				<Header
					members={members}
					onResetAgent={effectiveCanEdit ? onResetAgent : undefined}
					label={label}
					repository={repository}
				/>
			}
			controls={
				<DecisionViewControl
					attention={attention}
					onView={selectDestination}
					unanswered={unanswered}
					view={view}
				/>
			}
			mode={mode}
			onDesktopConversationOpen={setDesktopConversationOpen}
			onConversationOpen={open => dispatch({ type: "set-conversation", open })}
			onDestination={selectDestination}
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
					commentPresentation={mode === "split" ? "popover" : "sheet"}
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
			state={workspace}
			unanswered={unanswered}
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
