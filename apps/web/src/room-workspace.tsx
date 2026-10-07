import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { documentPath } from "@chopin/protocol/document-url";
import { ChevronIcon, DocumentIcon } from "@chopin/icons";
import {
	advanceDecisionView,
	CardMetaStore,
	countUnanswered,
	cursor,
	Decisions,
	documentHasPlanningContent,
	Face,
	firstOpenDecision,
	PlanEditor,
	QuestionnaireStore,
	selectDecisionView,
	ThreadStore,
	useHasPlanContent,
	useQuestionnaires,
	visibleDecisionView,
} from "@chopin/editor";

import { Chat } from "./chat/chat";
import { shouldShowResearchActionError, useResearchOfferLinks } from "./chat/research-offer";
import type { ResearchDraftController } from "./chat/research-draft-controller";
import { advanceConversationAnnouncement } from "./conversation-plan/announcements";
import type { ConversationAnnouncementSummary } from "./conversation-plan/announcements";
import { evidenceRows, hasEvidence } from "./conversation-plan/evidence";
import { EvidencePopover } from "./conversation-plan/evidence-popover";
import { threadForCard } from "./conversation-plan/links";
import type { CardLink } from "./conversation-plan/links";
import type { ExcerptCorrectionAction } from "./conversation-plan/analysis-overview";
import { ConversationPlanStore, useConversationPlan } from "./conversation-plan/store";
import { rememberChannel } from "./channel-recovery";
import { decisionAttention, DecisionViewControl } from "./decision-view-control";
import { newestDocumentMetadata } from "./document-actions";
import { DocumentActionsMenu } from "./document-actions-menu";
import { motionContract } from "./motion-contract";
import { motionImmediately } from "./motion-input";
import { useNavigationDocument } from "./navigation-shell";
import { peopleHere } from "./presence";
import { ResearchRequestStore } from "./research-requests";
import { Wire } from "./wire";
import { useWorkspaceIds, useWorkspaceLayout, useWorkspaceState, Workspace } from "./workspace";
import { initialDocumentView, presentWorkspace, workspaceProfile } from "./workspace-model";

import type { ConversationPlan, Research, Session } from "@chopin/protocol";
import type { DecisionView, DecisionViewState } from "@chopin/editor";
import type { DocumentMetadata } from "./document-actions";
import type { DocumentAction } from "./document-actions-menu";
import type { HostedWorkspaceProps } from "./hosted";
import type { Status } from "./wire";
import type { ChatDestination } from "./conversation-plan/source";
import type { SourceDestination } from "./conversation-plan/card-parts";
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
				<DocumentIcon />
				{presentation.type === "parent-with-child"
					? (
						<>
							<button
								aria-label={`Return to ${label}`}
								className="document-parent-breadcrumb btn btn-md btn-ghost min-w-0"
								onClick={presentation.onChildClose}
								type="button"
							>
								<span className="truncate">{label}</span>
							</button>
							<ChevronIcon
								aria-hidden="true"
								className="document-breadcrumb-separator shrink-0"
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
									<ChevronIcon aria-hidden="true" className="rotate-90" />
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
					<span
						className="room-member-face -ml-1.5 first:ml-0"
						data-tooltip={handle}
						data-tooltip-verbatim=""
						key={handle.toLowerCase()}
					>
						<Face handle={handle} ring="ground" size={24} titled={false} />
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
	let [sourceDestination, setSourceDestination] = useState<ChatDestination | undefined>(undefined);
	let sourceToken = useRef(0);
	let conversationStore = useMemo(() => new ConversationPlanStore(room), [room]);
	let conversation = useConversationPlan(conversationStore);
	let conversationGeneration = conversationStore.generation;
	let [announcement, setAnnouncement] = useState({ text: "", sequence: 0 });
	let priorConversation = useRef<
		{
			store: ConversationPlanStore;
			generation: number;
			summary?: ConversationAnnouncementSummary;
		} | undefined
	>(undefined);
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
	let { available, frame, mode } = useWorkspaceLayout();
	let workspaceIds = useWorkspaceIds();
	let profile = workspaceProfile(presentation);
	let researchEnabled = profile.research;
	let [workspace, dispatch] = useWorkspaceState(profile);
	let [questions] = useState(() => new QuestionnaireStore());
	let [cardMeta] = useState(() => new CardMetaStore());
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
	let researchLinks = useResearchOfferLinks(
		wire,
		status === "connected",
		conversation.state?.researchOffers ?? [],
	);
	let latestResearchLinks = useRef(researchLinks.links);
	latestResearchLinks.current = researchLinks.links;
	let pendingResearchActions = useRef(new Set<string>());
	let researchActionScope = useRef({
		room,
		wire,
		connected: status === "connected",
		generation: 0,
	});
	if (
		researchActionScope.current.room !== room
		|| researchActionScope.current.wire !== wire
		|| researchActionScope.current.connected !== (status === "connected")
	) {
		researchActionScope.current = {
			room,
			wire,
			connected: status === "connected",
			generation: researchActionScope.current.generation + 1,
		};
	}
	let [researchBusy, setResearchBusy] = useState<ReadonlySet<string>>(new Set());
	let [researchErrors, setResearchErrors] = useState<Record<string, string>>({});
	let [researchExecution, setResearchExecution] = useState(false);
	let researchDrafts = useMemo(() => new Map<string, ResearchDraftController>(), [room]);
	let [reveal, setReveal] = useState<{ widget: string; token: number }>();
	let [planScrollTop, setPlanScrollTop] = useState(0);
	let entries = useQuestionnaires(questions);
	let cardMetadata = useSyncExternalStore(cardMeta.subscribe, cardMeta.snapshot, cardMeta.snapshot);
	let unanswered = countUnanswered(entries, cardMetadata);
	let hasPlanProse = useHasPlanContent(questions);
	let hasPlanContent = documentHasPlanningContent(hasPlanProse, entries);
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
	let chatActive = workspacePresentation.chatVisible;
	let [chatActivity, setChatActivity] = useState({ unread: 0, busy: false });
	let onChatActivity = useCallback(
		(event: { type: "message" | "working"; busy: boolean }) => {
			setChatActivity(current => ({
				busy: event.busy,
				unread: event.type === "message" && !chatActive
					? current.unread + 1
					: current.unread,
			}));
		},
		[chatActive],
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
		if (!chatActive) return;
		setChatActivity(current => current.unread === 0 ? current : { ...current, unread: 0 });
	}, [chatActive]);

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
			let first = firstOpenDecision(entries, cardMetadata);
			setReveal({ widget: first?.id ?? "", token: Date.now() });
		}
	};

	let selectDestination = (destination: "plan" | "decisions") => {
		selectView(destination, mode === "split");
		dispatch({ type: "set-chat", open: false });
	};

	useEffect(() => {
		setSourceDestination(undefined);
	}, [room]);
	useEffect(() => {
		if (!sourceDestination) return;
		let token = sourceDestination.token;
		let timeout = window.setTimeout(() => {
			setSourceDestination(current => current?.token === token ? undefined : current);
		}, 3_000);
		return () => window.clearTimeout(timeout);
	}, [sourceDestination]);

	useEffect(() => {
		let previous = priorConversation.current;
		let sameScope = previous?.store === conversationStore
			&& previous.generation === conversationGeneration;
		let { summary, message } = advanceConversationAnnouncement(
			sameScope ? previous?.summary : undefined,
			conversation.state,
		);
		priorConversation.current = {
			store: conversationStore,
			generation: conversationGeneration,
			summary,
		};
		if (!sameScope || !conversation.state) {
			setAnnouncement(current => current.text ? { ...current, text: "" } : current);
		}
		if (message) {
			setAnnouncement(current => ({ text: message, sequence: current.sequence + 1 }));
		}
	}, [conversation.state, conversationStore, conversationGeneration]);

	let showDecisionCard = (questionnaireId: string) => {
		let entry = questions.snapshot().find(item => item.id === questionnaireId);
		let question = entry?.value.questions[0]?.id;
		if (entry && question) showPlan(entry.id, question);
	};

	let setDesktopChatOpen = (open: boolean) => {
		dispatch({ type: "set-desktop-chat", open });
		if (!open) dispatch({ type: "set-chat", open: false });
	};

	let showSource = useCallback((destination: SourceDestination) => {
		setSourceDestination({ ...destination, token: ++sourceToken.current });
		if (mode === "split") setDesktopChatOpen(true);
		else dispatch({ type: "set-chat", open: true });
	}, [dispatch, mode, setDesktopChatOpen]);
	let showCardSource = useCallback((questionnaireId: string) => {
		let thread = conversation.state && threadForCard(conversation.state, questionnaireId);
		let source = thread?.questionSources[0];
		if (thread && source) showSource({ source, itemId: thread.id });
	}, [conversation.state, showSource]);
	let showEvidence = useCallback((questionnaireId: string) => {
		if (!workspacePresentation.documentVisible || workspacePresentation.documentView !== "plan") {
			return null;
		}
		let state = conversation.enabled ? conversation.state : undefined;
		let thread = state && threadForCard(state, questionnaireId);
		let meta = cardMetadata.get(questionnaireId);
		if (!thread || !meta || (meta.status !== "open" && meta.status !== "reopened")) {
			return null;
		}
		let options = entries.find(entry => entry.id === questionnaireId)
			?.value.questions[0]?.options;
		let rows = evidenceRows(thread, meta, options);
		return hasEvidence(rows) ? <EvidencePopover onSource={showSource} rows={rows} /> : null;
	}, [
		cardMetadata,
		conversation.enabled,
		conversation.state,
		entries,
		showSource,
		workspacePresentation.documentView,
		workspacePresentation.documentVisible,
	]);

	let retryAnalysis = async (
		messageId: string,
		actionId: string,
		lane?: "decision" | "research",
	) => {
		if (!wire || !workspaceCanEdit) throw new Error("This document is read-only.");
		try {
			await wire.ask("conversation-plan:retry", { messageId, actionId, ...(lane ? { lane } : {}) });
		} catch {
			throw new Error("The message could not be retried. Try again when connected.");
		}
	};
	let addExcerpt = async (action: ExcerptCorrectionAction) => {
		if (!wire || !workspaceCanEdit || status !== "connected") {
			throw new Error("This document is read-only or disconnected.");
		}
		try {
			await wire.ask<ConversationPlan.Corrected>("conversation-plan:correct", {
				actionId: action.actionId,
				threadId: action.threadId,
				expectedVersion: action.expectedVersion,
				change: action.change,
			});
		} catch {
			throw new Error("The excerpt could not be added. Check that the card is still open.");
		}
	};
	let retryJob = async (jobId: string) => {
		if (!wire || !workspaceCanEdit) throw new Error("This document is read-only.");
		try {
			let result = await wire.ask<ConversationPlan.RetriedJob>(
				"conversation-plan:retry-job",
				{ jobId },
			);
			if (!result.queued) throw new Error("job is no longer retryable");
		} catch {
			throw new Error("The Planner job could not be retried. Try again when connected.");
		}
	};
	let showCard = (link: CardLink) => {
		let thread = conversation.state?.threads.find(item => item.id === link.threadId);
		let entry = thread?.questionnaireId
			? questions.snapshot().find(item => item.id === thread.questionnaireId)
			: undefined;
		let question = entry?.value.questions[0]?.id;
		if (entry && question) showPlan(entry.id, question);
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
		pendingResearchActions.current.clear();
		setResearchBusy(new Set());
		setResearchErrors({});
	}, [room, wire, status === "connected"]);
	useEffect(() => setResearchErrors({}), [conversation.state?.revision]);
	useEffect(() => {
		setResearchErrors(current => {
			let next = Object.fromEntries(
				Object.entries(current)
					.filter(([id]) => researchLinks.links[id]?.status !== "linked"),
			);
			return Object.keys(next).length === Object.keys(current).length ? current : next;
		});
	}, [researchLinks.links]);

	useEffect(() => {
		cardMeta.listen(undefined);
		let socket = new Wire({
			channelId: room,
			onAuthenticationRequired: () => location.reload(),
			onDeleted: () => {
				setDeleted(true);
				onDocumentDeleted(room);
			},
			onStatus: next => {
				if (next === "connected") {
					conversationStore.reset();
					cardMeta.listen(undefined);
				}
				setStatus(next);
			},
		});
		setWire(socket);

		let off = [
			conversationStore.listen(socket),
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
				setResearchExecution(frame.webResearch === true);
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
			cardMeta.listen(socket),
		];

		return () => {
			for (let unsubscribe of off) unsubscribe();
			cardMeta.listen(undefined);
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
		cardMeta,
		conversationStore,
		updateMetadata,
	]);

	let workspaceArchivedAt = archivedAt ?? metadata.archivedAt;
	let workspaceCanEdit = effectiveCanEdit && !workspaceArchivedAt;
	let actOnResearchOffer = (
		offerId: string,
		choice: "research" | "dismiss" | "resume",
	) => {
		if (!researchEnabled || !wire?.connected || status !== "connected" || !workspaceCanEdit) return;
		let offer = conversationStore.get().state?.researchOffers?.find(item => item.id === offerId);
		if (
			!offer || (choice === "resume" ? offer.status !== "accepted" : offer.status !== "offered")
		) {
			return;
		}
		if (
			choice === "resume"
			&& latestResearchLinks.current[offerId]?.status !== "pending"
			&& latestResearchLinks.current[offerId]?.status !== "unlinked"
		) return;
		if (pendingResearchActions.current.has(offerId)) return;
		pendingResearchActions.current.add(offerId);
		setResearchBusy(new Set(pendingResearchActions.current));
		setResearchErrors(current => {
			let next = { ...current };
			delete next[offerId];
			return next;
		});
		let payload = choice === "resume"
			? { offerId, choice }
			: { offerId, choice, actionId: crypto.randomUUID() };
		let generation = researchActionScope.current.generation;
		let currentScope = () => researchActionScope.current.generation === generation;
		void wire.ask<ConversationPlan.ResearchConsentResult>(
			"conversation-plan:research",
			payload,
		).then(result => {
			if (!currentScope()) return;
			if (result.offerId !== offerId) throw new Error("research action did not match the offer");
			if (result.status === "accepted") researchLinks.refresh(offerId, true);
		}).catch(() => {
			if (!currentScope()) return;
			let currentOffer = conversationStore.get().state?.researchOffers
				?.find(item => item.id === offerId);
			if (
				!shouldShowResearchActionError(
					choice,
					currentOffer?.status,
					latestResearchLinks.current[offerId]?.status,
				)
			) return;
			setResearchErrors(current => ({
				...current,
				[offerId]: "Research status could not be confirmed. Try again when connected.",
			}));
		}).finally(() => {
			if (!currentScope()) return;
			pendingResearchActions.current.delete(offerId);
			setResearchBusy(new Set(pendingResearchActions.current));
		});
	};
	if (deleted) {
		return (
			<div className="flex h-full items-center justify-center bg-ground p-4 text-sm text-text-secondary">
				<p role="status">This document was deleted.</p>
			</div>
		);
	}

	return (
		<>
			<p aria-live="polite" className="sr-only" role="status">
				<span key={announcement.sequence}>{announcement.text}</span>
			</p>
			<Workspace
				available={available}
				frame={frame}
				chat={
					<Chat
						active={chatActive}
						agent={agent}
						connected={status === "connected"}
						readonly={!workspaceCanEdit}
						archived={!!workspaceArchivedAt}
						handle={handle}
						onActivity={onChatActivity}
						onShowDecisions={() => selectDestination("decisions")}
						people={peopleHere(members)}
						conversationPlan={conversation.state}
						conversationPlanJobs={conversation.jobs}
						onCardLink={showCard}
						onAddExcerpt={addExcerpt}
						onRetryAnalysis={retryAnalysis}
						onRetryJob={retryJob}
						sourceDestination={sourceDestination}
						researchOffers={researchEnabled && conversation.enabled
							? {
								links: researchLinks.links,
								busy: researchBusy,
								errors: researchErrors,
								canAct: status === "connected" && !!wire?.connected && !!workspaceCanEdit,
								canCheckLink: status === "connected" && !!wire?.connected,
								canExecute: researchExecution,
								wire,
								controllers: researchDrafts,
								onSource: source =>
									showSource({ source: { ...source, role: "support" }, itemId: source.messageId }),
								store: research,
								onAction: actOnResearchOffer,
								onRetryLink: offerId => researchLinks.refresh(offerId, true),
							}
							: undefined}
						decisions={{
							questions,
							meta: cardMeta,
							wire,
							connected: status === "connected",
							canEdit: workspaceCanEdit,
							onOpenCard: showDecisionCard,
						}}
						referencesEnabled={chatReferences.wire === wire && chatReferences.enabled}
						repository={repository}
						room={room}
						sendAcknowledgements={chatSendAcks.wire === wire && chatSendAcks.enabled}
						wire={wire}
					/>
				}
				chatActivity={chatActivity}
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
				onDesktopChatOpen={setDesktopChatOpen}
				onChatOpen={open => dispatch({ type: "set-chat", open })}
				onDestination={selectDestination}
				decisions={
					<Decisions
						cardMeta={cardMeta}
						canEdit={workspaceCanEdit}
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
						cardMeta={cardMeta}
						evidence={showEvidence}
						onCardSource={showCardSource}
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
		</>
	);
}
