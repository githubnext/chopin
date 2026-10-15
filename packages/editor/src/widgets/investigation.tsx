import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useCellValue } from "@mdxeditor/gurx";
import { CloseIcon, InvestigationIcon, WarningIcon } from "@chopin/icons";

import { SidecarCard } from "../card";
import { widgets$ } from "../widget-options";
import { ResearchBrief } from "./research";
import { Fold, Swap, useLast } from "./research-motion";

import type { MouseEvent, ReactNode } from "react";
import type { InvestigationNode } from "@chopin/dialect";
import type { InvestigationState } from "@chopin/experiment/records";

const WORDS: Record<InvestigationState, string> = {
	requested: "Ready to run",
	queued: "Waiting for your local agent",
	running: "Running",
	publishing: "Writing up",
	completed: "Investigation",
	failed: "Investigation failed",
	cancelled: "Stopped",
	interrupted: "Interrupted",
};

const TRACK: InvestigationState[] = ["queued", "running", "publishing"];

export type InvestigationCardProps = {
	/** The investigation's id, so a child can find its way back to this card. */
	id?: string;
	brief: string;
	state: InvestigationState;
	/** The local agent's latest progress line. */
	progress?: string;
	/** The user's latest action result. */
	error?: string;
	busy?: boolean;
	canEdit?: boolean;
	/** Quiet guidance shown under the brief, such as how to start a local agent. */
	notice?: ReactNode;
	onRun?: () => void;
	onStop?: () => void;
	onRetry?: () => void;
	onRemove?: () => void;
	/** The child document a completed investigation was published as. */
	ready?: { title: string; summary: string; views: number };
	onOpen?: (opener: HTMLElement) => void;
	/** Host detail under a ready card, such as the decisions recorded from its views. */
	children?: ReactNode;
};

function Indicator({ state }: { state: InvestigationState }) {
	if (state === "failed" || state === "interrupted") {
		return (
			<span aria-hidden="true" className="plan-research-badge">
				<WarningIcon size={16} />
			</span>
		);
	}
	if (state === "completed") {
		return (
			<span aria-hidden="true" className="plan-research-badge" data-tone="brand">
				<InvestigationIcon size={16} />
			</span>
		);
	}
	return (
		<span
			aria-hidden="true"
			className="plan-research-dot"
			data-idle={state === "requested" || state === "cancelled" ? "" : undefined}
		/>
	);
}

/** Mirrors the research card: status, brief, what needs attention, then one action. */
export function InvestigationCard(
	{
		brief,
		busy,
		canEdit = true,
		children,
		error,
		id,
		notice,
		onOpen,
		onRemove,
		onRetry,
		onRun,
		onStop,
		progress,
		ready,
		state,
	}: InvestigationCardProps,
) {
	let shownSummary = useLast(ready?.summary || undefined);
	let footer = onRun ? "run" : onRetry ? "retry" : onStop ? "stop" : undefined;
	let lead = state === "completed" || state === "failed" || state === "interrupted";
	let at = TRACK.indexOf(state);
	let shownAt = useLast(at >= 0 ? at : undefined);
	let failure = state === "failed" || state === "interrupted" ? progress : undefined;
	let messages = [error, failure].filter((text): text is string => !!text);
	let shownMessages = useLast(messages.length > 0 ? messages : undefined);
	let live = state === "running" && progress ? progress : undefined;
	let shownLive = useLast(live);
	let settle = (event: MouseEvent<HTMLElement>, run?: () => void) => {
		let card = event.currentTarget.closest("article");
		run?.();
		card?.focus({ preventScroll: true });
	};
	return (
		<div className="plan-research-tracked">
			<SidecarCard
				className={`plan-research-card${ready ? " relative" : ""}`}
				data-investigation={id}
				data-investigation-ready={ready ? "" : undefined}
				data-investigation-state={state}
				data-stage={state}
				label="Investigation"
				tabIndex={-1}
			>
				<span className="sr-only" role="status">{messages.join(" ")}</span>
				<div className="plan-research-status" data-lead={lead ? "" : undefined}>
					<Swap
						className="plan-research-indicator"
						id={state === "completed" ? "done" : lead ? "failed" : "dot"}
					>
						<Indicator state={state} />
					</Swap>
					<Swap id={state}>
						<span>
							{WORDS[state]}
							{ready && ready.views > 0 && (
								<>
									{" "}
									<span className="plan-research-meta ms-1">
										{ready.views === 1 ? "1 view" : `${ready.views} views`}
									</span>
								</>
							)}
						</span>
					</Swap>
					<div className="plan-research-remove">
						<Swap id={onRemove ? "remove" : "none"}>
							{onRemove && (
								<button
									aria-label="Remove investigation"
									className="btn btn-icon btn-ghost"
									data-tooltip="Remove"
									disabled={busy || !canEdit}
									onClick={event => settle(event, onRemove)}
									type="button"
								>
									<CloseIcon aria-hidden="true" size={16} />
								</button>
							)}
						</Swap>
					</div>
				</div>
				<Swap className="plan-research-title" id={ready ? "report" : "brief"}>
					{ready ? ready.title : <ResearchBrief text={brief} />}
				</Swap>
				<Fold open={!!ready?.summary}>
					{shownSummary !== undefined && <p className="plan-research-summary">{shownSummary}</p>}
				</Fold>
				<Fold open={live !== undefined}>
					{shownLive !== undefined && <p className="plan-research-summary">{shownLive}</p>}
				</Fold>
				<Fold open={messages.length > 0}>
					{shownMessages !== undefined && (
						<div aria-hidden="true" className="plan-research-callout">
							{shownMessages.map(text => <p key={text}>{text}</p>)}
						</div>
					)}
				</Fold>
				<Fold open={!!notice}>{notice}</Fold>
				{children && <div className="plan-research-detail">{children}</div>}
				<Fold open={!!footer}>
					<div className="plan-research-footer">
						<Swap id={footer ?? "none"}>
							{footer === "run" && (
								<button
									className="btn btn-sm btn-primary"
									disabled={busy || !canEdit}
									onClick={event => settle(event, onRun)}
									type="button"
								>
									Run
								</button>
							)}
							{footer === "retry" && (
								<button
									className="btn btn-sm btn-outline"
									disabled={busy || !canEdit}
									onClick={event => settle(event, onRetry)}
									type="button"
								>
									Retry
								</button>
							)}
							{footer === "stop" && (
								<button
									className="btn btn-sm btn-outline"
									disabled={busy || !canEdit}
									onClick={event => settle(event, onStop)}
									type="button"
								>
									Stop
								</button>
							)}
						</Swap>
					</div>
				</Fold>
				{ready && onOpen && (
					<button
						aria-label={`Open ${ready.title}`}
						className="plan-research-open"
						disabled={busy}
						onClick={event => onOpen(event.currentTarget)}
						type="button"
					/>
				)}
			</SidecarCard>
			<Fold open={at >= 0}>
				<div aria-hidden="true" className="plan-research-track" data-steps={TRACK.length}>
					{TRACK.map((step, index) => (
						<span
							data-state={shownAt === undefined || index > shownAt
								? "todo"
								: index === shownAt
								? "now"
								: "done"}
							key={step}
						/>
					))}
				</div>
			</Fold>
		</div>
	);
}

/** The host owns the record and its actions; the document only knows which investigation sits here. */
function InlineInvestigation({ id, node }: { id: string; node: InvestigationNode }) {
	let [editor] = useLexicalComposerContext();
	let investigations = useCellValue(widgets$).investigations;
	if (!investigations) {
		return (
			<SidecarCard label="Investigation">
				<strong>Investigation unavailable</strong>
			</SidecarCard>
		);
	}
	return investigations.render(id, () => editor.update(() => node.getLatest().remove()));
}

export function renderInvestigation(node: InvestigationNode) {
	return <InlineInvestigation id={node.getId()} node={node} />;
}
