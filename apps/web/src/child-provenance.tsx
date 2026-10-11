import { useEffect, useState } from "react";
import { SparkleIcon } from "@chopin/icons";
import { UnfoldPanel, UnfoldToggle, useUnfold } from "@chopin/visuals/unfold";

import { researchProvenance } from "./research-requests";

import type { Research } from "@chopin/protocol";
import type { ChildParent } from "./workspace-model";

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A quiet line above a research child that names its parent, brief, and sources. */
export function ChildProvenance({ channelId, parent }: { channelId: string; parent: ChildParent }) {
	let [provenance, setProvenance] = useState<Research.Provenance>();
	let brief = useUnfold();
	let setBriefOpen = brief.setOpen;
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
	}, [channelId, setBriefOpen]);
	if (!provenance || provenance.parentChannelId !== parent.id) return null;
	let requestId = provenance.requestId;
	let returnToCard = () => {
		// The parent card may still be loading while the child closes.
		parent.onReturn({
			get current() {
				return document.querySelector<HTMLElement>(
					`[data-workspace-room="${CSS.escape(parent.id)}"] [data-research-request="${
						CSS.escape(requestId)
					}"]`,
				);
			},
		});
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
						{provenance.startedBy && (
							<>
								{" "}
								<span className="child-provenance-segment">· by {provenance.startedBy}</span>
							</>
						)}{" "}
						<span className="child-provenance-segment">
							· {provenance.sourceCount === 0
								? "No sources"
								: plural(provenance.sourceCount, "source")}
						</span>
					</span>
				</span>
				<UnfoldToggle className="child-provenance-toggle btn btn-sm btn-ghost" unfold={brief}>
					Brief
				</UnfoldToggle>
			</p>
			<UnfoldPanel unfold={brief}>
				<blockquote className="child-provenance-brief">{provenance.brief}</blockquote>
			</UnfoldPanel>
		</div>
	);
}
