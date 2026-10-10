/** Three panes on one ground, with the document as the only raised surface. */

import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Count } from "@chopin/editor/count";
import { ContentSwapLayer } from "@chopin/editor/content-swap";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { CloseIcon, CollapseIcon, ExpandIcon } from "@chopin/icons";

import {
	CHAT_CHOICE_STORAGE_KEY,
	initialWorkspaceState,
	presentWorkspace,
	storedDesktopChat,
	transitionWorkspace,
	workspaceDestinations,
	workspaceHeadingId,
	workspaceProfile,
} from "./workspace-model";
import { clampPane, ResizeHandle, usePaneWidth } from "./resizable-pane";
import { workspaceSizing } from "./workspace-sizing";
import "./workspace-sizing.css";
import { motionContract } from "./motion-contract";
import { motionImmediately } from "./motion-input";
import { sidebarMoving, usePaneMotion, usePaneSettledWidth } from "./pane-motion";
import { listenForShortcuts } from "./global-shortcuts";
import { currentShortcutPlatform, shortcutLabel } from "./shortcuts";
import { DocumentActivityDot, documentActivityLabel } from "./document-activity";
import { BUILD_UNAVAILABLE } from "./decision-view-control";

import type { CSSProperties, Dispatch, ReactNode, RefObject } from "react";
import type { DocumentActivity } from "./document-activity";
import type {
	WorkspaceDestination,
	WorkspaceDocumentView,
	WorkspaceEvent,
	WorkspaceMode,
	WorkspacePresentation,
	WorkspaceProfile,
	WorkspaceState,
} from "./workspace-model";

export type Pane = "chat";

const CHAT_PANE = {
	initial: 500,
	max: Number.MAX_SAFE_INTEGER,
	min: 250,
	storageKey: "chopin:pane:chat",
};

export type WorkspaceIds = {
	heading: Record<WorkspaceDestination, string>;
	pane: Record<Pane, string>;
};

export function useWorkspaceIds(): WorkspaceIds {
	let instance = useId();
	return {
		heading: {
			build: workspaceHeadingId("build", instance),
			plan: workspaceHeadingId("plan", instance),
			decisions: workspaceHeadingId("decisions", instance),
			chat: workspaceHeadingId("chat", instance),
		},
		pane: { chat: `${instance}-pane-chat` },
	};
}

export function useWorkspaceLayout() {
	let frame = useRef<HTMLDivElement>(null);
	let [available, setAvailable] = useState(() => Math.max(0, window.innerWidth - 24));
	useLayoutEffect(() => {
		let element = frame.current;
		if (!element) return;
		let measure = () => {
			if (!sidebarMoving()) setAvailable(element.clientWidth);
		};
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(element);
		document.addEventListener("transitionend", measure);
		document.addEventListener("transitioncancel", measure);
		return () => {
			observer.disconnect();
			document.removeEventListener("transitionend", measure);
			document.removeEventListener("transitioncancel", measure);
		};
	}, []);
	return { available, frame, mode: workspaceSizing(available, 500).mode };
}

/** Only the desktop Chat preference crosses a page load. */
export function useWorkspaceState(
	profile: WorkspaceProfile,
): [WorkspaceState, Dispatch<WorkspaceEvent>] {
	let [state, dispatch] = useReducer(
		transitionWorkspace,
		undefined,
		// A child opens with its parent's saved Chat preference but never saves its own.
		() =>
			initialWorkspaceState(
				storedDesktopChat(localStorage.getItem(CHAT_CHOICE_STORAGE_KEY)),
			),
	);

	useEffect(() => {
		if (!profile.persistChat || state.desktopChatOpen === undefined) return;
		localStorage.setItem(
			CHAT_CHOICE_STORAGE_KEY,
			String(state.desktopChatOpen),
		);
	}, [profile.persistChat, state.desktopChatOpen]);

	return [state, dispatch];
}

export type WorkspaceProps = {
	header: ReactNode;
	available?: number;
	frame?: RefObject<HTMLDivElement | null>;
	chat?: ReactNode;
	plan: ReactNode;
	decisions: ReactNode;
	build?: ReactNode;
	buildEnabled?: boolean;
	controls: ReactNode;
	/** Connection and document status, right-aligned in the document header. */
	status?: ReactNode;
	/** People present in the room, shown after the status in the document tab row. */
	presence?: ReactNode;
	ids: WorkspaceIds;
	mode: WorkspaceMode;
	state: WorkspaceState;
	view: WorkspaceDocumentView;
	onChatOpen: (open: boolean) => void;
	onDesktopChatOpen: (open: boolean) => void;
	onDestination: (destination: WorkspaceDocumentView) => void;
	unanswered: number;
	chatActivity: { unread: number; busy: boolean };
	documentActivity?: DocumentActivity;
	identity?: string;
	presentation: WorkspacePresentation;
};

/** One button that trades the Chat column for a full-width document and back. */
export function SurfaceToggle(
	{ activity, buttonRef, controls, expanded, onToggle }: {
		activity: WorkspaceProps["chatActivity"];
		buttonRef?: RefObject<HTMLButtonElement | null>;
		controls: string;
		expanded: boolean;
		onToggle: () => void;
	},
) {
	let status = activity.busy
		? "Planner working"
		: activity.unread > 0
		? `${activity.unread} unread`
		: undefined;
	let feedback = motionContract("feedback").className;
	let unread = !activity.busy && activity.unread > 0;
	return (
		<button
			aria-controls={controls}
			aria-expanded={expanded ? false : undefined}
			aria-label={expanded ? `Show chat${status ? `, ${status}` : ""}` : "Expand document"}
			className={`chat-toggle btn btn-icon btn-ghost relative shrink-0 ${
				expanded ? "surface-toggle-restore" : ""
			}`}
			data-activity={activity.busy ? "busy" : unread ? "unread" : undefined}
			data-tooltip={expanded ? "Show chat" : "Expand document"}
			data-tooltip-shortcut={shortcutLabel("toggle-chat", currentShortcutPlatform())}
			onClick={onToggle}
			ref={buttonRef}
			type="button"
		>
			<span
				className={`${feedback} grid size-(--icon-size-default)`}
				data-motion-feedback="icon"
				key={expanded ? "restore" : "expand"}
			>
				{expanded ? <CollapseIcon size={14} /> : <ExpandIcon size={14} />}
			</span>
			{expanded && <span>Chat</span>}
			{expanded && status && (
				<span
					aria-hidden="true"
					className={`absolute right-1 top-1 size-1.5 rounded-full bg-brand ${
						unread ? feedback : ""
					}`}
					data-motion-feedback={unread ? "count" : undefined}
				/>
			)}
		</button>
	);
}

function destinationLabel(
	destination: WorkspaceDestination,
	unanswered: number,
	activity: WorkspaceProps["chatActivity"],
	document: DocumentActivity,
): string {
	if (destination === "build") return "Build";
	if (destination === "plan") return documentActivityLabel(document);
	if (destination === "decisions" && unanswered > 0) {
		return `Decisions, ${unanswered} unanswered`;
	}
	if (destination === "chat" && activity.busy && activity.unread > 0) {
		return `Chat, Planner working, ${activity.unread} unread`;
	}
	if (destination === "chat" && activity.busy) return "Chat, Planner working";
	if (destination === "chat" && activity.unread > 0) {
		return `Chat, ${activity.unread} unread`;
	}
	return destination === "chat" ? "Chat" : destination === "decisions"
		? "Decisions"
		: "Document";
}

export function Workspace(
	{
		available = 950,
		build,
		buildEnabled = true,
		frame,
		chat,
		controls,
		ids,
		chatActivity,
		decisions,
		documentActivity,
		header,
		identity,
		mode,
		onChatOpen,
		onDesktopChatOpen,
		onDestination,
		plan,
		presence,
		presentation: workspacePresentation,
		state,
		status,
		unanswered,
		view,
	}: WorkspaceProps,
) {
	let profile = workspaceProfile(workspacePresentation);
	let [preferredWidth, resizePreferred] = usePaneWidth({
		active: mode === "split",
		...CHAT_PANE,
		storageKey: profile.persistPaneSize ? CHAT_PANE.storageKey : undefined,
	});
	let { chat: chatWidth, maximum } = workspaceSizing(available, preferredWidth);
	let resizeChat = (delta: number) => {
		let next = clampPane(chatWidth + delta, CHAT_PANE.min, maximum);
		resizePreferred(next - preferredWidth);
	};
	let root = useRef<HTMLDivElement>(null);
	let presentation = presentWorkspace(state, mode, view);
	let childPresentation = workspacePresentation.type === "child"
		? workspacePresentation
		: undefined;
	let paperObscured = workspacePresentation.type === "parent-with-child";
	// A child's own header is hidden, so the parent's carries its breadcrumb and Return control.
	let headerHidden = presentation.documentExpanded && !paperObscured;
	let immediately = motionImmediately();
	let contentSwapMotion = motionContract("content-swap");
	let chatPresence = useTransitionPresence(
		presentation.chatVisible ? true : undefined,
		220,
		immediately,
	);
	let chatTrack = usePaneMotion(chatPresence.phase);
	let documentSwap = useRef<HTMLDivElement>(null);
	usePaneSettledWidth(documentSwap);
	// The outgoing document stays under Chat until Chat has faded in over it.
	let documentPresence = useTransitionPresence(
		presentation.documentVisible ? true : undefined,
		contentSwapMotion.closeDuration,
		immediately,
	);
	let destination: WorkspaceDestination = mode !== "split" && presentation.chatVisible
		? "chat"
		: view;
	let [travel, setTravel] = useState({ destination, back: false });
	if (travel.destination !== destination) {
		let order = workspaceDestinations(profile.implementation);
		setTravel({
			back: order.indexOf(destination) < order.indexOf(travel.destination),
			destination,
		});
	}
	let opener = useRef<HTMLElement | undefined>(undefined);
	let edgeTab = useRef<HTMLButtonElement>(null);
	let previousChatOpen = useRef(state.chatOpen);
	let chatInactive = !presentation.chatVisible;
	let destinations = workspaceDestinations(profile.implementation);
	let buildReason = useId();
	let focusDestination = (destination: WorkspaceDestination) => {
		root.current?.querySelector<HTMLElement>(`#${CSS.escape(ids.heading[destination])}`)
			?.focus({ preventScroll: true });
	};

	useLayoutEffect(() => {
		if (!previousChatOpen.current && state.chatOpen) {
			let active = document.activeElement;
			if (active instanceof HTMLElement) opener.current = active;
			if (mode !== "split") {
				focusDestination("chat");
			}
		}
		previousChatOpen.current = state.chatOpen;
	}, [mode, state.chatOpen]);

	let previousMode = useRef(mode);
	useLayoutEffect(() => {
		if (previousMode.current === mode) return;
		previousMode.current = mode;
		if (document.activeElement?.closest("[hidden], [inert]")) {
			focusDestination(presentation.documentVisible ? view : "chat");
		}
	}, [mode]);

	let navigate = (destination: WorkspaceDestination, source?: HTMLElement) => {
		if (destination === "chat" && source) opener.current = source;
		if (destination === "chat") onChatOpen(true);
		else onDestination(destination);
		requestAnimationFrame(() => {
			focusDestination(destination);
		});
	};

	let dismissChat = () => {
		if (mode === "split") {
			onDesktopChatOpen(false);
			requestAnimationFrame(() => edgeTab.current?.focus({ preventScroll: true }));
		} else {
			onChatOpen(false);
			requestAnimationFrame(() => opener.current?.focus({ preventScroll: true }));
		}
	};

	let showDesktopChat = () => {
		onDesktopChatOpen(true);
		requestAnimationFrame(() => {
			focusDestination("chat");
		});
	};

	let toggleChat = useRef(() => {});
	toggleChat.current = () => {
		if (!presentation.chatVisible) {
			if (mode === "split") showDesktopChat();
			else navigate("chat");
			return;
		}
		let pane = root.current?.querySelector(`#${CSS.escape(ids.pane.chat)}`);
		// Keep focus where it was unless closing the pane would strand it.
		let active = document.activeElement;
		// Hiding Chat also hides the top bar while expanded, so focus there would be stranded too.
		let stranded = pane?.contains(active)
			|| root.current?.querySelector(".workspace-header-slot")?.contains(active);
		if (mode !== "split" || stranded) dismissChat();
		else onDesktopChatOpen(false);
	};
	let chatShortcutEnabled = !!chat && !paperObscured;
	useEffect(() => {
		if (!chatShortcutEnabled) return;
		return listenForShortcuts(() => ({ "toggle-chat": () => toggleChat.current() }));
	}, [chatShortcutEnabled]);

	return (
		<div
			className="workspace-root flex h-full flex-col overflow-hidden bg-ground"
			data-document-expanded={presentation.documentExpanded || undefined}
			data-header-hidden={headerHidden || undefined}
			data-workspace-mode={mode}
			data-workspace-room={identity}
			data-workspace-surface={profile.surface}
			data-workspace-travel={travel.back ? "back" : undefined}
			ref={root}
			style={mode === "split" ? { "--chat-width": `${chatWidth}px` } as CSSProperties : undefined}
		>
			<div
				aria-hidden={headerHidden || undefined}
				className="workspace-header-slot shrink-0"
				inert={headerHidden}
			>
				{header}
			</div>

			{mode !== "split" && (
				<nav
					aria-label="Workspace view"
					className={`workspace-navigation hairline-b grid shrink-0 bg-ground p-1 ${
						profile.implementation ? "grid-cols-4" : "grid-cols-3"
					}`}
				>
					{destinations.map(destination => {
						let active = destination === "chat"
							? presentation.chatVisible
							: !presentation.chatVisible && view === destination;
						let label = destinationLabel(
							destination,
							unanswered,
							chatActivity,
							active ? undefined : documentActivity,
						);
						let unavailable = destination === "build" && !buildEnabled;
						return (
							<button
								aria-current={active ? "page" : undefined}
								aria-describedby={unavailable ? buildReason : undefined}
								aria-disabled={unavailable || undefined}
								aria-label={label}
								aria-pressed={active}
								className={`btn btn-md btn-ghost min-h-11 min-w-0 ${
									unavailable ? "cursor-default opacity-40" : ""
								}`}
								key={destination}
								onClick={event => {
									if (!unavailable) navigate(destination, event.currentTarget);
								}}
								type="button"
							>
								{destination === "chat"
									? "Chat"
									: destination === "build"
									? "Build"
									: destination === "decisions"
									? "Decisions"
									: "Document"}
								{destination === "plan" && !active && (
									<DocumentActivityDot activity={documentActivity} />
								)}
								{destination === "decisions" && unanswered > 0 && (
									<span aria-hidden="true" className="ml-1" data-plan-decision-count>
										<Count motion>{unanswered}</Count>
									</span>
								)}
								{destination === "chat" && chatActivity.busy && (
									<span aria-hidden="true" className="workspace-working-indicator ml-1 shrink-0" />
								)}
								{destination === "chat" && chatActivity.unread > 0 && (
									<span aria-hidden="true" className="ml-1">
										<Count motion>{chatActivity.unread}</Count>
									</span>
								)}
							</button>
						);
					})}
					{profile.implementation && !buildEnabled && (
						<span className="sr-only" id={buildReason}>{BUILD_UNAVAILABLE}</span>
					)}
				</nav>
			)}

			<div
				aria-hidden={paperObscured || undefined}
				ref={frame}
				className={`workspace-frame relative flex min-h-0 flex-1 ${
					mode === "split"
						? "mx-3 mb-3"
						: "m-2 overflow-hidden rounded-panel bg-page shadow-resting ring-hairline"
				}`}
				data-paper-obscured={paperObscured || undefined}
				inert={paperObscured}
			>
				<main
					aria-hidden={!presentation.documentVisible || undefined}
					className="workspace-document-panel relative min-w-0 w-full flex-1"
					hidden={documentPresence.phase === "closed"}
					inert={!presentation.documentVisible}
				>
					<div className="relative flex h-full flex-col overflow-hidden">
						{mode === "split" && (
							<div
								className="panel-header flex shrink-0 items-center overflow-x-auto overflow-y-hidden px-(--panel-toolbar-padding-inline) hairline-b"
								data-document-toolbar
								onFocusCapture={event => {
									if (!(event.target instanceof HTMLElement)) return;
									let control = event.target.getBoundingClientRect();
									let toolbar = event.currentTarget.getBoundingClientRect();
									if (control.left < toolbar.left) {
										event.currentTarget.scrollLeft += Math.floor(control.left - toolbar.left);
									} else if (control.right > toolbar.right) {
										event.currentTarget.scrollLeft += Math.ceil(control.right - toolbar.right);
									}
								}}
							>
								{chat && (
									<span className="workspace-surface-toggle-slot flex shrink-0 items-center">
										<SurfaceToggle
											activity={chatActivity}
											buttonRef={edgeTab}
											controls={ids.pane.chat}
											expanded={presentation.documentExpanded}
											onToggle={presentation.documentExpanded ? showDesktopChat : dismissChat}
										/>
									</span>
								)}
								{controls}
								<div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
									{status}
									{presence}
									{childPresentation && (
										<div className="flex shrink-0 items-center">
											<button
												aria-label={`Close ${childPresentation.label}`}
												className="btn btn-icon btn-ghost -mr-1 shrink-0"
												data-child-document-close
												data-tooltip="Close document"
												onClick={childPresentation.onClose}
												type="button"
											>
												<CloseIcon aria-hidden="true" size={14} />
											</button>
										</div>
									)}
								</div>
							</div>
						)}
						{mode !== "split" && status && <div className="workspace-status-row">{status}</div>}
						<div
							className="workspace-document-swap content-swap-stack relative min-h-0 flex-1"
							data-workspace-document-swap
							ref={documentSwap}
						>
							<ContentSwapLayer
								active={presentation.documentVisible && presentation.documentView === "plan"}
								className="workspace-document-layer min-h-0"
								immediately={immediately}
								motion={contentSwapMotion}
							>
								<section
									aria-labelledby={ids.heading.plan}
									className="h-full min-h-0"
									data-document-view="plan"
								>
									<h2 className="sr-only" id={ids.heading.plan} tabIndex={-1}>Document</h2>
									{plan}
								</section>
							</ContentSwapLayer>
							<ContentSwapLayer
								active={presentation.documentVisible && presentation.documentView === "decisions"}
								className="workspace-document-layer min-h-0"
								immediately={immediately}
								motion={contentSwapMotion}
							>
								<section
									aria-labelledby={ids.heading.decisions}
									className="h-full min-h-0"
									data-document-view="decisions"
								>
									{decisions}
								</section>
							</ContentSwapLayer>
							{profile.implementation && (
								<ContentSwapLayer
									active={presentation.documentVisible && presentation.documentView === "build"}
									className="workspace-document-layer min-h-0"
									immediately={immediately}
									motion={contentSwapMotion}
								>
									<section
										aria-labelledby={ids.heading.build}
										className="h-full min-h-0"
										data-document-view="build"
									>
										<h2 className="sr-only" id={ids.heading.build} tabIndex={-1}>Build</h2>
										{build}
									</section>
								</ContentSwapLayer>
							)}
						</div>
					</div>
				</main>
				{/* `hidden` preserves pane state and subscriptions after its closing transition. */}
				{chat && (
					<aside
						aria-hidden={chatInactive || undefined}
						aria-labelledby={ids.heading.chat}
						className={`workspace-chat-panel motion-panel ${chatPresence.className} relative flex min-w-0 flex-col overflow-hidden ${
							mode === "split" ? "" : "bg-chat-pane"
						}`}
						data-pane-moving={chatTrack.moving || undefined}
						hidden={chatPresence.phase === "closed"}
						id={ids.pane.chat}
						inert={chatInactive}
						onKeyDown={event => {
							if (event.key === "Escape" && mode !== "split") {
								event.preventDefault();
								event.stopPropagation();
								dismissChat();
							}
						}}
						onTransitionEnd={chatTrack.onTransitionEnd}
						style={mode === "split" ? undefined : { width: "100%" }}
					>
						<h2 className="sr-only" id={ids.heading.chat} tabIndex={-1}>
							Chat
						</h2>
						<div className="workspace-chat-body relative min-h-0 flex-1">
							{presentation.separatorVisible && (
								<ResizeHandle
									label="Resize chat"
									max={maximum}
									min={CHAT_PANE.min}
									onResize={resizeChat}
									side="right"
									width={chatWidth}
								/>
							)}
							{chat}
						</div>
					</aside>
				)}
			</div>
		</div>
	);
}
