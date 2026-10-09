/** Three panes on one ground, with the document as the only raised surface. */

import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Count } from "@chopin/editor/count";
import { ContentSwapLayer } from "@chopin/editor/content-swap";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { CloseIcon } from "@chopin/icons";

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
import chatCloseIcon from "./assets/icons/panel-close.svg";
import chatIcon from "./assets/icons/chat.svg";
import { clampPane, ResizeHandle, usePaneWidth } from "./resizable-pane";
import { workspaceSizing } from "./workspace-sizing";
import "./workspace-sizing.css";
import { motionContract } from "./motion-contract";
import { motionImmediately } from "./motion-input";
import { sidebarMoving, usePaneMotion, usePaneSettledWidth } from "./pane-motion";
import { listenForShortcuts } from "./global-shortcuts";
import { currentShortcutPlatform, shortcutLabel } from "./shortcuts";
import { DocumentActivityDot, documentActivityLabel } from "./document-activity";

import type { CSSProperties, Dispatch, ReactNode, RefObject } from "react";
import type { DocumentActivity } from "./document-activity";
import type {
	WorkspaceDestination,
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
	controls: ReactNode;
	/** Connection and document status, right-aligned in the document header. */
	status?: ReactNode;
	ids: WorkspaceIds;
	mode: WorkspaceMode;
	state: WorkspaceState;
	view: "plan" | "decisions";
	onChatOpen: (open: boolean) => void;
	onDesktopChatOpen: (open: boolean) => void;
	onDestination: (destination: "plan" | "decisions") => void;
	unanswered: number;
	chatActivity: { unread: number; busy: boolean };
	documentActivity?: DocumentActivity;
	identity?: string;
	presentation: WorkspacePresentation;
};

export function ChatToggle(
	{
		activity,
		buttonRef,
		className,
		controls,
		onToggle,
		open,
		swapOnHover = false,
	}: {
		activity: WorkspaceProps["chatActivity"];
		buttonRef?: RefObject<HTMLButtonElement | null>;
		className?: string;
		controls: string;
		onToggle: () => void;
		open: boolean;
		swapOnHover?: boolean;
	},
) {
	let status = activity.busy
		? "Planner working"
		: activity.unread > 0
		? `${activity.unread} unread`
		: undefined;
	let feedback = motionContract("feedback").className;
	return (
		<button
			aria-controls={controls}
			aria-description={open ? status : undefined}
			aria-expanded={open}
			aria-label={open ? "Hide chat" : `Show chat${status ? `, ${status}` : ""}`}
			className={`chat-toggle btn btn-icon btn-ghost relative shrink-0 ${className ?? ""}`}
			data-tooltip={open ? "Hide chat" : "Show chat"}
			data-tooltip-shortcut={shortcutLabel("toggle-chat", currentShortcutPlatform())}
			data-tooltip-verbatim={open ? "" : undefined}
			data-activity={activity.busy ? "busy" : activity.unread > 0 ? "unread" : undefined}
			onClick={onToggle}
			ref={buttonRef}
			type="button"
		>
			{swapOnHover
				? (
					<span
						className={`${feedback} grid size-[14px]`}
						data-motion-feedback="icon"
					>
						<img
							alt=""
							className="chat-toggle-icon chat-toggle-icon-default col-start-1 row-start-1 size-[14px]"
							src={chatIcon}
						/>
						<img
							alt=""
							className="chat-toggle-icon chat-toggle-icon-sidebar col-start-1 row-start-1 size-[14px] rotate-180"
							src={chatCloseIcon}
						/>
					</span>
				)
				: (
					<img
						alt=""
						className={`${feedback} size-[14px]`}
						data-motion-feedback="icon"
						key={open ? "open" : "closed"}
						src={open ? chatCloseIcon : chatIcon}
					/>
				)}
			{status && !open && (
				<span
					aria-hidden="true"
					className={`absolute right-1 top-1 size-1.5 rounded-full bg-brand ${
						!activity.busy && activity.unread > 0 ? feedback : ""
					}`}
					data-motion-feedback={!activity.busy && activity.unread > 0 ? "count" : undefined}
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
		let order = workspaceDestinations();
		setTravel({
			back: order.indexOf(destination) < order.indexOf(travel.destination),
			destination,
		});
	}
	let opener = useRef<HTMLElement | undefined>(undefined);
	let edgeTab = useRef<HTMLButtonElement>(null);
	let previousChatOpen = useRef(state.chatOpen);
	let chatInactive = !presentation.chatVisible;
	let destinations = workspaceDestinations();
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
		if (mode !== "split" || pane?.contains(document.activeElement)) dismissChat();
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
			data-workspace-mode={mode}
			data-workspace-room={identity}
			data-workspace-surface={profile.surface}
			data-workspace-travel={travel.back ? "back" : undefined}
			ref={root}
		>
			{header}

			{mode !== "split" && (
				<nav
					aria-label="Workspace view"
					className="workspace-navigation hairline-b grid shrink-0 grid-cols-3 bg-ground p-1"
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
						return (
							<button
								aria-current={active ? "page" : undefined}
								aria-label={label}
								aria-pressed={active}
								className="btn btn-md btn-ghost min-h-11 min-w-0"
								key={destination}
								onClick={event => navigate(destination, event.currentTarget)}
								type="button"
							>
								{destination === "chat"
									? "Chat"
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
				</nav>
			)}

			<div
				aria-hidden={paperObscured || undefined}
				ref={frame}
				className={`workspace-frame relative flex min-h-0 flex-1 ${
					mode === "split"
						? "mx-3 mb-3 overflow-hidden rounded-[12px] bg-page shadow-raised ring-hairline"
						: "m-2 overflow-hidden rounded-[12px] bg-page shadow-resting ring-hairline"
				}`}
				data-paper-obscured={paperObscured || undefined}
				inert={paperObscured}
			>
				{/* `hidden` preserves pane state and subscriptions after its closing transition. */}
				{chat && (
					<aside
						aria-hidden={chatInactive || undefined}
						aria-labelledby={ids.heading.chat}
						className={`workspace-chat-panel motion-panel ${chatPresence.className} relative flex min-w-0 flex-col overflow-hidden bg-chat-pane ${
							mode === "split" ? "hairline-l hairline-r hairline-b" : ""
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
						style={mode === "split"
							? { "--chat-width": `${chatWidth}px` } as CSSProperties
							: { width: "100%" }}
					>
						{mode === "split"
							? (
								<div
									className="chat-header flex h-[46px] shrink-0 items-center gap-2 px-3.5 hairline-b"
									data-chat-header
								>
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
									<span
										aria-hidden="true"
										className="relative grid size-[14px] shrink-0"
										data-chat-identity
									>
										<img alt="" className="size-[14px]" src={chatIcon} />
										{(chatActivity.busy || chatActivity.unread > 0) && (
											<span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-brand" />
										)}
									</span>
									<h2
										className="text-sm font-medium text-text-tertiary"
										id={ids.heading.chat}
										tabIndex={-1}
									>
										Chat
									</h2>
									<ChatToggle
										activity={chatActivity}
										className="chat-header-control -mr-[5px] ml-auto"
										controls={ids.pane.chat}
										onToggle={dismissChat}
										open
									/>
								</div>
							)
							: (
								<h2 className="sr-only" id={ids.heading.chat} tabIndex={-1}>
									Chat
								</h2>
							)}
						<div className="min-h-0 flex-1">
							{chat}
						</div>
					</aside>
				)}

				<main
					aria-hidden={!presentation.documentVisible || undefined}
					className={`workspace-document-panel order-1 relative min-w-0 w-full flex-1 ${
						mode === "split" ? "hairline-l hairline-b" : ""
					}`}
					hidden={documentPresence.phase === "closed"}
					inert={!presentation.documentVisible}
				>
					<div className="relative flex h-full flex-col overflow-hidden">
						{mode === "split" && (
							<div
								className="flex h-[46px] shrink-0 items-center overflow-x-auto overflow-y-hidden px-2.5 hairline-b"
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
								{chat && !presentation.chatVisible && (
									<ChatToggle
										activity={chatActivity}
										buttonRef={edgeTab}
										className="mr-1 shrink-0"
										controls={ids.pane.chat}
										onToggle={showDesktopChat}
										open={false}
										swapOnHover
									/>
								)}
								{controls}
								<div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
									{status}
								</div>
								{childPresentation && (
									<div className="ml-auto flex shrink-0 items-center">
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
						</div>
					</div>
				</main>
			</div>
		</div>
	);
}
