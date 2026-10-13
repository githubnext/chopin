import {
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { documentPath } from "@chopin/protocol/document-url";
import {
	ArchiveIcon,
	CheckIcon,
	ChevronIcon,
	CloseIcon,
	DocumentIcon,
	MagnifierIcon,
	PencilIcon,
} from "@chopin/icons";
import { Badge } from "@chopin/visuals";
import {
	advanceDecisionView,
	CardMetaStore,
	countUnanswered,
	cursor,
	Decisions,
	DecisionSaveHost,
	documentEditMode,
	documentHasPlanningContent,
	Face,
	firstOpenDecision,
	GitHubReferencesProvider,
	openCommentList,
	opensEditing,
	PlanEditor,
	PlanStatus,
	QuestionnaireStore,
	ResearchLauncher,
	revealDeckItem,
	selectDecisionView,
	ThreadStore,
	useConnectionNotice,
	useHasPlanContent,
	useQuestionnaires,
	visibleDecisionView,
} from "@chopin/editor";

import { BuildGlyph, BuildPlanButton, useBuildPlan } from "./build-plan-button";
import { useLiveBuild } from "./live-build";
import { BuildView } from "./build-view";
import { Chat } from "./chat/chat";
import { ChildPhoneChromeContext, sameEditState } from "./child-phone-chrome";
import { ChildProvenance } from "./child-provenance";
import { ChildTitleContext } from "./child-title";
import { shouldShowResearchActionError, useResearchOfferLinks } from "./chat/research-offer";
import type { ResearchDraftController } from "./chat/research-draft-controller";
import { useDocumentEditing } from "./document-editing";
import { advanceConversationAnnouncement } from "./conversation-plan/announcements";
import type { ConversationAnnouncementSummary } from "./conversation-plan/announcements";
import { evidenceRows, hasEvidence } from "./conversation-plan/evidence";
import { EvidencePopover } from "./conversation-plan/evidence-popover";
import { threadForCard } from "./conversation-plan/links";
import type { CardLink } from "./conversation-plan/links";
import type { ExcerptCorrectionAction } from "./conversation-plan/analysis-overview";
import { ConversationPlanStore, useConversationPlan } from "./conversation-plan/store";
import { rememberChannel } from "./channel-recovery";
import {
	BUILD_UNAVAILABLE,
	DecisionViewControl,
	useDecisionAttention,
} from "./decision-view-control";
import {
	advanceDocumentActivity,
	ANSWER_FOLLOW_MS,
	documentActivity,
	QUIET_DOCUMENT,
} from "./document-activity";
import { newestDocumentMetadata } from "./document-actions";
import { DocumentActionsMenu } from "./document-actions-menu";
import { DocumentRename } from "./document-rename";
import { browserStorage, rememberOpened } from "./documents-sheet-model";
import { PhoneHeader, PhoneHeaderContent } from "./phone-header";
import { DocumentSkeleton } from "./phone-skeleton";
import { useEditorFocus, useKeyboardOpen } from "./keyboard-open";
import { motionContract } from "./motion-contract";
import { motionImmediately } from "./motion-input";
import { useNavigationDocument } from "./navigation-shell";
import { titleEdits } from "./title-edit";
import { peopleHere } from "./presence";
import { ResearchRequestStore } from "./research-requests";
import { GitHubReferenceCache } from "./github-references";
import { Wire } from "./wire";
import { ExperimentStore } from "./experiments/store";
import { InvestigationReference, removableInvestigation } from "./experiments/card";
import { EvidenceDecisions, ViewDecision } from "./experiments/evidence";
import { useWorkspaceIds, useWorkspaceLayout, useWorkspaceState, Workspace } from "./workspace";
import { initialDocumentView, presentWorkspace, workspaceProfile } from "./workspace-model";

import type { ConversationPlan, Plan, Question, Research, Session } from "@chopin/protocol";
import type {
	DecisionView,
	DecisionViewState,
	ExperimentResources,
	InvestigationResources,
	PlanState,
	Refusal,
	ResearchLaunchResult,
} from "@chopin/editor";
import type { DocumentMetadata } from "./document-actions";
import type { DocumentAction } from "./document-actions-menu";
import type { TitleEdit } from "./title-edit";
import type { HostedWorkspaceProps } from "./hosted";
import type { ReactNode } from "react";
import type { Status } from "./wire";
import type { ChatDestination } from "./conversation-plan/source";
import type { SourceDestination } from "./conversation-plan/card-parts";
import type { WorkspaceDocumentView } from "./workspace-model";

type ManagedHello = Session.Hello & { archivedAt?: string; canManage: boolean };
type ManagedChannel = Session.Channel & { archivedAt?: string; canManage: boolean };
type ManagedAccess = Session.Access & { canManage: boolean };
type WorkspaceMetadata = DocumentMetadata;

// Lives here rather than in `title-edit.ts` to keep it out of the initial bundle.
function claimTitleEdit(id: string): TitleEdit | undefined {
	let edit = titleEdits.get(id);
	// StrictMode renders twice in one task, and both renders must see the claim.
	if (edit) queueMicrotask(() => titleEdits.delete(id));
	return edit;
}

function settleMotionImmediately(): boolean {
	return motionImmediately();
}

const QUESTION_MOTION = {
	contract: motionContract("content-swap"),
	immediately: settleMotionImmediately,
};

export function RoomMembers(
	{ members, ring }: { members: Session.Member[]; ring: "ground" | "page" },
) {
	let people = peopleHere(members);
	return (
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
					<Face handle={handle} ring={ring} size={24} textSize="2xs" titled={false} />
				</span>
			))}
			{people.length > 3 && (
				<span
					aria-hidden="true"
					className="room-member-overflow ml-1 hidden text-xs text-text-tertiary"
				>
					+{people.length - 3}
				</span>
			)}
			{/* A narrow title bar keeps one face and counts the rest. */}
			{people.length > 1 && (
				<span
					aria-hidden="true"
					className="room-member-overflow-narrow ml-1 hidden text-xs text-text-tertiary"
				>
					+{people.length - 1}
				</span>
			)}
		</div>
	);
}

type TitleProps = {
	archivedAt?: string;
	canManage: boolean;
	editing?: TitleEdit;
	label: string;
	onAction: (action: DocumentAction) => void;
	onEditingChange: (editing?: TitleEdit) => void;
	onRenamed: (channel: DocumentMetadata) => void;
	project?: { id: string; name: string };
	room: string;
};

/** An open Zoom child: this title becomes a crumb back, and the child's title follows it. */
type TitlePath = {
	child: string;
	onReturn: () => void;
	/** Set while the root shows another view: the child crumb then brings Document back. */
	onShowChild?: () => void;
	slot: (element: HTMLElement | null) => void;
};

/**
 * Titles renamed from their own field. A child's card is keyed by its slug, so a rename remounts
 * it; the new title takes the caret back on mount.
 */
let renamedFromField = new Map<string, number>();

/** The document's project, title, rename and actions menu, wherever its chrome puts them. */
export function DocumentTitle(
	{
		archivedAt,
		canManage,
		editing,
		icon,
		label,
		onAction,
		onEditingChange,
		onRenamed,
		path,
		project,
		room,
	}: TitleProps & { icon?: boolean; path?: TitlePath },
) {
	let group = useRef<HTMLDivElement>(null);
	let title = useRef<HTMLButtonElement>(null);
	let previousEdit = useRef(editing);
	useEffect(() => {
		let previous = previousEdit.current;
		previousEdit.current = editing;
		// Hand the caret back only when the field took it with it, not after a blur commit.
		if (!editing && previous && document.activeElement === document.body) title.current?.focus();
	}, [editing]);
	useEffect(() => {
		let renamed = renamedFromField.get(room);
		renamedFromField.delete(room);
		if (renamed === undefined || performance.now() - renamed > 2000) return;
		let active = document.activeElement;
		if (!active || active === document.body) title.current?.focus();
	}, [room]);
	// Also runs as a save starts, not after it: keys typed while the rename travels would
	// otherwise land in a field that is about to close.
	let handOff = () => {
		// Naming a new document leads into writing it, unless the user already clicked elsewhere.
		if (editing === "new" && group.current?.contains(document.activeElement)) {
			group.current.closest(".workspace-root")
				?.querySelector<HTMLElement>(".plan-content[contenteditable='true']")
				?.focus();
		}
	};
	let finishEdit = () => {
		handOff();
		onEditingChange();
	};
	let identity = (
		<div
			aria-label={`Document: ${label}`}
			className={`document-title flex min-w-0 items-center gap-0.5 ${
				path ? "flex-initial" : "flex-1"
			}`}
			ref={group}
			role="group"
		>
			{icon && <DocumentIcon className="shrink-0" />}
			{project && (
				<>
					<span className="document-project-prefix truncate text-xs font-medium">
						{project.name}
					</span>
					<span aria-hidden="true" className="document-project-separator text-xs">/</span>
				</>
			)}
			{path && (
				<button
					aria-label={`Back to ${label}`}
					className="document-title-crumb btn btn-compact btn-ghost min-w-0"
					onClick={path.onReturn}
					type="button"
				>
					<span className="truncate">{label}</span>
				</button>
			)}
			<div className="title-control min-w-0 text-xs font-medium" hidden={!!path}>
				{editing && canManage && !archivedAt
					? (
						<DocumentRename
							channel={{ id: room, title: label }}
							inline
							onCancel={finishEdit}
							// The body took focus as the save started; a refusal needs the field back.
							onErrorChange={error =>
								error !== undefined
								&& group.current?.querySelector<HTMLInputElement>(".document-title-input")
									?.focus()}
							onSavingChange={saving => {
								if (!saving) return;
								if (editing !== "new" && group.current?.contains(document.activeElement)) {
									renamedFromField.set(room, performance.now());
								}
								handOff();
							}}
							replay={editing === "new"}
							onRenamed={detail => {
								onRenamed(detail.channel);
								finishEdit();
							}}
						/>
					)
					: canManage && !archivedAt
					? (
						<button
							aria-label={`Rename ${label}`}
							className="title-control-label document-title-trigger"
							onClick={() => onEditingChange("rename")}
							onKeyDown={event => {
								if (event.key !== "F2") return;
								event.preventDefault();
								onEditingChange("rename");
							}}
							ref={title}
							type="button"
						>
							<span className="truncate">{label}</span>
						</button>
					)
					: <span className="title-control-label truncate">{label}</span>}
				{canManage && (
					<DocumentActionsMenu
						align="start"
						channel={{ archivedAt, title: label }}
						className="title-control-action"
						onAction={action => action === "rename" ? onEditingChange("rename") : onAction(action)}
						trigger={
							<ChevronIcon
								aria-hidden="true"
								className="rotate-90"
								size={12}
							/>
						}
					/>
				)}
			</div>
			{archivedAt && (
				<span className="document-archived-status">
					<Badge icon={ArchiveIcon} label="Archived" size="sm" textSize="2xs" tone="warning" />
					{canManage && (
						<button
							className="btn btn-compact btn-outline"
							onClick={() => onAction("restore")}
							type="button"
						>
							Restore
						</button>
					)}
				</span>
			)}
		</div>
	);
	if (!path) return identity;
	// The child's title is its own Document group, beside the root's rather than inside it.
	return (
		<>
			{identity}
			<ChevronIcon aria-hidden="true" className="document-title-crumb-chevron" size={12} />
			{path.onShowChild && (
				<button
					aria-current="page"
					className="document-title-crumb document-title-child-crumb btn btn-compact btn-ghost min-w-0"
					onClick={path.onShowChild}
					type="button"
				>
					<span className="truncate">{path.child}</span>
				</button>
			)}
			<div className="document-child-title-slot" hidden={!!path.onShowChild} ref={path.slot} />
		</>
	);
}

/** The ground-level header of the compact workspace, which has no sheet to carry the title. */
export function Header(
	props: TitleProps & {
		members?: Session.Member[];
		/** Build plan or the build capsule, left of the people here. */
		build?: ReactNode;
	},
) {
	let members = props.members;
	return (
		<header className="room-header relative flex shrink-0 flex-nowrap items-center px-2 py-2 sm:px-5 sm:py-0">
			<DocumentTitle
				archivedAt={props.archivedAt}
				canManage={props.canManage}
				editing={props.editing}
				icon
				label={props.label}
				onAction={props.onAction}
				onEditingChange={props.onEditingChange}
				onRenamed={props.onRenamed}
				project={props.project}
				room={props.room}
			/>
			{(props.build || members) && (
				<div className="ml-auto flex shrink-0 items-center gap-3 pl-2">
					{props.build}
					{members && <RoomMembers members={members} ring="ground" />}
				</div>
			)}
		</header>
	);
}

const LOST_EDITS =
	"Your last edits couldn't be saved because the document changed while you were offline.";

const UNDO_REFUSALS: Record<Refusal, string> = {
	others: "Others have edited this since.",
	change: "This change can't be reversed here.",
};

/** Reconnect attempts a person can make in one outage before Reload is offered. */
const RECONNECTS_BEFORE_RELOAD = 3;

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
	// Phones list a project's recently opened documents in the documents sheet.
	useEffect(() => {
		if (!archivedAt) rememberOpened(browserStorage(), userId, repository.id, room);
	}, [archivedAt, repository.id, room, userId]);
	let [status, setStatus] = useState<Status>("connecting");
	let [planState, setPlanState] = useState<PlanState>({ synced: false });
	// Claimed while rendering, so a new document's title takes focus as soon as it mounts.
	let [titleEdit, setTitleEdit] = useState(() => claimTitleEdit(room));
	// A phone reads until its writer asks to edit. Local to this client and this document: it
	// survives tab changes and reconnects, and the next document opens reading again.
	let [editing, setEditing] = useState(() => opensEditing({ renaming: titleEdit === "new" }));
	let [formatDock, setFormatDock] = useState<HTMLElement | null>(null);
	// The dock's Insert or Text style panel stands where the keyboard was.
	let [formatPanel, setFormatPanel] = useState(false);
	let keyboardOpen = useKeyboardOpen();
	useEffect(() => {
		let listen = (event: Event) => {
			if ((event as CustomEvent<string>).detail !== room) return;
			let edit = claimTitleEdit(room);
			if (edit) setTitleEdit(edit);
		};
		addEventListener("title-edit", listen);
		return () => removeEventListener("title-edit", listen);
	}, [room]);
	// Controls dim only once a loss outlasts a blip; actions still read `status`.
	let treatAsConnected = useConnectionNotice(status !== "connected") === "none";
	// Reconnecting in place keeps unsent work, so it is offered first. A reload
	// is the fallback once it has failed this often in one outage.
	let [reconnects, setReconnects] = useState(0);
	// The last loss of unsent edits this person has dismissed.
	let [lostSeen, setLostSeen] = useState(0);
	if (status === "connected" && reconnects) setReconnects(0);
	let [members, setMembers] = useState<Session.Member[]>([]);
	let [effectiveCanEdit, setEffectiveCanEdit] = useState(canEdit && !archivedAt);
	let [effectiveCanManage, setEffectiveCanManage] = useState(canManage);
	let [deleted, setDeleted] = useState(false);
	let [chatReferences, setChatReferences] = useState<{ wire?: Wire; enabled: boolean }>({
		enabled: false,
	});
	// Reported only under the remote Planner harness; scoped to the socket that reported it.
	let [plannerAttachment, setPlannerAttachment] = useState<{
		wire?: Wire;
		planner?: Session.PlannerAttachment;
	}>({});
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
	let { available, frame, mode, phone } = useWorkspaceLayout();
	let workspaceIds = useWorkspaceIds();
	let profile = workspaceProfile(presentation);
	let [implementation, setImplementation] = useState<Plan.ImplementationStatus>({
		revision: -1,
		locked: false,
		hasGraph: false,
	});
	let [showImplementation, setShowImplementation] = useState(false);
	/** Which end of the capsule-to-Build-tab link is hovered, so the other lights up. */
	let [buildHover, setBuildHover] = useState<"capsule" | "tab">();
	let liveBuild = useLiveBuild();
	useEffect(() => {
		setImplementation({ revision: -1, locked: false, hasGraph: false });
		let update = (value: Plan.ImplementationStatus) => {
			setImplementation(current => value.revision >= current.revision ? value : current);
		};
		let offOpen = wire?.on<Plan.Open.Reply>("plan:open", message => {
			if (message.implementation) update(message.implementation);
		});
		let offChanged = wire?.on<Plan.ImplementationChanged>("plan:implementation", update);
		return () => {
			offOpen?.();
			offChanged?.();
		};
	}, [room, wire]);
	let researchEnabled = profile.research;
	let [workspace, dispatch] = useWorkspaceState(profile);
	// A `#task-` link waits for Build to be available, then opens it once.
	let [taskLink, setTaskLink] = useState(false);
	useEffect(() => {
		let followTask = () => {
			if (profile.implementation && location.hash.startsWith("#task-")) setTaskLink(true);
		};
		followTask();
		addEventListener("hashchange", followTask);
		return () => removeEventListener("hashchange", followTask);
	}, [profile.implementation]);
	let [questions] = useState(() => new QuestionnaireStore());
	let experiments = useMemo(
		() => new ExperimentStore(room, child => onResearchChildPublished(room, child)),
		[onResearchChildPublished, room],
	);
	useSyncExternalStore(experiments.subscribe, experiments.snapshot);
	useEffect(() => experiments.connect(wire), [experiments, wire]);
	let [cardMeta] = useState(() => new CardMetaStore());
	let [threads] = useState(() => new ThreadStore(room));
	let threadState = useSyncExternalStore(threads.subscribe, threads.snapshot, threads.snapshot);
	let [researchLauncher] = useState(() => new ResearchLauncher());
	let research = useMemo(
		() =>
			new ResearchRequestStore({
				channelId: room,
				onOpen: (child, opener) => onResearchChildOpen(room, child, opener),
				onPublished: child => onResearchChildPublished(room, child),
			}),
		[onResearchChildOpen, onResearchChildPublished, room],
	);
	let githubReferences = useMemo(() => new GitHubReferenceCache({ channelId: room }), [room]);
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
	let [reveal, setReveal] = useState<{ widget: string; token: number; resume?: boolean }>();
	let [planScrollTop, setPlanScrollTop] = useState(0);
	let entries = useQuestionnaires(questions);
	let cardMetadata = useSyncExternalStore(cardMeta.subscribe, cardMeta.snapshot, cardMeta.snapshot);
	let unanswered = countUnanswered(entries, cardMetadata);
	let hasPlanProse = useHasPlanContent(questions);
	let hasPlanContent = documentHasPlanningContent(hasPlanProse);
	let [decisionView, setDecisionView] = useState<DecisionViewState>(() => {
		let stored = localStorage.getItem("chopin:view:document");
		return {
			phase: "initial",
			preferred: initialDocumentView(profile, stored),
		};
	});
	let typing = useDocumentEditing(room);
	let build = useBuildPlan({
		canEdit: effectiveCanEdit && !(archivedAt ?? metadata.archivedAt) && status === "connected",
		connected: status === "connected",
		enabled: profile.implementation,
		hasContent: hasPlanContent,
		live: liveBuild,
		planner: agent,
		plannerDetached: plannerAttachment.wire === wire && !!plannerAttachment.planner
			&& plannerAttachment.planner.state !== "attached",
		room,
		unanswered,
		userId,
		wire,
	});
	// Touch has no tooltips, so a phone tap on Build, or on the build slot, says why it can't open.
	let buildUnavailable = build.look.kind === "plan" && build.look.blocked
		? build.look.blocked
		: BUILD_UNAVAILABLE;
	let [buildHint, setBuildHint] = useState<{ text: string; at: number }>();
	useEffect(() => {
		if (!buildHint) return;
		let timer = window.setTimeout(() => setBuildHint(undefined), 4000);
		return () => window.clearTimeout(timer);
	}, [buildHint]);
	let explainBuild = (text = buildUnavailable) => setBuildHint({ text, at: Date.now() });
	// Build opens once there is a build; a reload may restore it before the first read.
	// A child someone opened is what they came to read, so a blank root's routing to Decisions
	// waits until it closes; an explicit choice of view still applies.
	let view: WorkspaceDocumentView = showImplementation && profile.implementation
			&& (build.tabReady || !build.snapshot)
		? "build"
		: presentation.type === "parent-with-child" && decisionView.phase !== "complete"
		? "plan"
		: visibleDecisionView(decisionView, hasPlanContent, unanswered, typing);
	let attention = useDecisionAttention(unanswered);
	let latestCanEdit = useRef(canEdit);
	let latestCanManage = useRef(canManage);
	let workspacePresentation = presentWorkspace(workspace, mode, view);
	let chatActive = workspacePresentation.chatVisible;
	// `loaded` once this socket's transcript arrived, so `busy` reflects the room.
	let [chatActivity, setChatActivity] = useState({ unread: 0, busy: false, loaded: false });
	let onChatActivity = useCallback(
		(event: { type: "message" | "working"; busy: boolean; history?: true }) => {
			setChatActivity(current => ({
				busy: event.busy,
				loaded: current.loaded || !!event.history,
				unread: event.type === "message" && !chatActive
					? current.unread + 1
					: current.unread,
			}));
		},
		[chatActive],
	);
	let planVisible = workspacePresentation.documentVisible && view === "plan";
	// A child is not inside a workspace frame of its own, so its own surface scopes its editor.
	let childSurface = useRef<HTMLDivElement>(null);
	let editorFocused = useEditorFocus(presentation.type === "child" ? childSurface : frame);
	let latestPlanVisible = useRef(planVisible);
	latestPlanVisible.current = planVisible;
	let latestBusy = useRef(chatActivity.busy);
	latestBusy.current = chatActivity.busy;
	let [documentWatch, setDocumentWatch] = useState(QUIET_DOCUMENT);
	// Read through a ref: the host's callback changes as its route does, and the socket below must
	// not reconnect (remounting the editor and losing its scroll) when a child opens over it.
	let latestMetadataChanged = useRef(onMetadataChanged);
	latestMetadataChanged.current = onMetadataChanged;
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
		if (latestMetadataChanged.current) {
			latestMetadataChanged.current(metadata);
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
	}, [onDocumentChanged, room, userId]);

	// Focus alone never routes: only new decisions or new prose re-evaluate the opening.
	useEffect(() => {
		let next = advanceDecisionView(decisionView, hasPlanContent, unanswered, typing);
		if (next === decisionView) return;
		setDecisionView(state => (state === decisionView ? next : state));
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- typing and decisionView are read, not triggers
	}, [hasPlanContent, unanswered]);

	// Announce the route only once it has applied: a tab choice in the same
	// batch makes the routing updater above a no-op.
	let routedPhase = useRef(decisionView.phase);
	useEffect(() => {
		let before = routedPhase.current;
		routedPhase.current = decisionView.phase;
		if (before !== "initial" || decisionView.phase !== "forced") return;
		setAnnouncement(current => ({
			text: `Showing Decisions: ${unanswered} to answer`,
			sequence: current.sequence + 1,
		}));
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- the count is read when routing applies
	}, [decisionView.phase]);

	useEffect(() => {
		if (!taskLink || !hasPlanContent) return;
		setTaskLink(false);
		setShowImplementation(true);
		dispatch({ type: "set-chat", open: false });
	}, [taskLink, hasPlanContent, dispatch]);

	useEffect(() => {
		setChatActivity(current => current.loaded ? { ...current, loaded: false } : current);
	}, [wire]);

	useEffect(() => {
		if (!chatActive) return;
		setChatActivity(current => current.unread === 0 ? current : { ...current, unread: 0 });
	}, [chatActive]);

	useEffect(() => {
		if (planVisible) setDocumentWatch(state => advanceDocumentActivity(state, { type: "seen" }));
	}, [planVisible]);

	useEffect(() => {
		setDocumentWatch(state =>
			advanceDocumentActivity(state, { type: chatActivity.busy ? "started" : "idle" })
		);
	}, [chatActivity.busy]);

	useEffect(() => {
		if (documentWatch.following !== "awaiting") return;
		let timer = window.setTimeout(
			() => setDocumentWatch(state => advanceDocumentActivity(state, { type: "expired" })),
			ANSWER_FOLLOW_MS,
		);
		return () => window.clearTimeout(timer);
	}, [documentWatch.following]);

	useEffect(() => {
		if (!wire) return;
		let offChanges = wire.on<Plan.Changes>("plan:changes", () => {
			if (latestPlanVisible.current) return;
			setDocumentWatch(state =>
				advanceDocumentActivity(state, { type: "changes", busy: latestBusy.current })
			);
		});
		// Only this viewer's own answer resumes a turn worth following; a discard
		// or someone else's answer may start nothing.
		let offResolved = wire.on<Question.Resolved>("question:resolved", event => {
			if (event.status !== "answered" || event.resolver !== handle) return;
			if (latestPlanVisible.current) return;
			setDocumentWatch(state =>
				advanceDocumentActivity(state, { type: "answered", busy: latestBusy.current })
			);
		});
		return () => {
			offChanges();
			offResolved();
		};
	}, [wire, handle]);

	let selectView = (next: DecisionView, revealFirst = true) => {
		setDecisionView(state => selectDecisionView(state, next));
		if (hasPlanContent && profile.persistView) {
			localStorage.setItem("chopin:view:document", next);
		}
		if (next === "decisions" && revealFirst) {
			let first = firstOpenDecision(entries, cardMetadata);
			setReveal({ widget: first?.id ?? "", token: Date.now(), resume: true });
		}
	};

	let selectDestination = (destination: WorkspaceDocumentView) => {
		setShowImplementation(destination === "build");
		if (destination !== "build") selectView(destination, mode === "split");
		dispatch({ type: "set-chat", open: false });
	};
	let latestSelectDestination = useRef(selectDestination);
	latestSelectDestination.current = selectDestination;
	// Stable, because the editor rebuilds its plugins when a callback changes.
	let showDecision = useCallback((questionnaireId: string) => {
		latestSelectDestination.current("decisions");
		setReveal({ widget: questionnaireId, token: Date.now() });
	}, []);

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
	let hasCardSource = useCallback((questionnaireId: string) => {
		let thread = conversation.state && threadForCard(conversation.state, questionnaireId);
		return !!thread?.questionSources[0];
	}, [conversation.state]);
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
			// A card behind the top of a deck is inert and cannot take focus.
			revealDeckItem(card);
			card.tabIndex = -1;
			card.focus();
		});
	};

	let startResearch = async (brief: string): Promise<ResearchLaunchResult> => {
		let checked = researchLauncher.check(brief);
		if (!checked.ok) return checked;
		selectDestination("plan");
		// The document may have been hidden; open once it has laid out.
		await new Promise(resolve => requestAnimationFrame(resolve));
		return researchLauncher.open(brief);
	};
	let showResearchDraft = () => {
		selectDestination("plan");
		requestAnimationFrame(() => researchLauncher.reveal());
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
			...(profile.chat ? [conversationStore.listen(socket)] : []),
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
			socket.on<Session.Planner>("session:planner", frame => {
				setPlannerAttachment({ wire: socket, planner: frame.planner });
			}),
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
		profile.chat,
		profile.surface,
		threads,
		cardMeta,
		conversationStore,
		updateMetadata,
	]);

	let workspaceArchivedAt = archivedAt ?? metadata.archivedAt;
	let workspaceCanEdit = effectiveCanEdit && !workspaceArchivedAt;
	let editMode = documentEditMode({
		canEdit: !!workspaceCanEdit && !implementation.locked,
		editing,
		phone,
	});
	// An empty document has nothing to read, so it opens ready to write. Decided once, on arrival.
	let [arrived, setArrived] = useState(false);
	useEffect(() => {
		if (!planState.synced || arrived) return;
		setArrived(true);
		if (opensEditing({ empty: planState.empty })) setEditing(true);
	}, [arrived, planState.synced, planState.empty]);
	// A failed open says so instead; the lines would otherwise pulse beside it indefinitely.
	let loading = !arrived && !planState.failed;
	// A child on a phone borrows its parent's tab bar (see child-phone-chrome.ts).
	let childChrome = useContext(ChildPhoneChromeContext);
	// Where this room's title goes when it is an open child, and where its own child's goes.
	let childTitle = useContext(ChildTitleContext);
	let [childTitleSlot, setChildTitleSlot] = useState<HTMLElement | null>(null);
	let childRoom = presentation.type === "child";
	let childOpen = presentation.type === "parent-with-child";
	// A child opening over this document takes the pencil, so this one goes back to reading.
	useEffect(() => {
		if (childOpen) setEditing(false);
	}, [childOpen]);
	let [childEdit, setChildEdit] = useState<{ docked: boolean; editing: boolean }>();
	let childToggle = useRef<() => void>(undefined);
	let reportChildEdit = useCallback(
		(state?: { docked: boolean; editing: boolean }, toggle?: () => void) => {
			childToggle.current = toggle;
			setChildEdit(current => sameEditState(current, state) ? current : state);
		},
		[],
	);
	// What this room's own editor shows: a child is on screen only while its parent's Document is.
	let shown = childRoom ? !!childChrome?.visible : planVisible && !childOpen;
	// Only the document's own keyboard gets formatting: never Chat, a comment reply, or the title.
	// A panel lets the keyboard go on purpose, so it keeps the dock up in the keyboard's place.
	let docked = editMode === "editing" && shown
		&& (formatPanel || (keyboardOpen && editorFocused));
	let toggleEditing = () => {
		// Synchronous, so the editor takes focus inside the tap and iOS raises the keyboard.
		flushSync(() => {
			setEditing(!editing);
			// Chat opens over the document without changing `view`, so ask what is on screen.
			if (editing || shown) return;
			if (childRoom) childChrome?.showDocument();
			else selectDestination("plan");
		});
	};
	let latestToggle = useRef(toggleEditing);
	latestToggle.current = toggleEditing;
	let reportEdit = childChrome?.report;
	useLayoutEffect(() => {
		reportEdit?.(
			editMode ? { docked, editing: editMode === "editing" } : undefined,
			() => latestToggle.current(),
		);
	}, [docked, editMode, reportEdit]);
	useEffect(() => () => reportEdit?.(undefined), [reportEdit]);
	let childChromeValue = useMemo(
		() => ({
			formatDock,
			report: reportChildEdit,
			showDocument: () => latestSelectDestination.current("plan"),
			visible: planVisible,
		}),
		[formatDock, planVisible, reportChildEdit],
	);
	let investigationsEditable = !!workspaceCanEdit && status === "connected";
	let investigations = useMemo<InvestigationResources>(() => ({
		create: (brief, requestId) => experiments.action("", "", { id: requestId, brief }),
		cancel: id => experiments.action(id, "cancel", {}),
		removable: id => removableInvestigation(experiments, id),
		render: (id, remove) => (
			<InvestigationReference
				store={experiments}
				id={id}
				userId={userId}
				canEdit={investigationsEditable}
				locked={implementation.locked}
				onRemove={remove}
				onOpen={(child, opener) => onResearchChildOpen(room, child, { current: opener })}
			/>
		),
	}), [
		experiments,
		userId,
		investigationsEditable,
		implementation.locked,
		onResearchChildOpen,
		room,
	]);
	let experimentResources = useMemo<ExperimentResources>(() => ({
		subscribe: experiments.subscribe,
		snapshot: experiments.snapshot,
		get: id => experiments.get(id),
		load: id => experiments.load(id),
		change: (id, view, patch) => experiments.change(id, view, patch),
		place: (id, view, decision, remove) => experiments.place(id, view, decision, remove),
		actions: (id, view) => (
			<ViewDecision
				store={experiments}
				id={id}
				view={view}
				disabled={!investigationsEditable || implementation.locked}
			/>
		),
	}), [experiments, investigationsEditable, implementation.locked]);
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
	let acceptedComments =
		threadState.threads.filter(item => item.thread.status === "accepted" && !item.applied).length;
	// The threads a phone's list of comments can show: open, with a passage left to stand on.
	let openComments =
		threadState.threads.filter(item =>
			item.thread.status === "open" && !item.orphaned && !item.drifted
		).length;

	let statusNotices = (
		<>
			{!!planState.lost && planState.lost !== lostSeen && (
				<div className="plan-status" data-level="alert" role="alert">
					<span className="plan-status-text">
						<span
							aria-hidden="true"
							className="plan-status-label"
							data-tooltip={LOST_EDITS}
							data-tooltip-verbatim=""
						>
							Edits not saved
						</span>
						<span aria-hidden="true" className="plan-status-detail">{LOST_EDITS}</span>
						<span className="sr-only">{LOST_EDITS}</span>
					</span>
					<button
						className="btn btn-sm btn-ghost"
						onClick={() =>
							setLostSeen(planState.lost ?? 0)}
						type="button"
					>
						Dismiss
					</button>
				</div>
			)}
			{/* Apart from PlanStatus, which would announce its end as "Reconnected". */}
			{planState.refused && (
				<div className="plan-status" data-level="notice">
					<span aria-hidden="true" className="plan-status-dot" />
					<span aria-hidden="true" className="plan-status-text">
						<span
							className="plan-status-label"
							data-tooltip={UNDO_REFUSALS[planState.refused.reason]}
							data-tooltip-verbatim=""
						>
							Can't undo
						</span>
						<span className="plan-status-detail">
							{UNDO_REFUSALS[planState.refused.reason]}
						</span>
					</span>
				</div>
			)}
			<span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
				{planState.refused && `Can't undo. ${UNDO_REFUSALS[planState.refused.reason]}`}
			</span>
			<PlanStatus
				connection={status === "deleted" ? "closed" : treatAsConnected ? undefined : status}
				failed={planState.failed}
				onReconnect={wire && reconnects < RECONNECTS_BEFORE_RELOAD
					? () => {
						setReconnects(count => count + 1);
						wire.reconnect();
					}
					: undefined}
				synced={planState.synced}
			/>
		</>
	);
	let plan = (
		<GitHubReferencesProvider value={githubReferences}>
			<PlanEditor
				experiments={experimentResources}
				investigations={profile.research ? investigations : undefined}
				cardMeta={cardMeta}
				evidence={showEvidence}
				onCardSource={showCardSource}
				hasCardSource={hasCardSource}
				// A child has no Decisions pane to open, so its decisions stay inline.
				onShowDecision={presentation.type === "child" ? undefined : showDecision}
				planner={agent}
				commentPresentation={mode === "split" ? "popover" : "sheet"}
				connection={status === "deleted" ? "closed" : status}
				key={workspaceArchivedAt ? "archived" : "active"}
				disclosureMotion={motionContract("collapse")}
				editMode={editMode}
				formatDock={docked ? childRoom ? childChrome?.formatDock : formatDock : undefined}
				onFormatPanel={setFormatPanel}
				motionImmediately={settleMotionImmediately}
				onScrollTop={setPlanScrollTop}
				onState={setPlanState}
				// The skeleton's lines continue in the column until the document first arrives; a
				// later reconnection keeps the document it already shows.
				preface={presentation.type === "child" && presentation.parent || loading
					? (
						<>
							{presentation.type === "child" && presentation.parent && (
								<ChildProvenance channelId={room} parent={presentation.parent} />
							)}
							{loading && <DocumentSkeleton />}
						</>
					)
					: undefined}
				questionMotion={QUESTION_MOTION}
				questions={questions}
				readOnly={!workspaceCanEdit || implementation.locked}
				research={profile.research ? research : undefined}
				researchLauncher={researchLauncher}
				scrollTop={planScrollTop}
				threads={threads}
				user={user}
				wire={wire}
			/>
		</GitHubReferencesProvider>
	);
	let titleProps: TitleProps = {
		archivedAt: workspaceArchivedAt,
		canManage: effectiveCanManage,
		editing: titleEdit,
		label: metadata.title,
		onAction: action => onDocumentAction(room, action),
		onEditingChange: setTitleEdit,
		onRenamed: updateMetadata,
		project: { id: repository.id, name: repository.name },
		room,
	};

	if (presentation.type === "child") {
		let childTitleControl = <DocumentTitle {...titleProps} project={undefined} />;
		return (
			<div
				className="child-document flex h-full min-h-0 flex-col bg-page"
				data-workspace-room={room}
				data-workspace-surface="child"
				ref={childSurface}
			>
				<p aria-live="polite" className="sr-only" role="status">
					<span key={announcement.sequence}>{announcement.text}</span>
				</p>
				{childTitle?.slot && (childTitle.phone
					? createPortal(
						<PhoneHeaderContent
							archivedAt={workspaceArchivedAt}
							canManage={effectiveCanManage}
							comments={openComments}
							editing={titleEdit}
							editingDocument={editMode === "editing"}
							label={metadata.title}
							members={members}
							onAction={action => onDocumentAction(room, action)}
							onComments={() => {
								childChrome?.showDocument();
								openCommentList(room);
							}}
							onEditingChange={setTitleEdit}
							onRenamed={updateMetadata}
							lead={`in ${presentation.parent?.label ?? childTitle.parent}`}
							room={room}
						/>,
						childTitle.slot,
					)
					: createPortal(childTitleControl, childTitle.slot))}
				{childTitle?.motion === "lift" && (
					<div
						className="document-title-bar panel-header flex shrink-0 items-center px-(--panel-toolbar-padding-inline) hairline-b"
						data-child-title-bar
					>
						<span className="child-title-icon">
							<MagnifierIcon aria-hidden="true" size={14} />
						</span>
						<div className="document-title-slot">{childTitleControl}</div>
						<button
							aria-label={`Back to ${presentation.parent?.label ?? "parent document"}`}
							className="btn btn-icon btn-ghost shrink-0"
							data-tooltip={`Back to ${presentation.parent?.label ?? "parent document"}`}
							onClick={presentation.onClose}
							type="button"
						>
							<CloseIcon aria-hidden="true" size={14} />
						</button>
					</div>
				)}
				<div className="child-document-status">{statusNotices}</div>
				<section
					aria-label="Document"
					className="child-document-scroll min-h-0 flex-1"
					data-document-view="plan"
				>
					{/* With no Decisions pane, a phone saves the child's cards from a bar of its own. */}
					<DecisionSaveHost phone={phone}>{plan}</DecisionSaveHost>
				</section>
			</div>
		);
	}

	// Only the split workspace has title bars; compact and phones keep the stack bar.
	let zoomChild: TitlePath | undefined =
		presentation.type === "parent-with-child" && presentation.motion === "zoom" && mode === "split"
			? {
				child: presentation.path.at(-1)!.label,
				onReturn: presentation.onChildClose,
				// Off Document the child is out of sight, so its crumb leads back to it rather than
				// offering a rename that would act on a document the pane isn't showing.
				onShowChild: view === "plan" ? undefined : () => {
					selectDestination("plan");
					requestAnimationFrame(() => {
						document.querySelector<HTMLElement>(
							`[data-workspace-room="${room}"] .anchored-child-card:last-of-type`,
						)?.focus({ preventScroll: true });
					});
				},
				slot: setChildTitleSlot,
			}
			: undefined;
	// A phone's top bar takes the child's title, controls and people in place of this room's.
	let childTitleValue = presentation.type === "parent-with-child" && phone
		? { motion: "zoom" as const, parent: metadata.title, phone: true, slot: childTitleSlot }
		: presentation.type === "parent-with-child" && mode === "split"
		? { motion: presentation.motion, slot: zoomChild ? childTitleSlot : null }
		: undefined;
	// Build plan or the build capsule sits beside the people here; a child open beside its parent
	// has no build of its own. A phone shows this room's bar only off Document, so it keeps it.
	let buildSlot = profile.implementation && (presentation.type !== "parent-with-child" || phone)
		&& (
			<BuildPlanButton
				build={build}
				canEdit={!!workspaceCanEdit && status === "connected"}
				compact={mode !== "split"}
				hot={buildHover === "tab"}
				onExplain={phone ? explainBuild : undefined}
				phone={phone}
				onHover={on => setBuildHover(on ? "capsule" : undefined)}
				onOpen={() => selectDestination("build")}
				tabReady={build.tabReady}
			/>
		);

	// The tab bar's pencil edits the document on screen: an open child, or else this one.
	let barEdit = childOpen
		? childEdit && { ...childEdit, toggle: () => childToggle.current?.() }
		: editMode && { docked, editing: editMode === "editing", toggle: toggleEditing };

	return (
		<ChildPhoneChromeContext.Provider value={childChromeValue}>
			<ChildTitleContext.Provider value={childTitleValue}>
				<p aria-live="polite" className="sr-only" role="status">
					<span key={announcement.sequence}>{announcement.text}</span>
				</p>
				<Workspace
					available={available}
					buildEnabled={build.tabReady}
					buildGlyph={<BuildGlyph look={build.look} />}
					buildHot={buildHover === "capsule"}
					buildUnavailable={buildUnavailable}
					onBuildHover={on => setBuildHover(on ? "tab" : undefined)}
					onBuildUnavailable={() => explainBuild()}
					phoneHint={buildHint?.text}
					frame={frame}
					chat={
						<Chat
							active={chatActive}
							agent={agent}
							focus={presentation.type === "parent-with-child" ? presentation.childId : undefined}
							onOpenChild={presentation.onChildOpen}
							connected={status === "connected"}
							readonly={!workspaceCanEdit}
							archived={!!workspaceArchivedAt}
							handle={handle}
							onActivity={onChatActivity}
							notice={workspaceArchivedAt
								? effectiveCanManage
									? "Archived. Restore it to keep chatting."
									: "This document is archived."
								: !workspaceCanEdit
								? "You have read-only access to this document."
								: undefined}
							onShowDecisions={() => selectDestination("decisions")}
							onResearch={researchEnabled ? startResearch : undefined}
							onShowResearch={showResearchDraft}
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
									handle,
									onSource: source =>
										showSource({
											source: { ...source, role: "support" },
											itemId: source.messageId,
										}),
									store: research,
									onAction: actOnResearchOffer,
									onRetryLink: offerId => researchLinks.refresh(offerId, true),
								}
								: undefined}
							decisions={{
								questions,
								meta: cardMeta,
								wire,
								connected: treatAsConnected,
								canEdit: workspaceCanEdit,
								onOpenCard: showDecisionCard,
							}}
							referencesEnabled={chatReferences.wire === wire && chatReferences.enabled}
							repository={repository}
							room={room}
							sendAcknowledgements={chatSendAcks.wire === wire && chatSendAcks.enabled}
							planner={plannerAttachment.wire === wire ? plannerAttachment.planner : undefined}
							wire={wire}
						/>
					}
					chatActivity={chatActivity}
					documentActivity={documentActivity(documentWatch, chatActivity.busy)}
					header={phone
						? (
							<PhoneHeader
								// The child's bar goes with its document: Chat, Decisions and Build are this room's.
								child={presentation.type === "parent-with-child" && planVisible
									? { onReturn: presentation.onChildClose, slot: setChildTitleSlot }
									: undefined}
								label={metadata.title}
								presentation={presentation}
							>
								<PhoneHeaderContent
									archivedAt={workspaceArchivedAt}
									canManage={effectiveCanManage}
									comments={openComments}
									context={buildSlot}
									editing={titleEdit}
									editingDocument={!childOpen && !!barEdit?.editing}
									label={metadata.title}
									members={members}
									onAction={action => onDocumentAction(room, action)}
									onComments={() => {
										// The list stands over the document, so it opens from any tab onto it.
										selectDestination("plan");
										openCommentList(room);
									}}
									onEditingChange={setTitleEdit}
									onRenamed={updateMetadata}
									lead={repository.name}
									room={room}
								/>
							</PhoneHeader>
						)
						: <Header {...titleProps} build={buildSlot} members={members} />}
					title={
						<DocumentTitle
							{...titleProps}
							icon
							path={zoomChild}
						/>
					}
					controls={
						<>
							<DecisionViewControl
								attention={attention}
								buildEnabled={profile.implementation ? build.tabReady : undefined}
								buildGlyph={<BuildGlyph look={build.look} />}
								buildHot={buildHover === "capsule"}
								onBuildHover={on => setBuildHover(on ? "tab" : undefined)}
								documentActivity={documentActivity(documentWatch, chatActivity.busy)}
								onView={selectDestination}
								unanswered={unanswered}
								view={view}
							/>
						</>
					}
					// Build plan or its capsule closes the status, so the rule before the faces follows it.
					status={<>{statusNotices}{mode === "split" && buildSlot}</>}
					ids={workspaceIds}
					phoneAction={barEdit && (
						<button
							aria-label={barEdit.editing ? "Done editing" : "Edit document"}
							className="phone-tab-action"
							data-editing={barEdit.editing || undefined}
							onClick={barEdit.toggle}
							type="button"
						>
							<PencilIcon aria-hidden="true" data-edit-icon="edit" size={24} />
							<CheckIcon aria-hidden="true" data-edit-icon="done" size={24} />
						</button>
					)}
					// Formatting rides above the keyboard while typing. With the keyboard down the tabs
					// return, and a selection gets the ordinary bubble instead.
					phoneToolbar={barEdit?.docked && <div className="contents" ref={setFormatDock} />}
					identity={room}
					mode={mode}
					presence={<RoomMembers members={members} ring="page" />}
					phone={phone}
					onDesktopChatOpen={setDesktopChatOpen}
					onChatOpen={open => dispatch({ type: "set-chat", open })}
					onDestination={selectDestination}
					build={profile.implementation && (
						<BuildView
							active={workspacePresentation.documentVisible && view === "build"}
							build={build}
							canEdit={!!workspaceCanEdit && status === "connected"}
							comments={acceptedComments}
							onShowDecisions={() => selectDestination("decisions")}
							onShowDocument={() => selectDestination("plan")}
							room={room}
							unanswered={unanswered}
							userId={userId}
						/>
					)}
					decisions={
						<Decisions
							additional={
								<EvidenceDecisions
									store={experiments}
									canEdit={!!workspaceCanEdit && status === "connected"}
								/>
							}
							hasAdditional={[...experiments.values.values()].some(item =>
								item.decisions.length > 0
							)}
							cardMeta={cardMeta}
							canEdit={workspaceCanEdit}
							connected={treatAsConnected && workspaceCanEdit}
							headingId={workspaceIds.heading.decisions}
							motion={motionContract("collapse")}
							motionImmediately={settleMotionImmediately}
							onShowPlan={showPlan}
							planner={agent}
							questionMotion={QUESTION_MOTION}
							reveal={reveal}
							self={handle}
							store={questions}
							wire={wire}
						/>
					}
					plan={plan}
					state={workspace}
					presentation={presentation}
					unanswered={unanswered}
					view={view}
				/>
			</ChildTitleContext.Provider>
		</ChildPhoneChromeContext.Provider>
	);
}
