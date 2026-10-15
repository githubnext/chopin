/** Three panes on one ground, with the document as the only raised surface. */

import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";
import { ContentSwapLayer } from "@chopin/editor/content-swap";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { ArrowLeftIcon, ChevronIcon, ExpandIcon, MessageIcon } from "@chopin/icons";
import { usePhone } from "@chopin/editor/pointer";

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
import { BUILD_UNAVAILABLE } from "./decision-view-control";
import { phonePaneScroller, PhoneTabBar, usePhoneTopBar } from "./phone-workspace";
import { DocumentTitleBar } from "./document-title-bar";
import { destinationLabel, WorkspaceViewNavigation } from "./workspace-navigation";

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
	// A phone keeps one destination at a time even when landscape gives it a wide window.
	let phone = usePhone();
	return {
		available,
		frame,
		mode: phone ? "compact" as const : workspaceSizing(available, 500).mode,
		phone,
	};
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
	/** Ground-level header for compact and phone layouts; split puts `title` on the sheet instead. */
	header: ReactNode;
	/** The document's own title, path and actions, at the start of the sheet's title bar. */
	title?: ReactNode;
	available?: number;
	frame?: RefObject<HTMLDivElement | null>;
	chat?: ReactNode;
	plan: ReactNode;
	decisions: ReactNode;
	build?: ReactNode;
	buildEnabled?: boolean;
	/** The build's status glyph, shown on the compact Build destination. */
	buildGlyph?: ReactNode;
	/** The header's build capsule is hovered. */
	buildHot?: boolean;
	onBuildHover?: (on: boolean) => void;
	/** Why Build cannot open yet; defaults to the general reason. */
	buildUnavailable?: string;
	/** A brief phone note above the tab bar, such as why Build cannot open yet. */
	phoneHint?: string;
	/** A phone tapped Build while it cannot open. */
	onBuildUnavailable?: () => void;
	controls: ReactNode;
	/** Connection and document status, right-aligned in the document title bar. */
	status?: ReactNode;
	/** People present in the room, at the end of the document title bar. */
	presence?: ReactNode;
	ids: WorkspaceIds;
	mode: WorkspaceMode;
	state: WorkspaceState;
	view: WorkspaceDocumentView;
	onChatOpen: (open: boolean) => void;
	onDesktopChatOpen: (open: boolean) => void;
	onDestination: (destination: WorkspaceDocumentView) => void;
	/** Phone class: bottom tabs, a collapsing top bar, and full-bleed panes. */
	phone?: boolean;
	/** Extension point for a circular control at the end of the phone tab bar. */
	phoneAction?: ReactNode;
	/** Replaces the phone tabs while set, such as formatting while editing. */
	phoneToolbar?: ReactNode;
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
				className={`${feedback} relative grid size-(--icon-size-default)`}
				data-motion-feedback="icon"
				key={expanded ? "restore" : "expand"}
			>
				{expanded ? <MessageIcon size={14} /> : <ExpandIcon size={14} />}
				{expanded && status && (
					<span
						aria-hidden="true"
						className={`activity-dot activity-badge ${unread ? feedback : ""}`}
						data-motion-feedback={unread ? "count" : undefined}
					/>
				)}
			</span>
			{expanded && <span>Chat</span>}
		</button>
	);
}

export function Workspace(
	{
		available = 950,
		build,
		buildEnabled = true,
		buildGlyph,
		buildHot,
		buildUnavailable = BUILD_UNAVAILABLE,
		onBuildUnavailable,
		phoneHint,
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
		onBuildHover,
		onChatOpen,
		onDesktopChatOpen,
		onDestination,
		phone = false,
		phoneAction,
		phoneToolbar,
		plan,
		presence,
		presentation: workspacePresentation,
		state,
		status,
		title,
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
	let nested = workspacePresentation.type === "parent-with-child"
		? workspacePresentation
		: undefined;
	let lift = nested?.motion === "lift" && mode === "split";
	let childClosing = nested?.childState === "closing";
	let liftCovered = lift && !childClosing;
	// Split Zoom puts the child at the end of the title bar's path and folds the views away, since
	// a child has none. Compact has no title bar, so it keeps the stack bar, on every view, so a
	// child left open under Decisions or Build is still in sight and one click away. A phone's top
	// bar becomes the child's, with Back, so it needs no stack bar.
	let zoom = !!nested && !lift;
	let stackBar = zoom && mode !== "split" && !phone;
	let planCovered = zoom && view === "plan";
	let viewsFolded = zoom && mode === "split" && view === "plan" && !childClosing;
	// Phones crossfade rather than cut under reduced motion, so only keyboard input is immediate.
	let immediately = phone ? motionImmediately(undefined, false) : motionImmediately();
	let contentSwapMotion = phone ? motionContract("tab-slide") : motionContract("content-swap");
	let previousMode = useRef(mode);
	let modeChanged = previousMode.current !== mode;
	// Split Chat slides for its shortcut as for a click; compact panes still swap at once by keyboard,
	// and a layout change settles Chat where it lands.
	let chatPresence = useTransitionPresence(
		presentation.chatVisible ? true : undefined,
		phone ? contentSwapMotion.closeDuration : 220,
		modeChanged || (mode !== "split" && immediately),
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
	let topBar = usePhoneTopBar(root, phone, destination);
	let selectPhoneTab = (next: WorkspaceDestination, current: boolean, source: HTMLElement) => {
		if (!current) return navigate(next, source);
		let pane = root.current?.querySelector(
			next === "chat" ? `#${CSS.escape(ids.pane.chat)}` : `[data-document-view="${next}"]`,
		);
		let scroller = phonePaneScroller(pane);
		// Chat returns to its newest message; every other pane returns to its top.
		scroller?.scrollTo({
			behavior: motionImmediately() ? "auto" : "smooth",
			top: next === "chat" ? scroller.scrollHeight : 0,
		});
	};

	let chatShortcutEnabled = !!chat;
	useEffect(() => {
		if (!chatShortcutEnabled) return;
		return listenForShortcuts(() => ({ "toggle-chat": () => toggleChat.current() }));
	}, [chatShortcutEnabled]);

	return (
		<div
			className="workspace-root flex h-full flex-col overflow-hidden bg-ground"
			data-document-expanded={presentation.documentExpanded || undefined}
			data-workspace-bar={topBar.hidden ? "hidden" : undefined}
			data-workspace-mode={mode}
			data-workspace-phone={phone || undefined}
			data-workspace-room={identity}
			data-workspace-surface={profile.surface}
			data-workspace-title={topBar.titleHidden ? "hidden" : undefined}
			data-workspace-travel={travel.back ? "back" : undefined}
			ref={root}
			style={mode === "split" ? { "--chat-width": `${chatWidth}px` } as CSSProperties : undefined}
		>
			{/* Split has no ground header: the title lives on the sheet, so expanding never hides it. */}
			{phone
				? header
				: mode !== "split" && <div className="workspace-header-slot shrink-0">{header}</div>}

			{mode !== "split" && !phone && (
				<WorkspaceViewNavigation
					buildEnabled={buildEnabled}
					buildGlyph={buildGlyph}
					buildHot={buildHot}
					buildReason={buildReason}
					buildUnavailable={buildUnavailable}
					chatActivity={chatActivity}
					chatVisible={presentation.chatVisible}
					destinations={destinations}
					documentActivity={documentActivity}
					implementation={profile.implementation}
					onBuildHover={onBuildHover}
					onNavigate={navigate}
					unanswered={unanswered}
					view={view}
				/>
			)}

			<div
				ref={frame}
				className={`workspace-frame relative flex min-h-0 flex-1 ${
					phone
						? "overflow-hidden bg-page"
						: mode === "split"
						? "mx-3 mb-3"
						: "m-2 overflow-hidden rounded-panel bg-page shadow-resting ring-hairline"
				}`}
			>
				<div
					className="workspace-document-stack relative flex min-w-0 flex-1"
					data-child-motion={nested ? (lift ? "lift" : "zoom") : undefined}
					hidden={documentPresence.phase === "closed"}
				>
					<main
						aria-hidden={!presentation.documentVisible || undefined}
						className="workspace-document-panel relative min-w-0 w-full flex-1"
						data-child-covered={liftCovered || undefined}
						data-child-stack={stackBar || undefined}
						inert={!presentation.documentVisible}
						onClickCapture={liftCovered
							? event => {
								// The surface toggle and presence keep their own jobs under a Lift child.
								let target = event.target instanceof Element ? event.target : undefined;
								if (
									target?.closest(".workspace-surface-toggle-slot, [data-toolbar-trailing]")
								) return;
								nested!.onChildClose();
							}
							: undefined}
					>
						<div className="relative flex h-full flex-col overflow-hidden">
							{mode === "split" && (
								<DocumentTitleBar
									controls={controls}
									cover={lift && (
										// The covered title bar is one control: a click anywhere on it returns through
										// `<main>`'s capture handler, so this button needs no handler of its own. It
										// stays mounted and focusable while closing so focus never falls to the body
										// before it returns to the opener; `inert` would blur it just the same.
										<button
											aria-disabled={childClosing || undefined}
											aria-label={`Back to ${nested!.path[0]!.label}`}
											className="workspace-tab-row-return"
											tabIndex={childClosing ? -1 : undefined}
											type="button"
										/>
									)}
									presence={presence}
									status={status}
									title={
										<>
											{zoom && (
												// A pointer target only: the root crumb beside it is the one Back control for
												// the keyboard and assistive technology.
												<button
													aria-hidden="true"
													className="document-title-back btn btn-icon btn-ghost shrink-0"
													data-tooltip={`Back to ${nested!.path.at(-2)!.label}`}
													onClick={nested!.onChildClose}
													tabIndex={-1}
													type="button"
												>
													<ArrowLeftIcon aria-hidden="true" size={14} />
												</button>
											)}
											{title}
										</>
									}
									titleInert={liftCovered}
									toggle={chat && (
										<SurfaceToggle
											activity={chatActivity}
											buttonRef={edgeTab}
											controls={ids.pane.chat}
											expanded={presentation.documentExpanded}
											onToggle={presentation.documentExpanded ? showDesktopChat : dismissChat}
										/>
									)}
									viewsFolded={viewsFolded}
									viewsInert={liftCovered}
								/>
							)}
							{stackBar && (
								<nav
									aria-label="Document stack"
									className="workspace-stack-bar hairline-b flex shrink-0 items-center gap-1"
									data-closing={childClosing || undefined}
									inert={childClosing || undefined}
								>
									<button
										aria-label={`Back to ${nested!.path.at(-2)!.label}`}
										className="btn btn-icon btn-ghost"
										onClick={nested!.onChildClose}
										type="button"
									>
										<ArrowLeftIcon aria-hidden="true" size={14} />
									</button>
									<ol className="workspace-stack-path flex min-w-0 items-center gap-1 text-xs">
										{nested!.path.map((entry, index) => (
											<li className="flex min-w-0 items-center gap-1" key={entry.id}>
												{index > 0 && <ChevronIcon aria-hidden="true" size={12} />}
												{index === nested!.path.length - 1
													? view === "plan"
														? <span aria-current="page">{entry.label}</span>
														: (
															<button
																aria-current="page"
																className="btn btn-compact btn-ghost min-w-0"
																onClick={() => {
																	onDestination("plan");
																	requestAnimationFrame(() => {
																		root.current?.querySelector<HTMLElement>(
																			".anchored-child-card:last-of-type",
																		)?.focus({ preventScroll: true });
																	});
																}}
																type="button"
															>
																<span className="truncate">{entry.label}</span>
															</button>
														)
													: (
														<button
															className="btn btn-compact btn-ghost min-w-0"
															onClick={nested!.onChildClose}
															type="button"
														>
															<span className="truncate">{entry.label}</span>
														</button>
													)}
											</li>
										))}
									</ol>
								</nav>
							)}
							{mode !== "split" && status && (
								<div className="workspace-status-row" inert={planCovered || undefined}>
									{status}
								</div>
							)}
							<div
								className="workspace-document-swap content-swap-stack relative min-h-0 flex-1"
								data-workspace-document-swap
								inert={liftCovered || undefined}
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
										data-child-recede={(planCovered && !childClosing) || undefined}
										data-document-view="plan"
										inert={planCovered || undefined}
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
						{/* Always mounted, so the dim can transition in behind a newly opened child. */}
						{mode === "split" && <div aria-hidden="true" className="workspace-child-scrim" />}
					</main>
					{nested && (
						<div className="workspace-child-slot" hidden={!lift && view !== "plan"}>
							{nested.child}
						</div>
					)}
				</div>
				{/* `hidden` preserves pane state and subscriptions after its closing transition. */}
				{chat && (
					<aside
						aria-hidden={chatInactive || undefined}
						aria-labelledby={ids.heading.chat}
						className={`workspace-chat-panel ${
							phone ? "motion-tab-slide" : "motion-panel"
						} ${chatPresence.className} relative flex min-w-0 flex-col overflow-hidden ${
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
			{phone && profile.implementation && !buildEnabled && (
				<span className="sr-only" id={buildReason}>{buildUnavailable}</span>
			)}
			{phone && (
				<PhoneTabBar
					action={phoneAction}
					active={destination}
					buildReason={buildEnabled ? undefined : buildReason}
					hint={phoneHint}
					onUnavailable={onBuildUnavailable}
					chatActivity={chatActivity}
					destinations={destinations}
					documentActivity={documentActivity}
					labels={{
						build: destinationLabel("build", unanswered, chatActivity, documentActivity),
						chat: destinationLabel("chat", unanswered, chatActivity, documentActivity),
						decisions: destinationLabel("decisions", unanswered, chatActivity, documentActivity),
						plan: destinationLabel(
							"plan",
							unanswered,
							chatActivity,
							destination === "plan" ? undefined : documentActivity,
						),
					}}
					minimised={topBar.hidden}
					onRestore={topBar.show}
					onSelect={selectPhoneTab}
					toolbar={phoneToolbar}
					unanswered={unanswered}
				/>
			)}
		</div>
	);
}
