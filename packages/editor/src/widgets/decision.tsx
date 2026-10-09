/**
 * Accepted comment threads, in the prose.
 *
 * Accepted threads are durable plan content, rendered from their frozen record.
 * Collapsed they are one line that states the outcome; the quote and thread open on demand.
 */

import { useCellValue } from "@mdxeditor/gurx";
import { useId, useState } from "react";

import { ChevronIcon, MessageIcon } from "@chopin/icons";

import { when } from "../card";
import { MotionDisclosure, MotionDisclosureIcon } from "../disclosure-motion";
import { widgets$ } from "../widget-options";

import type { Decision, DecisionNode } from "@chopin/dialect";
import type { MotionDisclosureContract } from "../disclosure-motion";

export function DecisionCard(
	{ defaultOpen = false, immediately = false, motion, value }: {
		defaultOpen?: boolean;
		immediately?: boolean;
		motion?: MotionDisclosureContract;
		value: Decision;
	},
) {
	let [open, setOpen] = useState(defaultOpen);
	let bodyId = useId();
	let stamp = value.at === undefined ? "" : when(value.at);
	let outcome = value.notes.at(-1)?.text ?? value.quote;
	let body = (
		<div className="flex flex-col gap-3 pb-1 pl-6">
			<blockquote>{value.quote}</blockquote>
			<ul className="flex list-none flex-col gap-2">
				{value.notes.map((note, index) => (
					<li className="flex flex-col gap-0.5" key={`${note.by}-${index}`}>
						<span className="text-xs font-semibold text-brand-ink">@{note.by}</span>
						<p className="whitespace-pre-wrap text-text-primary">{note.text}</p>
					</li>
				))}
			</ul>
			<span className="text-xs text-text-tertiary tabular-nums sm:hidden">
				{value.by && <>Accepted by @{value.by}</>}
				{stamp && ` · ${stamp}`}
			</span>
		</div>
	);

	return (
		<article
			aria-label="Accepted comment"
			className="flex flex-col text-sm"
			data-card-settled=""
			data-plan-comment-card
		>
			<button
				aria-controls={open ? bodyId : undefined}
				aria-expanded={open}
				className="plan-comment-row flex min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1 py-1.5 text-left text-sm text-text-secondary"
				onClick={() => setOpen(current => !current)}
				type="button"
			>
				<MessageIcon aria-hidden="true" className="shrink-0" size={14} />
				<span className="min-w-0 flex-1 truncate">
					Accepted · <span className="text-text-primary">{outcome}</span>
				</span>
				<span className="hidden shrink-0 text-xs text-text-tertiary tabular-nums sm:inline">
					{value.by && <>@{value.by}</>}
					{stamp && ` · ${stamp}`}
				</span>
				<MotionDisclosureIcon
					className="editor-motion-feedback shrink-0 text-text-tertiary"
					closed={<ChevronIcon size={14} />}
					open={open}
					opened={<ChevronIcon className="rotate-90" size={14} />}
				/>
			</button>
			{motion
				? (
					<MotionDisclosure
						id={bodyId}
						immediately={immediately}
						motion={motion}
						open={open}
						surface="accepted-comment"
					>
						{body}
					</MotionDisclosure>
				)
				: open && <div id={bodyId}>{body}</div>}
		</article>
	);
}

function AcceptedComment({ value }: { value: Decision }) {
	let options = useCellValue(widgets$);
	return (
		<DecisionCard
			immediately={options.motionImmediately?.() ?? false}
			motion={options.disclosureMotion}
			value={value}
		/>
	);
}

export function renderDecision(node: DecisionNode) {
	return <AcceptedComment value={node.getDecision()} />;
}
