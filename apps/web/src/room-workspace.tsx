import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { documentPath } from "@chopin/protocol/document-url";
import {
	advanceDecisionView,
	aggregateJobs,
	countUnanswered,
	currentJobs,
	cursor,
	Decisions,
	Face,
	JobStore,
	PlanEditor,
	QuestionnaireStore,
	Tasks,
	ThreadStore,
	useHasPlanContent,
	useJobs,
	useQuestionnaires,
	visibleDecisionView,
} from "@chopin/editor";

import bookBookmarkIcon from "./assets/figma/navigation/book-bookmark.svg";
import chevronDownIcon from "./assets/icons/tool-chevron-down.svg";
import { Chat } from "./chat/chat";
import { rememberChannel } from "./channel-recovery";
import { decisionAttention, DecisionViewControl } from "./decision-view-control";
import { useNavigationDocument } from "./navigation-shell";
import { NavigationIcon } from "./project-sidebar";
import { peopleHere } from "./presence";
import { Wire } from "./wire";
import { HEADING, useWorkspaceMode, useWorkspaceState, Workspace } from "./workspace";
import { presentWorkspace } from "./workspace-model";

import type { Session } from "@chopin/protocol";
import type { DecisionView, DecisionViewState } from "@chopin/editor";
import type { HostedWorkspaceProps } from "./hosted";
import type { Status } from "./wire";

export function Header(
	{
		canEdit,
		members,
		label,
		onRename,
	}: {
		canEdit: boolean;
		members: Session.Member[];
		label: string;
		onRename: () => void;
	},
) {
	let people = peopleHere(members);
	return (
		<header className="room-header relative flex min-h-12 shrink-0 flex-nowrap items-center px-2 py-2 sm:h-[calc(3rem+env(safe-area-inset-top))] sm:px-5 sm:py-0 lg:h-[calc(50px+env(safe-area-inset-top))]">
			<div
				aria-label={`Document: ${label}`}
				className="flex min-w-0 flex-1 items-center gap-0.5"
			>
				<NavigationIcon className="opacity-50" src={bookBookmarkIcon} />
				<button
					aria-label={`Rename ${label}`}
					className="document-title-trigger"
					disabled={!canEdit}
					onClick={onRename}
					type="button"
				>
					<span className="truncate">{label}</span>
					<img alt="" aria-hidden="true" className="size-3.5 opacity-50" src={chevronDownIcon} />
				</button>
			</div>
			<div
				aria-label={`People here: ${people.join(", ")}`}
				className="room-members ml-auto flex shrink-0 items-center"
				role="group"
			>
				{people.map(handle => (
					<span className="room-member-face -ml-1.5 first:ml-0" key={handle.toLowerCase()}>
						<Face handle={handle} ring="ground" size={24} />
					</span>
				))}
				{people.length > 3 && (
					<span
						aria-hidden="true"
						className="room-member-overflow ml-1 hidden text-sm text-text-tertiary"
					>
						+{people.length - 3}
					</span>
				)}
			</div>
		</header>
	);
}

export function RoomWorkspace(
	{
		agent = true,
		canEdit = true,
		handle,
		label,
		repository,
		room,
		slug,
		updatedAt,
		userId,
	}: HostedWorkspaceProps,
) {
	let [wire, setWire] = useState<Wire>();
	let { onDocumentChanged, onRenameDocument } = useNavigationDocument();
	let [status, setStatus] = useState<Status>("connecting");
	let [members, setMembers] = useState<Session.Member[]>([]);
	let [effectiveCanEdit, setEffectiveCanEdit] = useState(canEdit);
	let [metadata, setMetadata] = useState({ title: label, slug, updatedAt });
	let metadataRef = useRef(metadata);
	let user = useMemo(() => cursor(handle), [handle]);
	let mode = useWorkspaceMode();
	let [workspace, dispatch] = useWorkspaceState();
	let [questions] = useState(() => new QuestionnaireStore());
	let [threads] = useState(() => new ThreadStore());
	let [jobs] = useState(() => new JobStore());
	let [reveal, setReveal] = useState<{ widget: string; token: number }>();
	let [planScrollTop, setPlanScrollTop] = useState(0);
	let entries = useQuestionnaires(questions);
	let unanswered = countUnanswered(entries);
	let jobSnapshot = useJobs(jobs);
	let jobAggregate = aggregateJobs(jobSnapshot.jobs);
	let currentJobCount = currentJobs(jobSnapshot.jobs).length;
	let hasPlanContent = useHasPlanContent(questions);
	let [decisionView, setDecisionView] = useState<DecisionViewState>(() => {
		let stored = localStorage.getItem("chopin:view:document");
		return {
			phase: "initial",
			preferred: stored === "decisions" || stored === "tasks" ? stored : "plan",
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
	let updateMetadata = useCallback((next: { title: string; slug: string; updatedAt: string }) => {
		if (Date.parse(next.updatedAt) <= Date.parse(metadataRef.current.updatedAt)) return;
		metadataRef.current = next;
		setMetadata(next);
		rememberChannel(userId, { id: room, title: next.title, slug: next.slug }, repository);
		onDocumentChanged(room, next);
		let path = documentPath(repository.owner, repository.name, next.slug);
		if (location.pathname !== path) {
			history.replaceState(null, "", `${path}${location.search}${location.hash}`);
		}
	}, [onDocumentChanged, repository, room, userId]);

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
		setDecisionView(state => ({
			...state,
			...(next === "tasks" ? { phase: "complete" as const } : {}),
			preferred: next,
		}));
		if (hasPlanContent) localStorage.setItem("chopin:view:document", next);
		if (next === "decisions" && revealFirst) {
			let first = entries.find(entry =>
				entry.value.questions.some(question => question.answer === undefined)
			);
			setReveal({ widget: first?.id ?? "", token: Date.now() });
		}
	};

	let selectDestination = (destination: "plan" | "decisions" | "tasks") => {
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
		let next = { title: label, slug, updatedAt };
		metadataRef.current = next;
		setMetadata(next);
	}, [label, room, slug, updatedAt]);

	useEffect(() => {
		let socket = new Wire({
			channelId: room,
			onAuthenticationRequired: () => location.reload(),
			onStatus: next => {
				setStatus(next);
			},
		});
		setWire(socket);

		let off = [
			socket.on<Session.Hello>("session:hello", frame => {
				setMembers(frame.members);
				setEffectiveCanEdit(frame.canEdit);
				updateMetadata(frame);
			}),
			socket.on<Session.Channel>("session:channel", frame => {
				if (frame.channelId === room) updateMetadata(frame);
			}),
			socket.on<Session.Presence>("session:presence", frame => setMembers(frame.members)),
			socket.on<Session.Access>("session:access", frame => setEffectiveCanEdit(frame.canEdit)),
			threads.listen(socket),
			jobs.listen(socket),
		];

		return () => {
			for (let unsubscribe of off) unsubscribe();
			socket.dispose();
			setWire(undefined);
		};
	}, [room, handle, threads, jobs, updateMetadata]);

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
			taskActivity={{
				active: jobAggregate.active,
				paused: jobAggregate.paused,
				failed: jobAggregate.failed,
			}}
			header={
				<Header
					canEdit={effectiveCanEdit}
					members={members}
					label={metadata.title}
					onRename={onRenameDocument}
				/>
			}
			controls={
				<DecisionViewControl
					attention={attention}
					onView={selectDestination}
					tasks={currentJobCount}
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
					headingId={HEADING.decisions}
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
					jobs={jobs}
					onScrollTop={setPlanScrollTop}
					questions={questions}
					readOnly={!effectiveCanEdit}
					scrollTop={planScrollTop}
					threads={threads}
					user={user}
					wire={wire}
				/>
			}
			tasks={
				<Tasks
					canEdit={effectiveCanEdit}
					connected={status === "connected"}
					headingId={HEADING.tasks}
					store={jobs}
				/>
			}
			state={workspace}
			unanswered={unanswered}
			view={view}
		/>
	);
}
