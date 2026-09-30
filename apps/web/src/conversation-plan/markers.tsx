import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { analysisForMessage, jobsForMessage, messageLinks } from "./links";
import { AnalysisOverview } from "./analysis-overview";
import { JobsOnlyDiagnostics, PlannerJobDiagnostics } from "./planner-job-diagnostics";
import type { ExcerptCorrectionAction } from "./analysis-overview";

import type { ConversationPlan } from "@chopin/protocol";
import type { CSSProperties, RefObject } from "react";
import type { CardLink } from "./links";

export { JobsOnlyDiagnostics, PlannerJobDiagnostics } from "./planner-job-diagnostics";

let hoverDismissedUntilPointerMoves = false;

let resumeAnalysisHover = () => {
	hoverDismissedUntilPointerMoves = false;
};

let dismissAnalysisHover = () => {
	hoverDismissedUntilPointerMoves = true;
	document.addEventListener("pointermove", resumeAnalysisHover, { once: true });
};

let hoverOwner: object | undefined;

export function MessageMarkers(
	{
		anchorRef,
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
		anchorRef?: RefObject<HTMLDivElement | null>;
		canEdit: boolean;
		jobs?: ConversationPlan.Job[];
		messageId: string;
		messageText?: string;
		onCard: (link: CardLink) => void;
		onAddExcerpt?: (action: ExcerptCorrectionAction) => Promise<void>;
		onRetry: (messageId: string, actionId: string) => Promise<void>;
		onRetryJob?: (jobId: string) => Promise<void>;
		state?: ConversationPlan.State;
	},
) {
	let [preview, setPreview] = useState(false);
	let [pinned, setPinned] = useState(false);
	let [retrying, setRetrying] = useState(false);
	let [error, setError] = useState("");
	let [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
	let [focusPanelRequest, setFocusPanelRequest] = useState(0);
	let trigger = useRef<HTMLButtonElement>(null);
	let popover = useRef<HTMLDivElement>(null);
	let popoverContent = useRef<HTMLDivElement>(null);
	let previewClose = useRef<number | undefined>(undefined);
	let hoverOpen = useRef<number | undefined>(undefined);
	let hoverIdentity = useRef({});
	let restoringTriggerFocus = useRef(false);
	let retryId = useRef<string | undefined>(undefined);
	let popoverId = useId();
	let links = state ? messageLinks(state, messageId) : [];
	let analysis = state ? analysisForMessage(state, messageId) : undefined;
	let jobs = state
		? jobsForMessage(state, allJobs, messageId)
		: allJobs.filter(job => job.trigger === messageId);
	let visible = preview || pinned;
	let jobsOnly = !analysis && links.length === 0 && jobs.length > 0;
	let status = analysis?.status
		?? (links.length > 0 ? "applied" : jobsOnly ? "Planner jobs" : "unlinked");
	let hasDiagnostics = !!analysis || links.length > 0 || jobs.length > 0;
	let reviewableCount = analysis && ["applied", "unlinked"].includes(analysis.status)
		? analysis.outcomes?.filter(outcome =>
			["review", "ignored"].includes(outcome.status)
			&& !links.some(link => link.source.start === outcome.start && link.source.end === outcome.end)
		).length ?? 0
		: 0;
	let cancelPreviewClose = () => {
		if (previewClose.current !== undefined) window.clearTimeout(previewClose.current);
		previewClose.current = undefined;
	};
	let cancelHoverOpen = () => {
		if (hoverOpen.current !== undefined) window.clearTimeout(hoverOpen.current);
		hoverOpen.current = undefined;
	};
	let requestPanelFocus = () => setFocusPanelRequest(request => request + 1);
	let openPreview = (element: HTMLElement) => {
		if (hoverDismissedUntilPointerMoves) return;
		cancelHoverOpen();
		if (hoverOwner && hoverOwner !== hoverIdentity.current) {
			hoverOpen.current = window.setTimeout(() => {
				hoverOpen.current = undefined;
				if (!element.matches(":hover") || (hoverOwner && hoverOwner !== hoverIdentity.current)) {
					return;
				}
				hoverOwner = hoverIdentity.current;
				cancelPreviewClose();
				setPreview(true);
			}, 130);
			return;
		}
		hoverOwner = hoverIdentity.current;
		cancelPreviewClose();
		setPreview(true);
	};
	let schedulePreviewClose = () => {
		cancelPreviewClose();
		previewClose.current = window.setTimeout(() => {
			if (hoverOwner === hoverIdentity.current) hoverOwner = undefined;
			setPreview(false);
			previewClose.current = undefined;
		}, 120);
	};
	let closeAnalysis = () => {
		cancelPreviewClose();
		cancelHoverOpen();
		setFocusPanelRequest(0);
		if (hoverOwner === hoverIdentity.current) hoverOwner = undefined;
		dismissAnalysisHover();
		setPinned(false);
		setPreview(false);
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
		if (previewClose.current !== undefined) window.clearTimeout(previewClose.current);
		if (hoverOpen.current !== undefined) window.clearTimeout(hoverOpen.current);
		if (hoverOwner === hoverIdentity.current) hoverOwner = undefined;
	}, []);

	useEffect(() => {
		let anchor = anchorRef?.current;
		if (!anchor || !hasDiagnostics) return;
		anchor.dataset.analysisAvailable = "";
		let open = () => {
			openPreview(anchor);
		};
		let leave = () => {
			cancelHoverOpen();
			schedulePreviewClose();
		};
		let toggle = (event: MouseEvent) => {
			if (
				event.target instanceof Element
				&& event.target.closest("a, button, input, select, textarea, [contenteditable]")
			) return;
			if (!window.getSelection()?.isCollapsed) return;
			cancelPreviewClose();
			if (pinned) setFocusPanelRequest(0);
			else requestPanelFocus();
			setPinned(value => !value);
		};
		anchor.addEventListener("mouseenter", open);
		anchor.addEventListener("mouseleave", leave);
		anchor.addEventListener("click", toggle);
		return () => {
			delete anchor.dataset.analysisAvailable;
			anchor.removeEventListener("mouseenter", open);
			anchor.removeEventListener("mouseleave", leave);
			anchor.removeEventListener("click", toggle);
		};
	});

	useLayoutEffect(() => {
		if (!visible) return;
		let place = () => {
			let anchor = anchorRef?.current ?? trigger.current;
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
				if (hoverOwner === hoverIdentity.current) hoverOwner = undefined;
				setPinned(false);
				setPreview(false);
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
			let above = Math.max(0, anchorBox.top - gap - topEdge);
			let below = Math.max(0, bottomEdge - anchorBox.bottom - gap);
			let aboveFirst = below < preferredHeight && above >= below;
			let available = aboveFirst ? above : below;
			let height = Math.min(preferredHeight, available);
			if (height <= 0 || width <= 0) {
				setPosition({ visibility: "hidden" });
				return;
			}
			let left = Math.max(leftEdge, Math.min(anchorBox.left, rightEdge - width));
			let top = aboveFirst ? anchorBox.top - gap - height : anchorBox.bottom + gap;
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
		if (anchorRef?.current) observer.observe(anchorRef.current);
		else if (trigger.current) observer.observe(trigger.current);
		if (popover.current) observer.observe(popover.current);
		if (popoverContent.current) observer.observe(popoverContent.current);
		window.addEventListener("resize", place);
		document.addEventListener("scroll", place, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", place);
			document.removeEventListener("scroll", place, true);
		};
	}, [anchorRef, state, error, visible]);

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
				if (hoverOwner === hoverIdentity.current) hoverOwner = undefined;
				setPreview(false);
			}
		};
		let onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			closeAnalysis();
			if (document.activeElement !== trigger.current) {
				restoringTriggerFocus.current = true;
				trigger.current?.focus();
			}
		};
		document.addEventListener("focusin", onFocus);
		document.addEventListener("keydown", onEscape, true);
		return () => {
			document.removeEventListener("focusin", onFocus);
			document.removeEventListener("keydown", onEscape, true);
		};
	}, [visible]);

	if (!state && jobs.length === 0) return null;
	if (state && links.length === 0 && !analysis && jobs.length === 0) return null;

	return (
		<div
			className="relative mt-1 flex flex-wrap gap-1 text-sm"
			data-message-markers={messageId}
		>
			{links.slice(0, 3).map(link => (
				<button
					aria-label={`${link.label}: show card for “${link.source.quote}”`}
					className="rounded-full bg-inset px-2 py-0.5 text-xs text-text-secondary hover:bg-hover"
					data-card-link={link.itemId}
					data-card-thread={link.threadId}
					key={`${link.itemId}-${link.source.start}-${link.source.end}`}
					onClick={() => onCard(link)}
					title={link.source.quote}
					type="button"
				>
					{link.label}
				</button>
			))}
			{reviewableCount > 0 && (
				<button
					aria-controls={visible ? popoverId : undefined}
					aria-expanded={visible}
					className="rounded-full bg-inset px-2 py-0.5 text-xs text-text-secondary hover:bg-hover"
					onClick={() => {
						requestPanelFocus();
						cancelPreviewClose();
						cancelHoverOpen();
						if (hoverOwner === hoverIdentity.current) hoverOwner = undefined;
						dismissAnalysisHover();
						setPreview(false);
						setPinned(true);
					}}
					type="button"
				>
					Review {reviewableCount} excerpt{reviewableCount === 1 ? "" : "s"}
				</button>
			)}
			{hasDiagnostics && (
				<button
					aria-controls={visible ? popoverId : undefined}
					aria-expanded={visible}
					aria-label={`Analysis for message: ${status}`}
					className="sr-only focus:not-sr-only focus:absolute focus:right-0 focus:bottom-0 focus:z-10 focus:rounded-md focus:bg-page focus:px-2 focus:py-1"
					onClick={() => {
						cancelPreviewClose();
						if (visible) setFocusPanelRequest(0);
						else requestPanelFocus();
						setPinned(value => !value);
					}}
					onFocus={() => {
						if (restoringTriggerFocus.current) {
							restoringTriggerFocus.current = false;
							return;
						}
						cancelPreviewClose();
						setPreview(true);
					}}
					onKeyDown={event => {
						if (event.key !== "Tab" || event.shiftKey) return;
						event.preventDefault();
						cancelPreviewClose();
						setPreview(true);
						requestAnimationFrame(() => {
							popover.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
						});
					}}
					onMouseEnter={() => {
						if (trigger.current) openPreview(trigger.current);
					}}
					onMouseLeave={() => {
						cancelHoverOpen();
						schedulePreviewClose();
					}}
					ref={trigger}
					title={jobsOnly ? "Inspect Planner jobs; click to pin" : "Inspect analysis; click to pin"}
					type="button"
				>
					Inspect analysis
				</button>
			)}
			{visible && createPortal(
				<div
					aria-label={jobsOnly ? "Planner jobs" : "Message analysis"}
					className="motion-popover is-open fixed z-50 flex flex-col overflow-x-hidden overflow-y-auto rounded-lg bg-page p-3 text-sm text-text-secondary ring-hairline shadow-overlay"
					data-analysis-message={messageId}
					data-analysis-popover
					id={popoverId}
					onMouseEnter={() => {
						cancelPreviewClose();
						hoverOwner = hoverIdentity.current;
					}}
					onMouseLeave={() => {
						if (hoverOwner === hoverIdentity.current) hoverOwner = undefined;
						schedulePreviewClose();
					}}
					onKeyDown={event => {
						if (event.key !== "Tab") return;
						let controls = [
							...event.currentTarget.querySelectorAll<HTMLElement>(
								"button:not(:disabled), summary, a[href], [tabindex]:not([tabindex='-1'])",
							),
						].filter(element => element.getClientRects().length > 0);
						let current = controls.indexOf(document.activeElement as HTMLElement);
						if (
							(event.shiftKey && current === 0)
						) {
							event.preventDefault();
							trigger.current?.focus();
						}
						if (!event.shiftKey && current === controls.length - 1) {
							event.preventDefault();
							if (!pinned) setPreview(false);
							focusAfterTrigger();
						}
					}}
					ref={popover}
					style={position}
				>
					<div ref={popoverContent}>
						{jobsOnly
							? (
								<JobsOnlyDiagnostics
									canEdit={canEdit}
									jobs={jobs}
									onClose={closeAnalysis}
									onRetryJob={onRetryJob}
								/>
							)
							: (
								<>
									<div className="flex items-center justify-between gap-2">
										<span className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
											Jev analysis
										</span>
										<button
											aria-label="Close analysis"
											className="btn btn-sm btn-ghost"
											onClick={closeAnalysis}
											type="button"
										>
											Close
										</button>
									</div>
									<AnalysisOverview
										analysis={analysis}
										canEdit={canEdit}
										links={links}
										messageId={messageId}
										messageText={messageText}
										onAddExcerpt={onAddExcerpt}
										state={state}
										status={analysis?.status ?? (links.length ? "applied" : "unlinked")}
									/>
									<PlannerJobDiagnostics
										canEdit={canEdit}
										jobs={jobs}
										onRetryJob={onRetryJob}
									/>
									{status === "failed" && canEdit && (
										<button
											className="btn btn-sm btn-secondary mt-2"
											disabled={retrying}
											onClick={() => {
												let id = retryId.current ?? crypto.randomUUID();
												retryId.current = id;
												setRetrying(true);
												setError("");
												void onRetry(messageId, id).then(() => {
													if (retryId.current === id) retryId.current = undefined;
												}, error => setError(String(error))).finally(() => setRetrying(false));
											}}
											type="button"
										>
											Retry analysis
										</button>
									)}
									{error && <p className="m-0 mt-1 text-destructive-ink" role="alert">{error}</p>}
								</>
							)}
					</div>
				</div>,
				document.body,
			)}
		</div>
	);
}
