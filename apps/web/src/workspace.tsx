/** Three panes on one ground, with the document as the only raised surface. */

import { useEffect, useLayoutEffect, useReducer, useRef, useSyncExternalStore } from "react";
import { SidebarSimpleIcon } from "@phosphor-icons/react";

import {
	presentWorkspace,
	transitionWorkspace,
	WORKSPACE_MEDIA,
	workspaceMode,
} from "./workspace-model";
import conversationIcon from "./assets/figma/workspace/conversation.svg";
import { ResizeHandle, usePaneWidth } from "./resizable-pane";

import type { Dispatch, ReactNode, RefObject } from "react";
import type {
	WorkspaceDestination,
	WorkspaceEvent,
	WorkspaceMode,
	WorkspaceState,
} from "./workspace-model";

export type Pane = "chat";

export function paneId(pane: Pane): string {
	return `pane-${pane}`;
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
export function useWorkspaceState(): [WorkspaceState, Dispatch<WorkspaceEvent>] {
	let [state, dispatch] = useReducer(transitionWorkspace, undefined, (): WorkspaceState => ({
		conversationOpen: false,
		desktopConversationOpen: localStorage.getItem("chopin:pane:chat:open") !== "false",
	}));

	useEffect(() => {
		localStorage.setItem(
			"chopin:pane:chat:open",
			String(state.desktopConversationOpen),
		);
	}, [state.desktopConversationOpen]);

	return [state, dispatch];
}

export type WorkspaceProps = {
	header: ReactNode;
	chat?: ReactNode;
	plan: ReactNode;
	decisions: ReactNode;
	controls: ReactNode;
	mode: WorkspaceMode;
	state: WorkspaceState;
	view: "plan" | "decisions";
	onConversationOpen: (open: boolean) => void;
	onDesktopConversationOpen: (open: boolean) => void;
	onDestination: (destination: "plan" | "decisions") => void;
	unanswered: number;
	conversationActivity: { unread: number; busy: boolean };
};

function ConversationToggle(
	{
		activity,
		buttonRef,
		className,
		onToggle,
		open,
	}: {
		activity: WorkspaceProps["conversationActivity"];
		buttonRef?: RefObject<HTMLButtonElement | null>;
		className?: string;
		onToggle: () => void;
		open: boolean;
	},
) {
	let status = activity.busy
		? "Planner working"
		: activity.unread > 0
		? `${activity.unread} unread`
		: undefined;
	return (
		<button
			aria-controls={paneId("chat")}
			aria-expanded={open}
			aria-label={`${open ? "Hide" : "Show"} conversation pane${status ? `, ${status}` : ""}`}
			className={`btn btn-icon btn-ghost relative shrink-0 ${className ?? ""}`}
			data-activity={activity.busy ? "busy" : activity.unread > 0 ? "unread" : undefined}
			onClick={onToggle}
			ref={buttonRef}
			type="button"
		>
			{open
				? <SidebarSimpleIcon aria-hidden="true" size={18} />
				: <img alt="" className="size-[18px]" src={conversationIcon} />}
			{status && (
				<span
					aria-hidden="true"
					className="absolute right-1 top-1 size-1.5 rounded-full bg-brand"
				/>
			)}
		</button>
	);
}

export const HEADING: Record<WorkspaceDestination, string> = {
	plan: "workspace-plan-heading",
	decisions: "workspace-decisions-heading",
	conversation: "workspace-conversation-heading",
};

function destinationLabel(
	destination: WorkspaceDestination,
	unanswered: number,
	activity: WorkspaceProps["conversationActivity"],
): string {
	if (destination === "decisions" && unanswered > 0) {
		return `Decisions, ${unanswered} unanswered`;
	}
	if (destination === "conversation" && activity.busy && activity.unread > 0) {
		return `Conversation, Planner working, ${activity.unread} unread`;
	}
	if (destination === "conversation" && activity.busy) return "Conversation, Planner working";
	if (destination === "conversation" && activity.unread > 0) {
		return `Conversation, ${activity.unread} unread`;
	}
	return destination === "conversation" ? "Conversation" : destination === "decisions"
		? "Decisions"
		: "Document";
}

export function Workspace(
	{
		chat,
		controls,
		conversationActivity,
		decisions,
		header,
		mode,
		onConversationOpen,
		onDesktopConversationOpen,
		onDestination,
		plan,
		state,
		unanswered,
		view,
	}: WorkspaceProps,
) {
	let [chatWidth, resizeChat] = usePaneWidth({
		active: mode === "split",
		initial: 304,
		max: 400,
		min: 304,
		storageKey: "chopin:pane:chat",
	});
	let presentation = presentWorkspace(state, mode, view);
	let opener = useRef<HTMLElement | undefined>(undefined);
	let edgeTab = useRef<HTMLButtonElement>(null);
	let previousConversationOpen = useRef(state.conversationOpen);
	let conversationHidden = !presentation.conversationVisible;
	let planHidden = !presentation.documentVisible || presentation.documentView !== "plan";
	let decisionsHidden = !presentation.documentVisible
		|| presentation.documentView !== "decisions";
	let destinations: WorkspaceDestination[] = ["conversation", "plan", "decisions"];

	useLayoutEffect(() => {
		if (!previousConversationOpen.current && state.conversationOpen) {
			let active = document.activeElement;
			if (active instanceof HTMLElement) opener.current = active;
			if (mode !== "split") {
				document.getElementById(HEADING.conversation)?.focus({ preventScroll: true });
			}
		}
		previousConversationOpen.current = state.conversationOpen;
	}, [mode, state.conversationOpen]);

	let navigate = (destination: WorkspaceDestination, source?: HTMLElement) => {
		if (destination === "conversation" && source) opener.current = source;
		if (destination === "conversation") onConversationOpen(true);
		else onDestination(destination);
		requestAnimationFrame(() => {
			document.getElementById(HEADING[destination])?.focus({ preventScroll: true });
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
			document.getElementById(HEADING.conversation)?.focus({ preventScroll: true });
		});
	};

	return (
		<div className="flex h-full flex-col overflow-hidden bg-ground">
			{header}

			<div className={`relative flex min-h-0 flex-1 ${mode === "split" ? "" : "pb-2"}`}>
				{/* `hidden` preserves pane state and subscriptions while removing it from layout. */}
				{chat && (
					<aside
						aria-hidden={conversationHidden || undefined}
						aria-labelledby={HEADING.conversation}
						className="order-2 relative flex min-w-0 flex-col overflow-hidden bg-ground"
						hidden={conversationHidden}
						id={paneId("chat")}
						inert={conversationHidden}
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
								<div className="group flex h-[46px] shrink-0 items-center justify-between px-3.5 hairline-b">
									{presentation.separatorVisible && (
										<ResizeHandle
											label="Resize the conversation"
											max={400}
											min={304}
											onResize={resizeChat}
											side="left"
											width={chatWidth}
										/>
									)}
									<h2
										className="text-sm font-medium text-text-tertiary"
										id={HEADING.conversation}
										tabIndex={-1}
									>
										Conversation
									</h2>
									<ConversationToggle
										activity={conversationActivity}
										onToggle={dismissConversation}
										open
									/>
								</div>
							)
							: <h2 className="sr-only" id={HEADING.conversation} tabIndex={-1}>Conversation</h2>}
						<div className="min-h-0 flex-1">
							{chat}
						</div>
					</aside>
				)}

				{chat && mode === "split" && !presentation.conversationVisible && (
					<div className="absolute right-0 top-0 z-20">
						<ConversationToggle
							activity={conversationActivity}
							buttonRef={edgeTab}
							className="rounded-l-none"
							onToggle={showDesktopConversation}
							open={false}
						/>
					</div>
				)}

				<main
					aria-hidden={!presentation.documentVisible || undefined}
					className="order-1 relative min-w-0 w-full flex-1 px-3"
					hidden={!presentation.documentVisible}
					inert={!presentation.documentVisible}
				>
					{/* Decoration extends below the viewport without moving the editor contents. */}
					<div
						aria-hidden="true"
						className={`pointer-events-none absolute inset-x-3 top-0 rounded-t-xl bg-page shadow-raised ring-hairline ${
							mode === "split" ? "-bottom-3" : "bottom-0"
						}`}
					/>

					<div className="relative flex h-full flex-col overflow-hidden rounded-t-xl">
						{mode === "split" && (
							<div
								className="grid h-[46px] shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center px-3 hairline-b"
								data-document-toolbar
							>
								<div className="col-start-2 justify-self-center">{controls}</div>
							</div>
						)}
						<section
							aria-hidden={planHidden || undefined}
							aria-labelledby={HEADING.plan}
							className="min-h-0 flex-1"
							data-document-view="plan"
							hidden={planHidden}
							inert={planHidden}
						>
							<h2 className="sr-only" id={HEADING.plan} tabIndex={-1}>Document</h2>
							{plan}
						</section>
						<section
							aria-hidden={decisionsHidden || undefined}
							aria-labelledby={HEADING.decisions}
							className="min-h-0 flex-1"
							data-document-view="decisions"
							hidden={decisionsHidden}
							inert={decisionsHidden}
						>
							{decisions}
						</section>
					</div>
				</main>
			</div>

			{mode !== "split" && (
				<nav
					aria-label="Workspace view"
					className="workspace-navigation hairline-t grid shrink-0 grid-cols-3 bg-ground p-1"
				>
					{destinations.map(destination => {
						let active = destination === "conversation"
							? presentation.conversationVisible
							: !presentation.conversationVisible && view === destination;
						let label = destinationLabel(destination, unanswered, conversationActivity);
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
								{destination === "conversation" ? "Conversation" : destination === "decisions"
									? "Decisions"
									: "Document"}
								{destination === "decisions" && unanswered > 0 && (
									<span aria-hidden="true" className="ml-1">{unanswered}</span>
								)}
								{destination === "conversation" && conversationActivity.busy && (
									<span aria-hidden="true" className="workspace-working-indicator ml-1 shrink-0" />
								)}
								{destination === "conversation" && conversationActivity.unread > 0 && (
									<span aria-hidden="true" className="ml-1">{conversationActivity.unread}</span>
								)}
							</button>
						);
					})}
				</nav>
			)}
		</div>
	);
}
