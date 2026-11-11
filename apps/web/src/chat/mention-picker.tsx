import { ChopinMark, Face } from "@chopin/editor";
import { DecisionIcon, DocumentIcon, GlobeSearchIcon, TextStyleIcon } from "@chopin/icons";
import { useEffect, useId } from "react";

import { ComposerMenuGroup, ComposerPersonItem } from "./assistant-ui/composer-commands";
import { ComposerMenu } from "./assistant-ui/composer-model";
import { referenceOptionId } from "./reference-picker";

import type { MentionCandidate } from "./mentions";
import type { PointerGroup, PointerOption } from "./mention-sources";

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
			return <TextStyleIcon size={16} />;
		case "decision":
			return <DecisionIcon size={16} />;
		case "research":
			return <GlobeSearchIcon size={16} />;
		case "file":
			return <DocumentIcon size={16} />;
	}
}

/**
 * The `@` menu over the Chat composer: Chopin and the people here, then, under their own headings,
 * the document's sections, Decisions and research cards and its repository's files. With nothing
 * but people it is the one plain list it always was.
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
	let headingId = useId();
	useEffect(() => {
		let frame = requestAnimationFrame(() => {
			document.getElementById(referenceOptionId(id, active))?.scrollIntoView({ block: "nearest" });
		});
		return () => cancelAnimationFrame(frame);
	}, [active, id]);

	let people = options.map((option, index) => (
		<ComposerPersonItem
			active={index === active}
			aria-label={option.login}
			id={referenceOptionId(id, index)}
			key={option.login.toLowerCase()}
			lead={option.kind === "planner"
				? <ChopinMark circle />
				: <Face decorative handle={option.login} size={20} titled={false} />}
			name={option.login}
			onClick={() => onSelect(option)}
			onMouseDown={event => event.preventDefault()}
			onMouseEnter={() => onActive(index)}
		/>
	));
	let offset = options.length;
	return (
		<ComposerMenu variant="mentions">
			<div aria-label="Mentions" id={id} role="listbox">
				{groups.length === 0
					? people
					: options.length > 0 && (
						<ComposerMenuGroup id={`${headingId}-people`} label="People">
							{people}
						</ComposerMenuGroup>
					)}
				{groups.map(group => {
					let start = offset;
					offset += group.options.length;
					return (
						<ComposerMenuGroup
							id={`${headingId}-${group.label}`}
							key={group.label}
							label={group.label}
						>
							{group.options.map((option, index) => (
								<ComposerPersonItem
									active={start + index === active}
									id={referenceOptionId(id, start + index)}
									key={option.id}
									lead={pointerIcon(option)}
									meta={option.meta}
									name={option.label}
									onClick={() => onSelectPointer?.(option)}
									onMouseDown={event => event.preventDefault()}
									onMouseEnter={() => onActive(start + index)}
								/>
							))}
						</ComposerMenuGroup>
					);
				})}
			</div>
		</ComposerMenu>
	);
}
