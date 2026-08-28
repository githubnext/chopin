/** Three panes on one ground, with the document as the only raised surface. */

import { useEffect, useId, useLayoutEffect, useReducer, useRef, useSyncExternalStore } from "react";
import { ContentSwapLayer } from "@chopin/editor/content-swap";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { CloseIcon } from "@chopin/icons";

import {
	initialWorkspaceState,
	presentWorkspace,
	transitionWorkspace,
	WORKSPACE_MEDIA,
	workspaceDestinations,
	workspaceHeadingId,
	workspaceMode,
	workspaceProfile,
} from "./workspace-model";
import chatCloseIcon from "./assets/icons/panel-close.svg";
import chatIcon from "./assets/icons/chat.svg";
import { ResizeHandle, usePaneWidth } from "./resizable-pane";
import { motionContract } from "./motion-contract";
import { motionImmediately } from "./motion-input";

import type { Dispatch, ReactNode, RefObject } from "react";
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
	initial: 304,
	max: 400,
	min: 304,
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

function currentMode(): WorkspaceMode {
	return workspaceMode(matchMedia);
}

function subscribeMode(notify: () => void): () => void {
	let queries = WORKSPACE_MEDIA.map(matchMedia);
	for (let query of queries) query.addEventListener("change", notify);
	return () => {
		for (let query of queries) query.removeEventListener("change", notify);
	};
}

/** Read CSS width atomically so a render cannot contain two workspace modes. */
export function useWorkspaceMode(): WorkspaceMode {
	return useSyncExternalStore(subscribeMode, currentMode, currentMode);
}

/** Only the desktop Chat preference crosses a page load. */
export function useWorkspaceState(
	profile: WorkspaceProfile,
): [WorkspaceState, Dispatch<WorkspaceEvent>] {
	let [state, dispatch] = useReducer(
		transitionWorkspace,
		undefined,
		() =>
			initialWorkspaceState(
				profile,
				localStorage.getItem("chopin:pane:chat:open") !== "false",
			),
	);

	useEffect(() => {
		if (!profile.persistChat) return;
		localStorage.setItem(
			"chopin:pane:chat:open",
			String(state.desktopChatOpen),
		);
	}, [profile.persistChat, state.desktopChatOpen]);

	return [state, dispatch];
}

export type WorkspaceProps = {
	header: ReactNode;
	chat?: ReactNode;
	plan: ReactNode;
	decisions: ReactNode;
	controls: ReactNode;
	ids: WorkspaceIds;
	mode: WorkspaceMode;
	state: WorkspaceState;
	view: "plan" | "decisions";
	onChatOpen: (open: boolean) => void;
	onDesktopChatOpen: (open: boolean) => void;
	onDestination: (destination: "plan" | "decisions") => void;
	unanswered: number;
	chatActivity: { unread: number; busy: boolean };
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
			aria-expanded={open}
			aria-label={`${open ? "Hide" : "Show"} chat pane${status ? `, ${status}` : ""}`}
			className={`chat-toggle btn btn-icon btn-ghost relative shrink-0 ${className ?? ""}`}
			data-activity={activity.busy ? "busy" : activity.unread > 0 ? "unread" : undefined}
			onClick={onToggle}
			ref={buttonRef}
			type="button"
		>
			{open && swapOnHover
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
							className="chat-toggle-icon chat-toggle-icon-close col-start-1 row-start-1 size-[14px]"
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
			{status && (
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
): string {
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
		chat,
		controls,
		ids,
		chatActivity,
		decisions,
		header,
		identity,
		mode,
		onChatOpen,
		onDesktopChatOpen,
		onDestination,
		plan,
		presentation: workspacePresentation,
		state,
		unanswered,
		view,
	}: WorkspaceProps,
) {
	let profile = workspaceProfile(workspacePresentation);
	let [chatWidth, resizeChat] = usePaneWidth({
		active: mode === "split",
		...CHAT_PANE,
		storageKey: profile.persistPaneSize ? CHAT_PANE.storageKey : undefined,
	});
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

	return (
		<div
			className="workspace-root flex h-full flex-col overflow-hidden bg-ground"
			data-workspace-mode={mode}
			data-workspace-room={identity}
			data-workspace-surface={profile.surface}
			ref={root}
		>
			{header}

			<div
				aria-hidden={paperObscured || undefined}
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
						className={`workspace-chat-panel motion-panel ${chatPresence.className} order-2 relative flex min-w-0 flex-col overflow-hidden bg-chat-pane ${
							mode === "split" ? "hairline-l hairline-r hairline-b" : ""
						}`}
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
						style={mode === "split"
							? { width: chatWidth }
							: { width: "100%" }}
					>
						{mode === "split"
							? (
								<div className="group flex h-[46px] shrink-0 items-center gap-2 px-3.5 hairline-b">
									{presentation.separatorVisible && (
										<ResizeHandle
											label="Resize chat"
											max={CHAT_PANE.max}
											min={CHAT_PANE.min}
											onResize={resizeChat}
											side="left"
											width={chatWidth}
										/>
									)}
									<ChatToggle
										activity={chatActivity}
										className="chat-header-control -ml-[5px] -mr-[5px]"
										controls={ids.pane.chat}
										onToggle={dismissChat}
										open
										swapOnHover
									/>
									<h2
										className="text-[14px] font-medium text-text-tertiary"
										id={ids.heading.chat}
										tabIndex={-1}
									>
										Chat
									</h2>
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

				{chat && mode === "split" && !presentation.chatVisible
					&& !childPresentation && (
					<div className="absolute right-2.5 top-2.5 z-20">
						<ChatToggle
							activity={chatActivity}
							buttonRef={edgeTab}
							className="rounded-l-none"
							controls={ids.pane.chat}
							onToggle={showDesktopChat}
							open={false}
						/>
					</div>
				)}

				<main
					aria-hidden={!presentation.documentVisible || undefined}
					className={`order-1 relative min-w-0 w-full flex-1 ${
						mode === "split" ? "hairline-l hairline-b" : ""
					}`}
					hidden={!presentation.documentVisible}
					inert={!presentation.documentVisible}
				>
					<div className="relative flex h-full flex-col overflow-hidden">
						{mode === "split" && (
							<div
								className="flex h-[46px] shrink-0 items-center overflow-x-auto overflow-y-hidden px-2.5 hairline-b"
								data-document-toolbar
							>
								{controls}
								{childPresentation && (
									<div className="ml-auto flex shrink-0 items-center">
										{chat && !presentation.chatVisible && (
											<ChatToggle
												activity={chatActivity}
												buttonRef={edgeTab}
												controls={ids.pane.chat}
												onToggle={showDesktopChat}
												open={false}
											/>
										)}
										<button
											aria-label={`Close ${childPresentation.label}`}
											className="btn btn-icon btn-ghost -mr-1 shrink-0"
											data-child-document-close
											onClick={childPresentation.onClose}
											type="button"
										>
											<CloseIcon aria-hidden="true" size={14} />
										</button>
									</div>
								)}
							</div>
						)}
						<div
							className="workspace-document-swap content-swap-stack relative min-h-0 flex-1"
							data-workspace-document-swap
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

			{mode !== "split" && (
				<nav
					aria-label="Workspace view"
					className="workspace-navigation hairline-t grid shrink-0 grid-cols-3 bg-ground p-1"
				>
					{destinations.map(destination => {
						let active = destination === "chat"
							? presentation.chatVisible
							: !presentation.chatVisible && view === destination;
						let label = destinationLabel(
							destination,
							unanswered,
							chatActivity,
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
								{destination === "decisions" && unanswered > 0 && (
									<span
										aria-hidden="true"
										className={`${motionContract("feedback").className} ml-1`}
										data-motion-feedback="count"
									>
										{unanswered}
									</span>
								)}
								{destination === "chat" && chatActivity.busy && (
									<span aria-hidden="true" className="workspace-working-indicator ml-1 shrink-0" />
								)}
								{destination === "chat" && chatActivity.unread > 0 && (
									<span
										aria-hidden="true"
										className={`${motionContract("feedback").className} ml-1`}
										data-motion-feedback="count"
									>
										{chatActivity.unread}
									</span>
								)}
							</button>
						);
					})}
				</nav>
			)}
		</div>
	);
}
