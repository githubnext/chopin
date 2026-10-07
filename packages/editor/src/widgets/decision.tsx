/**
 * Accepted comment threads, in the prose.
 *
 * Accepted threads are durable plan content, rendered from their frozen record.
 * Collapsed they are one line like a settled decision; the thread opens on demand.
 */

import { useId, useState } from "react";

import { ChevronIcon, MessageIcon } from "@chopin/icons";

import { when } from "../card";

import type { Decision, DecisionNode } from "@chopin/dialect";

export function DecisionCard({ value }: { value: Decision }) {
	let [open, setOpen] = useState(false);
	let bodyId = useId();
	let stamp = value.at === undefined ? "" : when(value.at);

	return (
		<article
			aria-label="Accepted comment"
			className="flex flex-col gap-2 text-sm"
			data-card-settled=""
			data-plan-comment-card
		>
			<button
				aria-controls={open ? bodyId : undefined}
				aria-expanded={open}
				className="m-0 flex min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-sm text-text-secondary"
				onClick={() => setOpen(current => !current)}
				type="button"
			>
				<MessageIcon aria-hidden="true" className="shrink-0" size={14} />
				<span className="min-w-0 flex-1 truncate">
					Accepted · <em className="not-italic text-text-primary">{value.quote}</em>
				</span>
				<span className="hidden shrink-0 text-xs text-text-tertiary tabular-nums sm:inline">
					{value.by && <>@{value.by}</>}
					{stamp && ` · ${stamp}`}
				</span>
				<ChevronIcon
					aria-hidden="true"
					className={`shrink-0 text-text-tertiary ${open ? "rotate-90" : ""}`}
					size={14}
				/>
			</button>
			{open && (
				<div className="flex flex-col gap-3 pl-6" id={bodyId}>
					<blockquote className="my-0! border-0 border-l-2 border-solid border-edge pl-3 text-text-secondary">
						{value.quote}
					</blockquote>
					<ul className="my-0! flex list-none flex-col gap-2 p-0">
						{value.notes.map((note, index) => (
							<li className="my-0! flex flex-col gap-0.5" key={`${note.by}-${index}`}>
								<span className="text-xs font-semibold text-brand-ink">@{note.by}</span>
								<p className="my-0! whitespace-pre-wrap text-text-primary">{note.text}</p>
							</li>
						))}
					</ul>
					<span className="text-xs text-text-tertiary tabular-nums sm:hidden">
						{value.by && <>Accepted by @{value.by}</>}
						{stamp && ` · ${stamp}`}
					</span>
				</div>
			)}
		</article>
	);
}

export function renderDecision(node: DecisionNode) {
	return <DecisionCard value={node.getDecision()} />;
}
