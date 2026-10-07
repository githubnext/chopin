import { createPortal } from "react-dom";
import { DecisionIcon, InfoIcon, WarningIcon } from "@chopin/icons";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { analysisForMessage, jobsForMessage, messageLinks } from "./links";
import { changeSentence, messageOutcome } from "./outcome";
import { motionContract } from "../motion-contract";
import { motionImmediately } from "../motion-input";

import type { ConversationPlan } from "@chopin/protocol";
import type { CSSProperties } from "react";
import type { ExcerptCorrectionAction } from "./analysis-action";
import type { AnalysisDetails as Details } from "./analysis-details";
import type { CardLink } from "./links";
import type { Lane, MessageOutcome } from "./outcome";

let analysisOwner: { id: object; close: () => void } | undefined;
let AnalysisDetails: typeof Details | undefined;
let loading: Promise<void> | undefined;
let prefetchScheduled = false;
/** A failed load forgets its promise, so the next open retries the import. */
let loadDetails = () =>
	loading ??= import("./analysis-details").then(module => {
		AnalysisDetails = module.AnalysisDetails;
	}, error => {
		loading = undefined;
		throw error;
	});
let prefetchDetails = () => void loadDetails().catch(() => {});
let prefetchWhenIdle = () => {
	if (prefetchScheduled) return;
	prefetchScheduled = true;
	let idle = (window as { requestIdleCallback?: (callback: () => void) => number })
		.requestIdleCallback;
	if (idle) idle(prefetchDetails);
	else setTimeout(prefetchDetails, 1000);
};

/** What the conversation analysis did with a message, as one quiet line under it. */
function AnalysisResult(
	{ animate, canEdit, messageText, onCard, onRetry, outcome, retried, retrying }: {
		animate: boolean;
		canEdit: boolean;
		messageText: string;
		onCard: (link: CardLink) => void;
		onRetry: (lane: Lane) => void;
		outcome: MessageOutcome;
		retried: readonly Lane[];
		retrying?: Lane;
	},
) {
	let first = outcome.changes[0];
	let more = outcome.changes.length - 1;
	let failed = outcome.failed[0];
	if (!first && !failed) return null;
	let sentence = first ? changeSentence(first, messageText) : undefined;
	let title = "font-medium text-text-secondary underline-offset-2 group-hover:underline";
	let link = "font-medium text-text-secondary underline-offset-2 hover:underline";
	return (
		<div
			className={`${
				animate ? "chat-analysis-result " : ""
			}mt-0.5 flex flex-col gap-0.5 text-xs text-text-tertiary`}
			data-analysis-result
		>
			{first && sentence && (
				<p className="m-0 flex min-w-0 items-start gap-1.5">
					<DecisionIcon aria-hidden="true" className="mt-0.5 shrink-0" size={12} />
					{/* The whole sentence is the button: a button can't wrap as inline text. */}
					<button
						className="group min-w-0 break-words text-left"
						onClick={() => onCard(first.link)}
						type="button"
					>
						{sentence.title === undefined
							? <span className={title}>{sentence.before}</span>
							: (
								<>
									{sentence.before} <span className={title}>{sentence.title}</span>
									{sentence.after && ` ${sentence.after}`}
								</>
							)}
						{more > 0 && ` and ${more} more decision${more === 1 ? "" : "s"}`}
					</button>
				</p>
			)}
			{failed && (
				<p className="m-0 flex min-w-0 items-start gap-1.5" data-analysis-failed>
					<WarningIcon aria-hidden="true" className="mt-0.5 shrink-0 text-warning-icon" size={12} />
					<span className="min-w-0">
						{retried.includes(failed) ? "Still couldn’t" : "Couldn’t"}{" "}
						{failed === "decision" ? "analyse this message" : "check for research"}
						{canEdit && (
							<>
								{" · "}
								<button
									aria-label={failed === "decision" ? "Retry analysis" : "Retry research check"}
									className={`${link} disabled:no-underline disabled:opacity-60`}
									disabled={retrying !== undefined}
									onClick={() => onRetry(failed)}
									type="button"
								>
									{retrying ? "Retrying…" : "Retry"}
								</button>
							</>
						)}
					</span>
				</p>
			)}
		</div>
	);
}

export function MessageMarkers(
	{
		canEdit,
		jobs: allJobs = [],
		messageId,
		messageText = "",
		onCard,
		onAddExcerpt,
		onRetry,
		onRetryJob,
		state,
	}: {
		canEdit: boolean;
		jobs?: ConversationPlan.Job[];
		messageId: string;
		messageText?: string;
		onCard: (link: CardLink) => void;
		onAddExcerpt?: (action: ExcerptCorrectionAction) => Promise<void>;
		onRetry: (messageId: string, actionId: string, lane?: "decision" | "research") => Promise<void>;
		onRetryJob?: (jobId: string) => Promise<void>;
		state?: ConversationPlan.State;
	},
) {
	let [pinned, setPinned] = useState(false);
	let [retrying, setRetrying] = useState<Lane>();
	let [retried, setRetried] = useState<Lane[]>([]);
	let [loadFailed, setLoadFailed] = useState(false);
	let [opening, setOpening] = useState(false);
	let [error, setError] = useState("");
	let [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
	let [focusPanelRequest, setFocusPanelRequest] = useState(0);
	let trigger = useRef<HTMLButtonElement>(null);
	let popover = useRef<HTMLDivElement>(null);
	let popoverContent = useRef<HTMLDivElement>(null);
	let identity = useRef({});
	let retryIds = useRef<Partial<Record<Lane, string>>>({});
	let resultSeen = useRef<boolean | undefined>(undefined);
	let popoverId = useId();
	let links = state ? messageLinks(state, messageId) : [];
	let analysis = state ? analysisForMessage(state, messageId) : undefined;
	let research = state?.research?.analysis.find(item => item.messageId === messageId);
	let researchPending = !!state?.research?.queue.some(item =>
		item.messageId === messageId && item.status !== "failed"
	);
	let jobs = state
		? jobsForMessage(state, allJobs, messageId)
		: allJobs.filter(job => job.trigger === messageId);
	let jobsOnly = !analysis && !research && !researchPending && links.length === 0
		&& jobs.length > 0;
	let status = analysis?.status
		?? (links.length > 0 ? "applied" : jobsOnly ? "Planner jobs" : "unlinked");
	let hasDiagnostics = !!analysis || !!research || researchPending || links.length > 0
		|| jobs.length > 0;
	let visible = pinned && hasDiagnostics;
	let outcome = state ? messageOutcome(state, messageId) : undefined;
	let hasResult = !!outcome && (outcome.changes.length > 0 || outcome.failed.length > 0);
	if (state && resultSeen.current === undefined) resultSeen.current = hasResult;
	let motion = motionContract("popover");
	let immediately = motionImmediately();
	let presence = useTransitionPresence(
		visible && position.visibility === "visible" ? position : undefined,
		motion.closeDuration,
		immediately,
	);
	let mounted = visible || presence.phase !== "closed";
	let notable = !!outcome
		&& (hasResult || outcome.research === "offered" || jobs.some(job => job.status === "failed"));
	let active = visible && presence.phase !== "closing";
	let retry = (lane: Lane) => {
		if (retrying) return;
		let id = retryIds.current[lane] ?? crypto.randomUUID();
		retryIds.current[lane] = id;
		setRetrying(lane);
		setError("");
		void onRetry(messageId, id, lane === "research" ? lane : undefined).then(() => {
			if (retryIds.current[lane] === id) delete retryIds.current[lane];
			setRetried(lanes => lanes.includes(lane) ? lanes : [...lanes, lane]);
		}, () =>
			setError(
				lane === "decision"
					? "Couldn’t retry the analysis. Try again when connected."
					: "Couldn’t retry the research check. Try again when connected.",
			)).finally(() => setRetrying(undefined));
	};
	let requestPanelFocus = () => setFocusPanelRequest(request => request + 1);
	let closeAnalysis = (returnFocus = false) => {
		setFocusPanelRequest(0);
		setPinned(false);
		if (analysisOwner?.id === identity.current) analysisOwner = undefined;
		if (returnFocus) trigger.current?.focus({ preventScroll: true });
	};
	let openAnalysis = () => {
		if (!AnalysisDetails) {
			setLoadFailed(false);
			setOpening(true);
			loadDetails().then(() => {
				setOpening(false);
				openAnalysis();
			}, () => {
				setOpening(false);
				setLoadFailed(true);
			});
			return;
		}
		setLoadFailed(false);
		if (analysisOwner?.id !== identity.current) analysisOwner?.close();
		analysisOwner = { id: identity.current, close: () => setPinned(false) };
		requestPanelFocus();
		setPinned(true);
	};
	let focusAfterTrigger = () => {
		let controls = [...document.querySelectorAll<HTMLElement>(
			'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
		)].filter(element =>
			element.getClientRects().length > 0 && !popover.current?.contains(element)
		);
		let index = controls.indexOf(trigger.current!);
		controls[index + 1]?.focus();
	};

	useEffect(() => () => {
		if (analysisOwner?.id === identity.current) analysisOwner = undefined;
	}, []);

	useEffect(() => {
		if (!hasDiagnostics) closeAnalysis();
		else prefetchWhenIdle();
	}, [hasDiagnostics]);

	useLayoutEffect(() => {
		if (!visible) return;
		let place = () => {
			let anchor = trigger.current;
			let panel = popover.current;
			if (!anchor || !panel) return;
			let anchorBox = anchor.getBoundingClientRect();
			let transcript = anchor.closest<HTMLElement>("[data-focus-boundary]");
			let chat = transcript?.parentElement;
			let chatBox = chat?.getBoundingClientRect();
			let transcriptBox = transcript?.getBoundingClientRect();
			let composerBox = chat?.querySelector<HTMLElement>(".chat-composer")
				?.getBoundingClientRect();
			if (
				!transcriptBox
				|| anchorBox.bottom <= transcriptBox.top
				|| anchorBox.top >= transcriptBox.bottom
			) {
				closeAnalysis();
				setPosition({ visibility: "hidden" });
				return;
			}
			let margin = 8;
			let gap = 4;
			let leftEdge = Math.max(margin, (chatBox?.left ?? 0) + margin);
			let rightEdge = Math.min(
				window.innerWidth - margin,
				(chatBox?.right ?? window.innerWidth) - margin,
			);
			let width = Math.min(448, Math.max(0, rightEdge - leftEdge));
			let topEdge = Math.max(margin, transcriptBox?.top ?? margin);
			let bottomEdge = Math.min(
				window.innerHeight - margin,
				composerBox?.top ?? window.innerHeight - margin,
			);
			let naturalHeight = panel.scrollHeight;
			let preferredHeight = Math.min(350, naturalHeight);
			let fit = (box: DOMRect) => {
				let above = Math.max(0, box.top - gap - topEdge);
				let below = Math.max(0, bottomEdge - box.bottom - gap);
				let aboveFirst = below < preferredHeight && above >= below;
				return { box, aboveFirst, height: Math.min(preferredHeight, aboveFirst ? above : below) };
			};
			// Clear the whole message and its result line; a tall message falls back to the trigger.
			let block = anchor.closest<HTMLElement>("[data-chat-message-id]")?.getBoundingClientRect();
			let placement = block ? fit(block) : fit(anchorBox);
			if (placement.height < Math.min(preferredHeight, 160)) {
				let fallback = fit(anchorBox);
				if (fallback.height > placement.height) placement = fallback;
			}
			let { aboveFirst, height } = placement;
			if (height <= 0 || width <= 0) {
				setPosition({ visibility: "hidden" });
				return;
			}
			let left = Math.max(leftEdge, Math.min(anchorBox.left, rightEdge - width));
			let top = aboveFirst ? placement.box.top - gap - height : placement.box.bottom + gap;
			setPosition({
				"--motion-origin-x": `${Math.min(width, Math.max(0, anchorBox.left - left))}px`,
				"--motion-origin-y": aboveFirst ? `${height}px` : "0px",
				left,
				maxHeight: height,
				top,
				visibility: "visible",
				width,
			} as CSSProperties);
		};
		place();
		let observer = new ResizeObserver(place);
		if (trigger.current) observer.observe(trigger.current);
		if (popover.current) observer.observe(popover.current);
		if (popoverContent.current) observer.observe(popoverContent.current);
		window.addEventListener("resize", place);
		document.addEventListener("scroll", place, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", place);
			document.removeEventListener("scroll", place, true);
		};
	}, [state, error, visible]);

	useLayoutEffect(() => {
		if (focusPanelRequest === 0) return;
		if (!visible) {
			setFocusPanelRequest(0);
			return;
		}
		if (position.visibility !== "visible") {
			return;
		}
		setFocusPanelRequest(0);
		let action = popover.current?.querySelector<HTMLButtonElement>(
			"[data-excerpt-correction-trigger]:not(:disabled)",
		);
		let firstControl = action
			?? popover.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
		firstControl?.focus();
	}, [focusPanelRequest, position, visible]);

	useEffect(() => {
		if (!visible) return;
		let onFocus = (event: FocusEvent) => {
			let target = event.target;
			if (!(target instanceof Node)) return;
			if (!trigger.current?.contains(target) && !popover.current?.contains(target)) {
				closeAnalysis();
			}
		};
		let onPointerDown = (event: PointerEvent) => {
			let target = event.target;
			if (!(target instanceof Node)) return;
			if (!trigger.current?.contains(target) && !popover.current?.contains(target)) {
				closeAnalysis();
			}
		};
		let onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			closeAnalysis(true);
		};
		document.addEventListener("focusin", onFocus);
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onEscape, true);
		return () => {
			document.removeEventListener("focusin", onFocus);
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onEscape, true);
		};
	}, [visible]);

	if (!state && jobs.length === 0) return null;
	if (state && !hasDiagnostics) return null;

	return (
		<div data-message-markers={messageId}>
			{hasDiagnostics && (
				<button
					aria-controls={visible ? popoverId : undefined}
					aria-expanded={visible}
					aria-busy={opening || undefined}
					aria-label={`Message details: ${jobsOnly ? "Planner jobs" : outcome?.heading ?? status}`}
					className="chat-message-action btn btn-icon btn-ghost absolute right-0 top-0"
					data-analysis-notable={notable || undefined}
					data-analysis-trigger
					data-tooltip="Details"
					onClick={() => visible ? closeAnalysis() : openAnalysis()}
					onFocus={prefetchDetails}
					onPointerEnter={prefetchDetails}
					onTouchStart={prefetchDetails}
					ref={trigger}
					type="button"
				>
					<InfoIcon aria-hidden="true" size={14} />
				</button>
			)}
			{outcome && (
				<AnalysisResult
					animate={resultSeen.current === false}
					canEdit={canEdit}
					messageText={messageText}
					onCard={onCard}
					onRetry={retry}
					outcome={outcome}
					retried={retried}
					retrying={retrying}
				/>
			)}
			{loadFailed && (
				<p className="m-0 mt-0.5 text-xs text-text-tertiary" role="status">
					Couldn’t open details. Try again.
				</p>
			)}
			{mounted && AnalysisDetails && createPortal(
				<div
					aria-hidden={active ? undefined : "true"}
					aria-label={jobsOnly ? "Planner jobs" : "Message analysis"}
					className={`motion-popover ${
						presence.phase === "open" ? "is-open" : presence.phase === "closing" ? "is-closing" : ""
					} fixed z-50 flex flex-col overflow-x-hidden overflow-y-auto rounded-lg bg-page p-3 text-sm text-text-secondary ring-hairline shadow-overlay`}
					data-analysis-message={messageId}
					data-analysis-popover
					data-motion-immediate={immediately || undefined}
					id={popoverId}
					inert={!active}
					onKeyDown={event => {
						if (event.key !== "Tab") return;
						let controls = [
							...event.currentTarget.querySelectorAll<HTMLElement>(
								"button:not(:disabled), summary, a[href], [tabindex]:not([tabindex='-1'])",
							),
						].filter(element => element.getClientRects().length > 0);
						let current = controls.indexOf(document.activeElement as HTMLElement);
						if (event.shiftKey && current === 0) {
							event.preventDefault();
							trigger.current?.focus();
						}
						if (!event.shiftKey && current === controls.length - 1) {
							event.preventDefault();
							focusAfterTrigger();
						}
					}}
					ref={popover}
					style={position}
				>
					<div ref={popoverContent}>
						<AnalysisDetails
							analysis={analysis}
							canEdit={canEdit}
							error={error}
							jobs={jobs}
							jobsOnly={jobsOnly}
							links={links}
							messageId={messageId}
							messageText={messageText}
							onAddExcerpt={onAddExcerpt}
							onCard={link => {
								closeAnalysis();
								onCard(link);
							}}
							onClose={() => closeAnalysis(true)}
							onRetry={retry}
							onRetryJob={onRetryJob}
							outcome={outcome}
							research={research}
							researchPending={researchPending}
							retrying={retrying}
							state={state}
						/>
					</div>
				</div>,
				document.body,
			)}
		</div>
	);
}
