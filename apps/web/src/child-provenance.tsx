import { useEffect, useId, useState } from "react";
import { ChevronIcon, SparkleIcon } from "@chopin/icons";

import { researchProvenance } from "./research-requests";

import type { Research } from "@chopin/protocol";
import type { ChildParent } from "./workspace-model";

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A quiet line above a research child that names its parent, brief, and sources. */
export function ChildProvenance({ channelId, parent }: { channelId: string; parent: ChildParent }) {
	let [provenance, setProvenance] = useState<Research.Provenance>();
	let [briefOpen, setBriefOpen] = useState(false);
	let briefId = useId();
	useEffect(() => {
		let controller = new AbortController();
		setProvenance(undefined);
		setBriefOpen(false);
		researchProvenance(channelId, controller.signal)
			.then(value => {
				if (!controller.signal.aborted) setProvenance(value);
			})
			// Provenance is context, not content; the document stays usable without it.
			.catch(() => {});
		return () => controller.abort();
	}, [channelId]);
	if (!provenance || provenance.parentChannelId !== parent.id) return null;
	let requestId = provenance.requestId;
	let returnToCard = () => {
		let card = document.querySelector<HTMLElement>(
			`[data-workspace-room="${CSS.escape(parent.id)}"] [data-research-request="${
				CSS.escape(requestId)
			}"]`,
		);
		parent.onReturn(card ? { current: card } : undefined);
	};
	return (
		<div className="child-provenance" data-child-provenance="">
			<p className="child-provenance-line">
				<span aria-hidden="true" className="plan-research-badge" data-tone="brand">
					<SparkleIcon size={14} />
				</span>
				<span className="min-w-0">
					Research from{" "}
					<button
						className="child-provenance-parent"
						data-tooltip="Show the research card"
						onClick={returnToCard}
						type="button"
					>
						{parent.label}
					</button>
					<span className="plan-research-meta">
						{provenance.startedBy && <>{" · by "}{provenance.startedBy}</>}
						{" · "}
						{provenance.sourceCount === 0
							? "No sources"
							: plural(provenance.sourceCount, "source")}
					</span>
				</span>
				<button
					aria-controls={briefId}
					aria-expanded={briefOpen}
					className="child-provenance-toggle btn btn-sm btn-ghost"
					onClick={() => setBriefOpen(open => !open)}
					type="button"
				>
					Brief
					<ChevronIcon
						aria-hidden="true"
						className={briefOpen ? "rotate-90" : undefined}
					/>
				</button>
			</p>
			<blockquote className="child-provenance-brief" hidden={!briefOpen} id={briefId}>
				{provenance.brief}
			</blockquote>
		</div>
	);
}
