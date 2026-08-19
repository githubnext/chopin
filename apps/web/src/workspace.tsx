/** Three panes on one ground, with the document as the only raised surface. */

import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";

import {
	presentWorkspace,
	transitionWorkspace,
	WORKSPACE_MEDIA,
	workspaceMode,
} from "./workspace-model";

import type { Dispatch, ReactNode } from "react";
import type {
	WorkspaceDestination,
	WorkspaceEvent,
	WorkspaceMode,
	WorkspaceState,
} from "./workspace-model";

const MIN = 240;
const MAX = 400;

/** How far one arrow key moves an edge, and how far one with Shift held moves it. */
const STEP = 16;
const LEAP = 64;

type Side = "left" | "right";

function clamp(value: number): number {
	return Math.min(MAX, Math.max(MIN, value));
}

/** Accessible resize handle; pointer capture keeps drags active off the boundary. */
function Handle(
	{ label, onResize, side, width }: {
		label: string;
		onResize: (delta: number) => void;
		side: Side;
		width: number;
	},
) {
	let origin = useRef<number>(0);
	let [dragging, setDragging] = useState(false);

	return (
		<div
			aria-label={label}
			aria-orientation="vertical"
			aria-valuemax={MAX}
			aria-valuemin={MIN}
			aria-valuenow={width}
			className={`absolute inset-y-0 z-10 w-1 cursor-col-resize
				before:absolute before:inset-y-0 before:-inset-x-1 before:content-['']
				after:absolute after:inset-x-px after:inset-y-0 after:rounded-full after:bg-brand
				after:opacity-0 after:transition-opacity hover:after:opacity-100
				data-dragging:after:opacity-100 ${side === "left" ? "left-0" : "right-0"}`}
			data-dragging={dragging || undefined}
			onKeyDown={event => {
				let step = event.shiftKey ? LEAP : STEP;
				// A rail on the right grows leftward, so the key names a direction
				// on the screen rather than a direction in the layout.
				let toward = side === "left" ? 1 : -1;

				if (event.key === "ArrowRight") onResize(step * toward);
				else if (event.key === "ArrowLeft") onResize(-step * toward);
				else if (event.key === "Home") onResize(MIN - width);
				else if (event.key === "End") onResize(MAX - width);
				else return;

				event.preventDefault();
			}}
			onPointerDown={event => {
				origin.current = event.clientX;
				setDragging(true);
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={event => {
				if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
				let delta = event.clientX - origin.current;
				origin.current = event.clientX;
				onResize(side === "left" ? delta : -delta);
			}}
			// Lost capture covers ordinary release and every form of pointer cancellation.
			onLostPointerCapture={() => setDragging(false)}
			role="separator"
			tabIndex={0}
		/>
	);
}

function usePaneWidth(key: string, initial: number, active: boolean) {
	let [width, setWidth] = useState(initial);
	let loaded = useRef(false);

	useEffect(() => {
		if (!active) return;
		if (!loaded.current) {
			loaded.current = true;
			let stored = Number(localStorage.getItem(key));
			let restored = Number.isFinite(stored) && stored > 0 ? clamp(stored) : initial;
			if (restored !== width) {
				setWidth(restored);
				return;
			}
		}
		localStorage.setItem(key, String(width));
	}, [active, initial, key, width]);

	let resize = useCallback((delta: number) => setWidth(current => clamp(current + delta)), []);
	return [width, resize] as const;
}

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
	onDestination: (destination: "plan" | "decisions") => void;
	unanswered: number;
	conversationActivity: { unread: number; busy: boolean };
};

const HEADING: Record<WorkspaceDestination, string> = {
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
		: "Plan";
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
		onDestination,
		plan,
		state,
		unanswered,
		view,
	}: WorkspaceProps,
) {
	let [chatWidth, resizeChat] = usePaneWidth("chopin:pane:chat", 280, mode === "split");
	let presentation = presentWorkspace(state, mode, view);
	let opener = useRef<HTMLElement | undefined>(undefined);
	let previousConversationOpen = useRef(state.conversationOpen);
	let conversationHidden = !presentation.conversationVisible;
	let planHidden = !presentation.documentVisible || presentation.documentView !== "plan";
	let decisionsHidden = !presentation.documentVisible
		|| presentation.documentView !== "decisions";
	let destinations: WorkspaceDestination[] = ["conversation", "plan", "decisions"];

	useEffect(() => {
		if (!previousConversationOpen.current && state.conversationOpen) {
			let active = document.activeElement;
			if (active instanceof HTMLElement) opener.current = active;
			if (mode !== "split") {
				requestAnimationFrame(() => {
					document.getElementById(HEADING.conversation)?.focus({ preventScroll: true });
				});
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
		onConversationOpen(false);
		requestAnimationFrame(() => opener.current?.focus({ preventScroll: true }));
	};

	return (
		<div className="flex h-full flex-col overflow-hidden bg-ground">
			{header}

			<div
				className={`relative flex min-h-0 flex-1 pt-4 ${mode === "split" ? "" : "pb-2"}`}
			>
				{/* `hidden` preserves pane state and subscriptions while removing it from layout. */}
				{chat && (
					<aside
						aria-hidden={conversationHidden || undefined}
						aria-labelledby={HEADING.conversation}
						className="min-w-0 overflow-hidden"
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
						<h2 className="sr-only" id={HEADING.conversation} tabIndex={-1}>Conversation</h2>
						<div className="h-full min-h-0">
							{chat}
						</div>
					</aside>
				)}

				<main
					aria-hidden={!presentation.documentVisible || undefined}
					className="relative min-w-0 w-full flex-1 px-1"
					hidden={!presentation.documentVisible}
					inert={!presentation.documentVisible}
				>
					{/* Decoration extends below the viewport without moving the editor contents. */}
					<div
						aria-hidden="true"
						className={`pointer-events-none absolute inset-x-1 top-0 rounded-t-xl bg-page shadow-raised ring-hairline ${
							mode === "split" ? "-bottom-3" : "bottom-0"
						}`}
					/>

					{/* Lexical consumes Tab, so the resize handle precedes the editor. */}
					{chat && presentation.separatorVisible && (
						<Handle
							label="Resize the conversation"
							onResize={resizeChat}
							side="left"
							width={chatWidth}
						/>
					)}
					<div className="relative flex h-full flex-col overflow-hidden rounded-t-xl">
						{mode === "split" && (
							<div
								className="grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center px-3 hairline-b"
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
							<h2 className="sr-only" id={HEADING.plan} tabIndex={-1}>Plan</h2>
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
							<h2 className="sr-only" id={HEADING.decisions} tabIndex={-1}>Decisions</h2>
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
									: "Plan"}
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
