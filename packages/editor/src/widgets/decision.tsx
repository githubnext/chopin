/**
 * Accepted comment threads, in the prose.
 *
 * Accepted threads are durable plan content, rendered from their frozen record.
 */

import { Provenance, SidecarCard } from "../card";

import type { Decision, DecisionNode } from "@chopin/dialect";

export function DecisionCard({ value }: { value: Decision }) {
	return (
		<SidecarCard
			data-plan-comment-card
			label="Decision"
			settled
			status={<Provenance at={value.at} by={value.by} verb="Accepted" />}
		>
			<ul className="m-0 flex list-none flex-col gap-2 p-0">
				{value.notes.map((note, index) => (
					<li className="flex flex-col gap-0.5" key={`${note.by}-${index}`}>
						<span className="text-sm font-semibold text-brand-ink">@{note.by}</span>
						<p className="m-0 text-sm whitespace-pre-wrap text-text-primary">{note.text}</p>
					</li>
				))}
			</ul>
			<div className="plan-comment-context" data-plan-comment-context>
				<blockquote className="plan-comment-context-copy m-0 text-sm text-text-secondary">
					{value.quote}
				</blockquote>
			</div>
		</SidecarCard>
	);
}

export function renderDecision(node: DecisionNode) {
	return <DecisionCard value={node.getDecision()} />;
}
