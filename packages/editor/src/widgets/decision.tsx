/**
 * Accepted comment threads, in the prose.
 *
 * Accepted threads are durable plan content, so the frozen record appears in
 * the same place as the prose it settled.
 */

import { Provenance, SidecarCard } from "../card";

import type { Decision, DecisionNode } from "@chopin/dialect";

export function DecisionCard({ value }: { value: Decision }) {
	return (
		<SidecarCard
			label="Decision"
			settled
			status={<Provenance at={value.at} by={value.by} verb="Accepted" />}
		>
			<blockquote className="m-0 text-sm text-text-secondary italic">{value.quote}</blockquote>
			<ul className="m-0 flex list-none flex-col gap-2 p-0">
				{value.notes.map((note, index) => (
					<li className="flex flex-col gap-0.5" key={`${note.by}-${index}`}>
						<span className="text-sm font-semibold">@{note.by}</span>
						<p className="m-0 text-sm whitespace-pre-wrap text-text-primary">{note.text}</p>
					</li>
				))}
			</ul>
		</SidecarCard>
	);
}

export function renderDecision(node: DecisionNode) {
	return <DecisionCard value={node.getDecision()} />;
}
