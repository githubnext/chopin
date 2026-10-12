import { useEffect, useId, useState } from "react";
import { ChevronIcon, SparkleIcon } from "@chopin/icons";

import { investigationProvenance } from "./experiments/api";
import { researchProvenance } from "./research-requests";

import type { ChildParent } from "./workspace-model";

/** What a child needs to say where it came from, whichever card published it. */
type Provenance = {
	kind: "Research" | "Investigation";
	parentChannelId: string;
	brief: string;
	startedBy?: string;
	detail: string;
	/** The card in the parent that published this child. */
	card: string;
};

async function provenance(channelId: string, signal: AbortSignal): Promise<Provenance | undefined> {
	let research = await researchProvenance(channelId, signal);
	if (research) {
		return {
			kind: "Research",
			parentChannelId: research.parentChannelId,
			brief: research.brief,
			startedBy: research.startedBy,
			detail: research.sourceCount === 0 ? "No sources" : plural(research.sourceCount, "source"),
			card: `[data-research-request="${CSS.escape(research.requestId)}"]`,
		};
	}
	let investigation = await investigationProvenance(channelId, signal);
	if (!investigation) return undefined;
	return {
		kind: "Investigation",
		parentChannelId: investigation.parentChannelId,
		brief: investigation.brief,
		startedBy: investigation.startedBy,
		detail: investigation.viewCount === 0 ? "No views" : plural(investigation.viewCount, "view"),
		card: `[data-investigation="${CSS.escape(investigation.investigationId)}"]`,
	};
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A quiet line above a research or investigation child that names its parent and brief. */
export function ChildProvenance({ channelId, parent }: { channelId: string; parent: ChildParent }) {
	let [origin, setOrigin] = useState<Provenance>();
	let [briefOpen, setBriefOpen] = useState(false);
	let briefId = useId();
	useEffect(() => {
		let controller = new AbortController();
		setOrigin(undefined);
		setBriefOpen(false);
		provenance(channelId, controller.signal)
			.then(value => {
				if (!controller.signal.aborted) setOrigin(value);
			})
			// Provenance is context, not content; the document stays usable without it.
			.catch(() => {});
		return () => controller.abort();
	}, [channelId]);
	if (!origin || origin.parentChannelId !== parent.id) return null;
	let card = origin.card;
	let returnToCard = () => {
		// The parent card may still be loading while the child closes.
		parent.onReturn({
			get current() {
				return document.querySelector<HTMLElement>(
					`[data-workspace-room="${CSS.escape(parent.id)}"] ${card}`,
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
					{origin.kind} from{" "}
					<button
						className="child-provenance-parent"
						data-tooltip={`Show the ${origin.kind.toLowerCase()} card`}
						onClick={returnToCard}
						type="button"
					>
						{parent.label}
					</button>
					<span className="plan-research-meta">
						{origin.startedBy && (
							<>
								{" "}
								<span className="child-provenance-segment">· by {origin.startedBy}</span>
							</>
						)} <span className="child-provenance-segment">· {origin.detail}</span>
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
				{origin.brief}
			</blockquote>
		</div>
	);
}
