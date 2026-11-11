import { ChopinMark, Face } from "@chopin/editor";
import { DecisionIcon, DocumentIcon, GlobeSearchIcon, TextStyleIcon } from "@chopin/icons";
import { useEffect } from "react";
import { ComposerPersonItem } from "@/components/assistant-ui/elements/composer";
import { ComposerPopover } from "./assistant-ui/composer-popover";
import { referenceOptionId } from "./reference-picker";

import type { PointerGroup, PointerOption } from "./mention-sources";
import type { MentionCandidate } from "./mentions";

/** Every row `@` offers, in the order the keys move through them: people first, then the parts. */
export type MentionRow =
	| { type: "candidate"; candidate: MentionCandidate }
	| { type: "pointer"; option: PointerOption };

export function mentionRows(
	candidates: readonly MentionCandidate[],
	groups: readonly PointerGroup[],
): MentionRow[] {
	return [
		...candidates.map((candidate): MentionRow => ({ type: "candidate", candidate })),
		...groups.flatMap(group =>
			group.options.map((option): MentionRow => ({ type: "pointer", option }))
		),
	];
}

function pointerIcon(option: PointerOption) {
	switch (option.kind) {
		case "heading":
			return <TextStyleIcon size={14} />;
		case "decision":
			return <DecisionIcon size={14} />;
		case "research":
			return <GlobeSearchIcon size={14} />;
		case "file":
			return <DocumentIcon size={14} />;
	}
}

/** What the tag at the end of a part's row says: a section's level, else what kind of thing it is. */
function pointerTag(option: PointerOption): string {
	return option.meta ?? option.kind;
}

/**
 * The `@` menu over the Chat composer, assistant-ui's Mentions: a small round badge, a name and a
 * tiny tag at the end of each row. Chopin comes first, tagged `agent`, with its mark; the people
 * here follow, tagged `human`, with their GitHub picture; then the document's sections, Decisions
 * and research cards and its repository's files, each tagged with what it is.
 */
export function MentionPicker(
	{
		active,
		groups = [],
		id,
		onActive,
		onSelect,
		onSelectPointer,
		options,
	}: {
		active: number;
		groups?: readonly PointerGroup[];
		id: string;
		onActive: (index: number) => void;
		onSelect: (candidate: MentionCandidate) => void;
		onSelectPointer?: (option: PointerOption) => void;
		options: readonly MentionCandidate[];
	},
) {
	useEffect(() => {
		let frame = requestAnimationFrame(() => {
			document.getElementById(referenceOptionId(id, active))?.scrollIntoView({ block: "nearest" });
		});
		return () => cancelAnimationFrame(frame);
	}, [active, id]);

	let rows = mentionRows(options, groups);
	return (
		<ComposerPopover id={id} kind="mentions" label="Mentions">
			{rows.map((row, index) => {
				let shared = {
					active: index === active,
					"aria-selected": index === active,
					id: referenceOptionId(id, index),
					onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
					onMouseEnter: () => onActive(index),
					role: "option",
					tabIndex: -1,
				};
				if (row.type === "candidate") {
					let candidate = row.candidate;
					let planner = candidate.kind === "planner";
					return (
						<ComposerPersonItem
							{...shared}
							key={candidate.login.toLowerCase()}
							onClick={() => onSelect(candidate)}
							person={{
								name: planner ? "Chopin" : candidate.login,
								role: planner ? "agent" : "human",
								avatar: (
									<span aria-hidden="true">
										{planner
											? <ChopinMark circle />
											: <Face decorative handle={candidate.login} size={20} titled={false} />}
									</span>
								),
							}}
						/>
					);
				}
				let option = row.option;
				return (
					<ComposerPersonItem
						{...shared}
						key={option.id}
						onClick={() => onSelectPointer?.(option)}
						person={{
							name: option.label,
							role: pointerTag(option),
							avatar: <span aria-hidden="true">{pointerIcon(option)}</span>,
						}}
					/>
				);
			})}
		</ComposerPopover>
	);
}
