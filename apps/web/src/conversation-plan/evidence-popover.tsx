import { MessageForwardIcon } from "@chopin/icons";
import { InlineCode } from "@chopin/question/react";
import { Face } from "@chopin/editor";
import { Fragment } from "react";

import type { SourceDestination } from "./card-parts";
import { hasEvidence } from "./evidence";

import type { EvidenceCounts, EvidenceItem, EvidenceRow } from "./evidence";

const KIND: Record<EvidenceItem["kind"], string> = {
	reason: "Reason",
	constraint: "Constraint",
	objection: "Objection",
};

function plural(count: number, noun: string) {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The card's one-line summary; it doubles as the popover trigger's label. */
export function EvidenceSummary({ counts }: { counts: EvidenceCounts }) {
	let parts = [
		counts.reasons ? { text: plural(counts.reasons, "reason") } : undefined,
		counts.constraints ? { text: plural(counts.constraints, "constraint") } : undefined,
		counts.objections
			? { text: plural(counts.objections, "objection"), warning: true }
			: undefined,
	].filter(part => part !== undefined);
	if (parts.length === 0) return <>Evidence</>;
	return (
		<>
			{parts.map((part, index) => (
				<Fragment key={part.text}>
					{index > 0 && <span aria-hidden="true">·</span>}
					<span className={part.warning ? "text-warning-ink" : undefined}>{part.text}</span>
				</Fragment>
			))}
		</>
	);
}

function People({ handles, label, opposed = false }: {
	handles: string[];
	label: string;
	opposed?: boolean;
}) {
	if (handles.length === 0) return null;
	let shown = handles.slice(0, 8);
	return (
		<span className="flex shrink-0 items-center gap-1.5">
			<span aria-hidden="true" className="text-xs text-text-tertiary">{label}</span>
			<span className="sr-only">{label} {handles.join(", ")}</span>
			<span className="flex items-center">
				{shown.map((handle, index) => (
					<span
						aria-hidden="true"
						className={`block rounded-md ${index > 0 ? "-ml-1" : ""} ${
							opposed
								? "ring-2 ring-warning"
								: ""
						}`}
						key={handle}
						title={`@${handle}`}
					>
						<Face handle={handle} ring={opposed ? undefined : "page"} size={16} />
					</span>
				))}
				{handles.length > 8 && (
					<span aria-hidden="true" className="ml-1 text-xs text-text-tertiary tabular-nums">
						+{handles.length - 8}
					</span>
				)}
			</span>
		</span>
	);
}

export function EvidencePopover({ rows, onSource }: {
	rows: EvidenceRow[];
	onSource: (destination: SourceDestination) => void;
}) {
	return (
		<section aria-label="Evidence" className="flex flex-col gap-3 px-3 pb-3">
			{rows.filter(row => hasEvidence([row])).map(row => {
				// An objection already names who raised it.
				let objectors = new Set(row.items.flatMap(item => item.by ? [item.by] : []));
				let opposers = row.opposers.filter(handle => !objectors.has(handle));
				return (
					<div className="flex flex-col gap-1" key={row.optionId ?? "question"}>
						<h4 className="m-0 min-w-0 break-words text-sm font-medium text-text-primary [overflow-wrap:anywhere]">
							{row.optionId ? <InlineCode text={row.label} /> : "Applies to all options"}
						</h4>
						{(row.origin === "planner" || row.supporters.length > 0 || opposers.length > 0)
							&& (
								<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
									{row.origin === "planner" && (
										<span className="shrink-0 rounded-full bg-inset px-1.5 text-xs text-text-tertiary">
											Planner suggested
										</span>
									)}
									<People handles={row.supporters} label="Supported by" />
									<People handles={opposers} label="Opposed by" opposed />
								</div>
							)}
						{row.origin === "planner" && row.rationale && (
							<p className="m-0 text-sm text-text-secondary [overflow-wrap:anywhere]">
								Why Chopin suggested this: {row.rationale}
							</p>
						)}
						{row.origin === "planner" && row.source && row.optionId && (
							<div className="flex min-w-0 items-start gap-1.5 text-sm">
								<span className="shrink-0 text-text-tertiary">
									{row.source.author.kind === "member"
										? `@${row.source.author.handle}`
										: "Planner"}
								</span>
								<q className="min-w-0 flex-1 text-text-primary [overflow-wrap:anywhere]">
									{row.source.quote}
								</q>
								<button
									aria-label={`Show “${row.source.quote}” in chat`}
									className="btn btn-icon btn-ghost shrink-0"
									onClick={() => onSource({ source: row.source!, itemId: row.optionId! })}
									type="button"
								>
									<MessageForwardIcon aria-hidden="true" size={14} />
								</button>
							</div>
						)}
						{row.items.length > 0 && (
							<ul className="m-0 flex list-none flex-col gap-1 p-0">
								{row.items.map(item => {
									let source = item.sources[0];
									return (
										<li className="flex items-start gap-1.5 text-sm" key={item.id}>
											<span
												className={`w-16 shrink-0 pt-px text-xs ${
													item.kind === "objection" ? "text-warning-ink" : "text-text-tertiary"
												}`}
											>
												{KIND[item.kind]}
											</span>
											<span className="min-w-0 flex-1 text-text-primary [overflow-wrap:anywhere]">
												{item.text}
												{item.by && " "}
												{item.by && (
													<span className="whitespace-nowrap text-text-tertiary">@{item.by}</span>
												)}
											</span>
											{source && (
												<button
													aria-label={`Show “${item.text}” in chat`}
													className="btn btn-icon btn-ghost shrink-0"
													onClick={() => onSource({ source, itemId: item.id })}
													type="button"
												>
													<MessageForwardIcon aria-hidden="true" size={14} />
												</button>
											)}
										</li>
									);
								})}
							</ul>
						)}
					</div>
				);
			})}
		</section>
	);
}
