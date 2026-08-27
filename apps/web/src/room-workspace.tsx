import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { documentPath } from "@chopin/protocol/document-url";
import {
	advanceDecisionView,
	countUnanswered,
	cursor,
	Decisions,
	Face,
	PlanEditor,
	QuestionnaireStore,
	selectDecisionView,
	ThreadStore,
	useHasPlanContent,
	useQuestionnaires,
	visibleDecisionView,
} from "@chopin/editor";

import bookBookmarkIcon from "./assets/figma/navigation/book-bookmark.svg";
import navigationChevronRight from "./assets/icons/navigation-chevron-right.svg";
import chevronDownIcon from "./assets/icons/tool-chevron-down.svg";
import { Chat } from "./chat/chat";
import { rememberChannel } from "./channel-recovery";
import { decisionAttention, DecisionViewControl } from "./decision-view-control";
import { newestDocumentMetadata } from "./document-actions";
import { DocumentActionsMenu } from "./document-actions-menu";
import { motionContract } from "./motion-contract";
import { motionImmediately } from "./motion-input";
import { useNavigationDocument } from "./navigation-shell";
import { NavigationIcon } from "./project-sidebar";
import { peopleHere } from "./presence";
import { ResearchRequestStore } from "./research-requests";
import { Wire } from "./wire";
import { useWorkspaceIds, useWorkspaceMode, useWorkspaceState, Workspace } from "./workspace";
import { initialDocumentView, presentWorkspace, workspaceProfile } from "./workspace-model";

import type { Research, Session } from "@chopin/protocol";
import type { DecisionView, DecisionViewState } from "@chopin/editor";
import type { DocumentMetadata } from "./document-actions";
import type { DocumentAction } from "./document-actions-menu";
import type { HostedWorkspaceProps } from "./hosted";
import type { Status } from "./wire";
import type { WorkspacePresentation } from "./workspace-model";

type ManagedHello = Session.Hello & { archivedAt?: string; canManage: boolean };
type ManagedChannel = Session.Channel & { archivedAt?: string; canManage: boolean };
type ManagedAccess = Session.Access & { canManage: boolean };
type WorkspaceMetadata = DocumentMetadata;

function settleMotionImmediately(): boolean {
	return motionImmediately();
}

const QUESTION_MOTION = {
	contract: motionContract("content-swap"),
	immediately: settleMotionImmediately,
};

export function Header(
	{
		archivedAt,
		canManage,
		members,
		label,
		onAction,
		presentation,
	}: {
		archivedAt?: string;
		canManage: boolean;
		members: Session.Member[];
		label: string;
		onAction: (action: DocumentAction) => void;
		presentation: WorkspacePresentation;
	},
) {
	let people = peopleHere(members);
	return (
		<header className="room-header relative flex shrink-0 flex-nowrap items-center px-2 py-2 sm:px-5 sm:py-0">
			<div
				aria-label={`Document: ${label}`}
				className="flex min-w-0 flex-1 items-center gap-0.5"
			>
				<NavigationIcon className="opacity-50" src={bookBookmarkIcon} />
				{presentation.type === "parent-with-child"
					? (
						<>
							<button
								aria-label={`Return to ${label}`}
								className="document-parent-breadcrumb btn btn-ghost min-w-0"
								onClick={presentation.onChildClose}
								type="button"
							>
								<span className="truncate">{label}</span>
							</button>
							<img
								alt=""
								aria-hidden="true"
								className="document-breadcrumb-separator size-[14px] shrink-0"
								src={navigationChevronRight}
							/>
							<span
								aria-label={`Child document: ${presentation.childLabel}`}
								className="document-child-breadcrumb truncate"
							>
								{presentation.childLabel}
							</span>
						</>
					)
					: canManage
					? (
						<DocumentActionsMenu
							channel={{ archivedAt, title: label }}
							className="document-title-trigger"
							onAction={onAction}
							trigger={
								<>
									<span className="truncate">{label}</span>
									<img
										alt=""
										aria-hidden="true"
										className="size-3.5 opacity-50"
										src={chevronDownIcon}
									/>
								</>
							}
						/>
					)
					: <span className="document-title-label truncate">{label}</span>}
				{archivedAt && (
					<span className="document-status-badge document-read-only-status">
						Archived, read-only
					</span>
				)}
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
		archivedAt,
		canEdit = true,
		canManage,
		description,
		descriptionRevision,
		handle,
		label,
		onMetadataChanged,
		presentation,
		repository,
		room,
		slug,
		updatedAt,
		userId,
	}: HostedWorkspaceProps,
) {
	let [wire, setWire] = useState<Wire>();
	let {
		onDocumentAction,
		onDocumentChanged,
		onDocumentDeleted,
		onRepositoryAccessChanged,
		onResearchChildOpen,
		onResearchChildPublished,
	} = useNavigationDocument();
	let [status, setStatus] = useState<Status>("connecting");
	let [members, setMembers] = useState<Session.Member[]>([]);
	let [effectiveCanEdit, setEffectiveCanEdit] = useState(canEdit && !archivedAt);
	let [effectiveCanManage, setEffectiveCanManage] = useState(canManage);
	let [deleted, setDeleted] = useState(false);
	let [chatReferences, setChatReferences] = useState<{ wire?: Wire; enabled: boolean }>({
		enabled: false,
	});
	let [chatSendAcks, setChatSendAcks] = useState<{ wire?: Wire; enabled: boolean }>({
		enabled: false,
	});
	let [metadata, setMetadata] = useState<WorkspaceMetadata>({
		archivedAt,
		description,
		descriptionRevision,
		title: label,
		slug,
		updatedAt,
	});
	let metadataRef = useRef(metadata);
	let repositoryRef = useRef(repository);
	repositoryRef.current = repository;
	let user = useMemo(() => cursor(handle), [handle]);
	let mode = useWorkspaceMode();
	let workspaceIds = useWorkspaceIds();
	let profile = workspaceProfile(presentation);
	let researchEnabled = profile.research;
	let [workspace, dispatch] = useWorkspaceState(profile);
	let [questions] = useState(() => new QuestionnaireStore());
	let [threads] = useState(() => new ThreadStore());
	let research = useMemo(
		() =>
			new ResearchRequestStore({
				channelId: room,
				onOpen: (child, opener) => onResearchChildOpen(room, child, opener),
				onPublished: child => onResearchChildPublished(room, child),
			}),
		[onResearchChildOpen, onResearchChildPublished, room],
	);
	let [reveal, setReveal] = useState<{ widget: string; token: number }>();
	let [planScrollTop, setPlanScrollTop] = useState(0);
	let entries = useQuestionnaires(questions);
	let unanswered = countUnanswered(entries);
	let hasPlanContent = useHasPlanContent(questions);
	let [decisionView, setDecisionView] = useState<DecisionViewState>(() => {
		let stored = localStorage.getItem("chopin:view:document");
		return {
			phase: "initial",
			preferred: initialDocumentView(profile, stored),
		};
	});
	let view = visibleDecisionView(decisionView, hasPlanContent, unanswered);
	let previousUnanswered = useRef(unanswered);
	let latestCanEdit = useRef(canEdit);
	let latestCanManage = useRef(canManage);
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
	let updateMetadata = useCallback((next: WorkspaceMetadata) => {
		let previous = metadataRef.current;
		let metadata = newestDocumentMetadata(previous, next);
		metadataRef.current = metadata;
		setMetadata(metadata);
		let currentRepository = repositoryRef.current;
		rememberChannel(
			userId,
			{ id: room, title: metadata.title, slug: metadata.slug },
			currentRepository,
		);
		onDocumentChanged(room, metadata);
		if (onMetadataChanged) {
			onMetadataChanged(metadata);
			return;
		}
		let previousPath = documentPath(
			currentRepository.owner,
			currentRepository.name,
			previous.slug,
		);
		let channelPath = `/channels/${encodeURIComponent(room)}`;
		if (location.pathname !== previousPath && location.pathname !== channelPath) return;
		let path = documentPath(currentRepository.owner, currentRepository.name, metadata.slug);
		if (location.pathname !== path) {
			history.replaceState(history.state, "", `${path}${location.search}${location.hash}`);
		}
	}, [onDocumentChanged, onMetadataChanged, room, userId]);

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
		setDecisionView(state => selectDecisionView(state, next));
		if (hasPlanContent && profile.persistView) {
			localStorage.setItem("chopin:view:document", next);
		}
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
				`[data-workspace-room="${
					CSS.escape(room)
				}"] [data-document-view="plan"] article[data-plan-sidecar-questionnaire="${
					CSS.escape(widget)
				}"]`,
			);
			if (!card) return;
			card.tabIndex = -1;
			card.focus();
		});
	};

	useEffect(() => {
		let editable = canEdit && !archivedAt;
		latestCanEdit.current = editable;
		latestCanManage.current = canManage;
		setEffectiveCanEdit(editable);
		setEffectiveCanManage(canManage);
	}, [archivedAt, canEdit, canManage, room]);

	useEffect(() => {
		let next: WorkspaceMetadata = {
			archivedAt,
			description,
			descriptionRevision,
			title: label,
			slug,
			updatedAt,
		};
		next = newestDocumentMetadata(metadataRef.current, next);
		metadataRef.current = next;
		setMetadata(next);
	}, [archivedAt, description, descriptionRevision, label, room, slug, updatedAt]);

	useEffect(() => () => research.reset(), [research]);

	useEffect(() => {
		let socket = new Wire({
			channelId: room,
			onAuthenticationRequired: () => location.reload(),
			onDeleted: () => {
				setDeleted(true);
				onDocumentDeleted(room);
			},
			onStatus: next => {
				setStatus(next);
			},
		});
		setWire(socket);

		let off = [
			socket.on<ManagedHello>("session:hello", frame => {
				let editable = frame.canEdit && !frame.archivedAt;
				let accessChanged = latestCanEdit.current !== editable
					|| latestCanManage.current !== frame.canManage;
				latestCanEdit.current = editable;
				latestCanManage.current = frame.canManage;
				setMembers(frame.members);
				setEffectiveCanEdit(editable);
				setEffectiveCanManage(frame.canManage);
				setChatReferences({ wire: socket, enabled: frame.chatReferences === true });
				setChatSendAcks({ wire: socket, enabled: frame.chatSendAcks === true });
				updateMetadata(frame);
				if (accessChanged) onRepositoryAccessChanged();
			}),
			socket.on<ManagedChannel>("session:channel", frame => {
				if (frame.channelId !== room) return;
				let editable = !frame.archivedAt && frame.canManage;
				let accessChanged = latestCanEdit.current !== editable
					|| latestCanManage.current !== frame.canManage;
				latestCanEdit.current = editable;
				latestCanManage.current = frame.canManage;
				setEffectiveCanEdit(editable);
				setEffectiveCanManage(frame.canManage);
				updateMetadata(frame);
				if (accessChanged) onRepositoryAccessChanged();
			}),
			socket.on<Session.Presence>("session:presence", frame => setMembers(frame.members)),
			socket.on<ManagedAccess>("session:access", frame => {
				latestCanEdit.current = frame.canEdit;
				latestCanManage.current = frame.canManage;
				setEffectiveCanEdit(frame.canEdit);
				setEffectiveCanManage(frame.canManage);
				onRepositoryAccessChanged();
			}),
			socket.on<Research.Changed>("research:changed", frame => {
				if (researchEnabled) research.invalidate(frame.workspaceId);
			}),
			threads.listen(socket),
		];

		return () => {
			for (let unsubscribe of off) unsubscribe();
			socket.dispose();
			setWire(undefined);
		};
	}, [
		handle,
		onDocumentDeleted,
		onRepositoryAccessChanged,
		research,
		researchEnabled,
		room,
		profile.surface,
		threads,
		updateMetadata,
	]);

	let workspaceArchivedAt = archivedAt ?? metadata.archivedAt;
	let workspaceCanEdit = effectiveCanEdit && !workspaceArchivedAt;
	if (deleted) {
		return (
			<div className="flex h-full items-center justify-center bg-ground p-4 text-sm text-text-secondary">
				<p role="status">This document was deleted.</p>
			</div>
		);
	}

	return (
		<Workspace
			chat={
				<Chat
					active={conversationActive}
					agent={agent}
					connected={status === "connected" && workspaceCanEdit}
					handle={handle}
					onActivity={onConversationActivity}
					referencesEnabled={chatReferences.wire === wire && chatReferences.enabled}
					repository={repository}
					room={room}
					sendAcknowledgements={chatSendAcks.wire === wire && chatSendAcks.enabled}
					wire={wire}
				/>
			}
			conversationActivity={conversationActivity}
			header={
				<Header
					archivedAt={workspaceArchivedAt}
					canManage={effectiveCanManage}
					members={members}
					label={metadata.title}
					onAction={action => onDocumentAction(room, action)}
					presentation={presentation}
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
			ids={workspaceIds}
			identity={room}
			mode={mode}
			onDesktopConversationOpen={setDesktopConversationOpen}
			onConversationOpen={open => dispatch({ type: "set-conversation", open })}
			onDestination={selectDestination}
			decisions={
				<Decisions
					connected={status === "connected" && workspaceCanEdit}
					headingId={workspaceIds.heading.decisions}
					motion={motionContract("collapse")}
					motionImmediately={settleMotionImmediately}
					onShowPlan={showPlan}
					questionMotion={QUESTION_MOTION}
					reveal={reveal}
					store={questions}
					wire={wire}
				/>
			}
			plan={
				<PlanEditor
					commentPresentation={mode === "split" ? "popover" : "sheet"}
					connection={status === "deleted" ? "closed" : status}
					key={workspaceArchivedAt ? "archived" : "active"}
					motionImmediately={settleMotionImmediately}
					onScrollTop={setPlanScrollTop}
					questionMotion={QUESTION_MOTION}
					questions={questions}
					readOnly={!workspaceCanEdit}
					research={profile.research ? research : undefined}
					scrollTop={planScrollTop}
					threads={threads}
					user={user}
					wire={wire}
				/>
			}
			state={workspace}
			presentation={presentation}
			unanswered={unanswered}
			view={view}
		/>
	);
}
