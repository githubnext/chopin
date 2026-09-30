import { MessageForwardIcon } from "@chopin/icons";
import { Face } from "@chopin/editor";

import type { SourceDestination } from "./card-parts";
import type { EvidenceRow } from "./evidence";

function People({ handles, label, opposed = false }: {
	handles: string[];
	label: string;
	opposed?: boolean;
}) {
	if (handles.length === 0) return null;
	let shown = handles.slice(0, 8);
	return (
		<span className="flex shrink-0 items-center">
			<span className="sr-only">{label} {handles.join(", ")}</span>
			{shown.map((handle, index) => (
				<span
					aria-hidden="true"
					className={`block rounded-md ${index > 0 ? "-ml-1" : ""} ${
						opposed
							? "ring-2 ring-destructive"
							: ""
					}`}
					key={handle}
				>
					<Face handle={handle} ring={opposed ? undefined : "page"} size={18} />
				</span>
			))}
			{handles.length > 8 && (
				<span aria-hidden="true" className="ml-1 text-sm text-text-tertiary tabular-nums">
					+{handles.length - 8}
				</span>
			)}
		</span>
	);
}

export function EvidencePopover({ rows, onSource }: {
	rows: EvidenceRow[];
	onSource: (destination: SourceDestination) => void;
}) {
	return (
		<section aria-label="Evidence" className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto p-3">
			{rows.map(row => (
				<div className="flex flex-col gap-1" key={row.optionId ?? "question"}>
					<h4 className="m-0 min-w-0 break-words text-sm font-medium text-text-primary [overflow-wrap:anywhere]">
						{row.label}
					</h4>
					<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
						{row.origin === "planner" && (
							<span className="shrink-0 rounded-full bg-inset px-1.5 text-sm text-text-tertiary">
								Planner suggested
							</span>
						)}
						<People handles={row.supporters} label="Supported by" />
						<People handles={row.opposers} label="Opposed by" opposed />
					</div>
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
								className="shrink-0 rounded-sm px-1 text-text-tertiary hover:bg-hover hover:text-text-secondary"
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
										<span className="shrink-0 text-text-tertiary">
											{item.kind === "reason" ? "Reason" : "Constraint"}
										</span>
										<span className="min-w-0 flex-1 text-text-primary [overflow-wrap:anywhere]">
											{item.text}
										</span>
										{source && (
											<button
												aria-label={`Show “${item.text}” in chat`}
												className="shrink-0 rounded-sm px-1 text-text-tertiary hover:bg-hover hover:text-text-secondary"
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
			))}
		</section>
	);
}
