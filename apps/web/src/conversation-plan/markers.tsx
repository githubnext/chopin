import { createPortal } from "react-dom";
import { CodeIcon } from "@chopin/icons";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { analysisForMessage, jobsForMessage, messageLinks } from "./links";
import { AnalysisOverview } from "./analysis-overview";
import { ResearchDiagnostics } from "./research-diagnostics";
import { JobsOnlyDiagnostics, PlannerJobDiagnostics } from "./planner-job-diagnostics";
import type { ExcerptCorrectionAction } from "./analysis-overview";

import type { ConversationPlan } from "@chopin/protocol";
import type { CSSProperties } from "react";
import type { CardLink } from "./links";

export { JobsOnlyDiagnostics, PlannerJobDiagnostics } from "./planner-job-diagnostics";

let analysisOwner: { id: object; close: () => void } | undefined;

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
	let [retrying, setRetrying] = useState(false);
	let [error, setError] = useState("");
	let [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
	let [focusPanelRequest, setFocusPanelRequest] = useState(0);
	let trigger = useRef<HTMLButtonElement>(null);
	let popover = useRef<HTMLDivElement>(null);
	let popoverContent = useRef<HTMLDivElement>(null);
	let identity = useRef({});
	let retryId = useRef<string | undefined>(undefined);
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
	let requestPanelFocus = () => setFocusPanelRequest(request => request + 1);
	let closeAnalysis = (returnFocus = false) => {
		setFocusPanelRequest(0);
		setPinned(false);
		if (analysisOwner?.id === identity.current) analysisOwner = undefined;
		if (returnFocus) trigger.current?.focus({ preventScroll: true });
	};
	let openAnalysis = () => {
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
					aria-label={`Analysis for message: ${status}`}
					className="btn btn-icon btn-ghost absolute right-0 top-0"
					data-analysis-trigger
					onClick={() => visible ? closeAnalysis() : openAnalysis()}
					ref={trigger}
					title={jobsOnly ? "Inspect Planner jobs" : "Inspect message analysis"}
					type="button"
				>
					<CodeIcon aria-hidden="true" size={14} />
				</button>
			)}
			{visible && createPortal(
				<div
					aria-label={jobsOnly ? "Planner jobs" : "Message analysis"}
					className="motion-popover is-open fixed z-50 flex flex-col overflow-x-hidden overflow-y-auto rounded-lg bg-page p-3 text-sm text-text-secondary ring-hairline shadow-overlay"
					data-analysis-message={messageId}
					data-analysis-popover
					id={popoverId}
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
									onClose={() => closeAnalysis(true)}
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
											onClick={() => closeAnalysis(true)}
											type="button"
										>
											Close
										</button>
									</div>
									{links.length > 0 && (
										<div
											aria-label="Linked decisions"
											className="mt-2 flex flex-wrap gap-1"
											role="group"
										>
											{links.slice(0, 3).map(link => (
												<button
													aria-label={`${link.label}: show card for “${link.source.quote}”`}
													className="rounded-full bg-inset px-2 py-0.5 text-xs text-text-secondary hover:bg-hover"
													data-card-link={link.itemId}
													data-card-thread={link.threadId}
													key={`${link.itemId}-${link.source.start}-${link.source.end}`}
													onClick={() => {
														closeAnalysis();
														onCard(link);
													}}
													title={link.source.quote}
													type="button"
												>
													{link.label}
												</button>
											))}
										</div>
									)}
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
									<ResearchDiagnostics
										analysis={research}
										pending={researchPending}
										canEdit={canEdit}
										onRetry={onRetry}
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
