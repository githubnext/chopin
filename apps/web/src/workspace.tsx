/** Three panes on one ground, with the document as the only raised surface. */

import { useEffect, useId, useLayoutEffect, useReducer, useRef, useSyncExternalStore } from "react";
import { ContentSwapLayer } from "@chopin/editor/content-swap";
import { useTransitionPresence } from "@chopin/editor/transition-presence";

import {
	initialWorkspaceState,
	presentWorkspace,
	transitionWorkspace,
	WORKSPACE_MEDIA,
	workspaceMode,
} from "./workspace-model";
import conversationCloseIcon from "./assets/icons/conversation-close.svg";
import conversationIcon from "./assets/icons/conversation.svg";
import { ResizeHandle, usePaneWidth } from "./resizable-pane";
import { motionContract } from "./motion-contract";
import { motionImmediately } from "./motion-input";

import type { Dispatch, ReactNode, RefObject } from "react";
import type {
	WorkspaceDestination,
	WorkspaceEvent,
	WorkspaceMode,
	WorkspaceState,
	WorkspaceSurface,
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
			plan: `${instance}-workspace-plan-heading`,
			decisions: `${instance}-workspace-decisions-heading`,
			"background-work": `${instance}-workspace-background-work-heading`,
			conversation: `${instance}-workspace-conversation-heading`,
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

/** Only the desktop Conversation preference crosses a page load. */
export function useWorkspaceState(
	surface: WorkspaceSurface = "document",
): [WorkspaceState, Dispatch<WorkspaceEvent>] {
	let [state, dispatch] = useReducer(
		transitionWorkspace,
		undefined,
		() =>
			initialWorkspaceState(
				surface,
				localStorage.getItem("chopin:pane:chat:open") !== "false",
			),
	);

	useEffect(() => {
		if (surface === "child") return;
		localStorage.setItem(
			"chopin:pane:chat:open",
			String(state.desktopConversationOpen),
		);
	}, [state.desktopConversationOpen, surface]);

	return [state, dispatch];
}

export type WorkspaceProps = {
	header: ReactNode;
	chat?: ReactNode;
	plan: ReactNode;
	decisions: ReactNode;
	backgroundWork?: ReactNode;
	controls: ReactNode;
	ids: WorkspaceIds;
	mode: WorkspaceMode;
	state: WorkspaceState;
	view: "plan" | "decisions" | "background-work";
	onConversationOpen: (open: boolean) => void;
	onDesktopConversationOpen: (open: boolean) => void;
	onDestination: (destination: "plan" | "decisions" | "background-work") => void;
	unanswered: number;
	conversationActivity: { unread: number; busy: boolean };
	backgroundActivity?: { active: number; paused: number; failed: number };
	identity?: string;
	surface?: WorkspaceSurface;
};

export function ConversationToggle(
	{
		activity,
		buttonRef,
		className,
		controls,
		onToggle,
		open,
		swapOnHover = false,
	}: {
		activity: WorkspaceProps["conversationActivity"];
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
			aria-label={`${open ? "Hide" : "Show"} conversation pane${status ? `, ${status}` : ""}`}
			className={`conversation-toggle btn btn-icon btn-ghost relative shrink-0 ${className ?? ""}`}
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
							className="conversation-toggle-icon conversation-toggle-icon-default col-start-1 row-start-1 size-[14px]"
							src={conversationIcon}
						/>
						<img
							alt=""
							className="conversation-toggle-icon conversation-toggle-icon-close col-start-1 row-start-1 size-[14px]"
							src={conversationCloseIcon}
						/>
					</span>
				)
				: (
					<img
						alt=""
						className={`${feedback} size-[14px] ${open ? "opacity-50" : ""}`}
						data-motion-feedback="icon"
						key={open ? "open" : "closed"}
						src={open ? conversationCloseIcon : conversationIcon}
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
	activity: WorkspaceProps["conversationActivity"],
	background: NonNullable<WorkspaceProps["backgroundActivity"]>,
): string {
	if (destination === "decisions" && unanswered > 0) {
		return `Decisions, ${unanswered} unanswered`;
	}
	if (
		destination === "background-work"
		&& (background.active > 0 || background.paused > 0 || background.failed > 0)
	) {
		return `Background Work, ${background.active} active, ${background.paused} waiting, ${background.failed} failed`;
	}
	if (destination === "conversation" && activity.busy && activity.unread > 0) {
		return `Conversation, Planner working, ${activity.unread} unread`;
	}
	if (destination === "conversation" && activity.busy) return "Conversation, Planner working";
	if (destination === "conversation" && activity.unread > 0) {
		return `Conversation, ${activity.unread} unread`;
	}
	return destination === "conversation" ? "Conversation" : destination === "background-work"
		? "Background Work"
		: destination === "decisions"
		? "Decisions"
		: "Document";
}

export function Workspace(
	{
		backgroundActivity = { active: 0, paused: 0, failed: 0 },
		backgroundWork,
		chat,
		controls,
		ids,
		conversationActivity,
		decisions,
		header,
		identity,
		mode,
		onConversationOpen,
		onDesktopConversationOpen,
		onDestination,
		plan,
		state,
		surface = "document",
		unanswered,
		view,
	}: WorkspaceProps,
) {
	let [chatWidth, resizeChat] = usePaneWidth({ active: mode === "split", ...CHAT_PANE });
	let root = useRef<HTMLDivElement>(null);
	let presentation = presentWorkspace(state, mode, view);
	let immediately = motionImmediately();
	let contentSwapMotion = motionContract("content-swap");
	let conversationPresence = useTransitionPresence(
		presentation.conversationVisible ? true : undefined,
		220,
		immediately,
	);
	let opener = useRef<HTMLElement | undefined>(undefined);
	let edgeTab = useRef<HTMLButtonElement>(null);
	let previousConversationOpen = useRef(state.conversationOpen);
	let conversationInactive = !presentation.conversationVisible;
	let destinations: WorkspaceDestination[] = backgroundWork
		? ["conversation", "plan", "decisions", "background-work"]
		: ["conversation", "plan", "decisions"];
	let focusDestination = (destination: WorkspaceDestination) => {
		root.current?.querySelector<HTMLElement>(`#${CSS.escape(ids.heading[destination])}`)
			?.focus({ preventScroll: true });
	};

	useLayoutEffect(() => {
		if (!previousConversationOpen.current && state.conversationOpen) {
			let active = document.activeElement;
			if (active instanceof HTMLElement) opener.current = active;
			if (mode !== "split") {
				focusDestination("conversation");
			}
		}
		previousConversationOpen.current = state.conversationOpen;
	}, [mode, state.conversationOpen]);

	let navigate = (destination: WorkspaceDestination, source?: HTMLElement) => {
		if (destination === "conversation" && source) opener.current = source;
		if (destination === "conversation") onConversationOpen(true);
		else onDestination(destination);
		requestAnimationFrame(() => {
			focusDestination(destination);
		});
	};

	let dismissConversation = () => {
		if (mode === "split") {
			onDesktopConversationOpen(false);
			requestAnimationFrame(() => edgeTab.current?.focus({ preventScroll: true }));
		} else {
			onConversationOpen(false);
			requestAnimationFrame(() => opener.current?.focus({ preventScroll: true }));
		}
	};

	let showDesktopConversation = () => {
		onDesktopConversationOpen(true);
		requestAnimationFrame(() => {
			focusDestination("conversation");
		});
	};

	return (
		<div
			className="workspace-root flex h-full flex-col overflow-hidden bg-ground"
			data-workspace-mode={mode}
			data-workspace-room={identity}
			data-workspace-surface={surface}
			ref={root}
		>
			{header}

			<div
				className={`workspace-frame relative flex min-h-0 flex-1 ${
					mode === "split"
						? "mx-3 mb-3 overflow-hidden rounded-[12px] bg-page shadow-raised ring-hairline"
						: "pb-2"
				}`}
			>
				{/* `hidden` preserves pane state and subscriptions after its closing transition. */}
				{chat && (
					<aside
						aria-hidden={conversationInactive || undefined}
						aria-labelledby={ids.heading.conversation}
						className={`workspace-conversation-panel motion-panel ${conversationPresence.className} order-2 relative flex min-w-0 flex-col overflow-hidden bg-conversation-pane ${
							mode === "split" ? "hairline-l hairline-r hairline-b" : ""
						}`}
						hidden={conversationPresence.phase === "closed"}
						id={ids.pane.chat}
						inert={conversationInactive}
						onKeyDown={event => {
							if (event.key === "Escape" && mode !== "split") {
								event.preventDefault();
								event.stopPropagation();
								dismissConversation();
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
											label="Resize the conversation"
											max={CHAT_PANE.max}
											min={CHAT_PANE.min}
											onResize={resizeChat}
											side="left"
											width={chatWidth}
										/>
									)}
									<ConversationToggle
										activity={conversationActivity}
										className="conversation-header-control -ml-[5px] -mr-[5px]"
										controls={ids.pane.chat}
										onToggle={dismissConversation}
										open
										swapOnHover
									/>
									<h2
										className="text-[14px] font-medium text-text-tertiary"
										id={ids.heading.conversation}
										tabIndex={-1}
									>
										Conversation
									</h2>
								</div>
							)
							: (
								<h2 className="sr-only" id={ids.heading.conversation} tabIndex={-1}>
									Conversation
								</h2>
							)}
						<div className="min-h-0 flex-1">
							{chat}
						</div>
					</aside>
				)}

				{chat && mode === "split" && !presentation.conversationVisible && (
					<div className="absolute right-2.5 top-2.5 z-20">
						<ConversationToggle
							activity={conversationActivity}
							buttonRef={edgeTab}
							className="rounded-l-none"
							controls={ids.pane.chat}
							onToggle={showDesktopConversation}
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
							{backgroundWork && (
								<ContentSwapLayer
									active={presentation.documentVisible
										&& presentation.documentView === "background-work"}
									className="workspace-document-layer min-h-0"
									immediately={immediately}
									motion={contentSwapMotion}
								>
									<section
										aria-labelledby={ids.heading["background-work"]}
										className="h-full min-h-0 overflow-auto"
										data-document-view="background-work"
									>
										{backgroundWork}
									</section>
								</ContentSwapLayer>
							)}
						</div>
					</div>
				</main>
			</div>

			{mode !== "split" && (
				<nav
					aria-label="Workspace view"
					className={`workspace-navigation hairline-t grid shrink-0 bg-ground p-1 ${
						backgroundWork ? "grid-cols-4" : "grid-cols-3"
					}`}
				>
					{destinations.map(destination => {
						let active = destination === "conversation"
							? presentation.conversationVisible
							: !presentation.conversationVisible && view === destination;
						let label = destinationLabel(
							destination,
							unanswered,
							conversationActivity,
							backgroundActivity,
						);
						return (
							<button
								aria-current={active ? "page" : undefined}
								aria-label={label}
								aria-pressed={active}
								className="btn btn-ghost min-h-11 min-w-0"
								key={destination}
								onClick={event => navigate(destination, event.currentTarget)}
								type="button"
							>
								{destination === "conversation"
									? "Conversation"
									: destination === "background-work"
									? "Background"
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
								{destination === "background-work"
									&& backgroundActivity.active + backgroundActivity.paused
												+ backgroundActivity.failed > 0
									&& (
										<span aria-hidden="true" className="ml-1">
											{backgroundActivity.active + backgroundActivity.paused
												+ backgroundActivity.failed}
										</span>
									)}
								{destination === "conversation" && conversationActivity.busy && (
									<span aria-hidden="true" className="workspace-working-indicator ml-1 shrink-0" />
								)}
								{destination === "conversation" && conversationActivity.unread > 0 && (
									<span
										aria-hidden="true"
										className={`${motionContract("feedback").className} ml-1`}
										data-motion-feedback="count"
									>
										{conversationActivity.unread}
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
