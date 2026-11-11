import { ChopinMark, Face } from "@chopin/editor";
import { useEffect } from "react";
import { ComposerPersonItem } from "@/components/assistant-ui/elements/composer";
import { ComposerPopover } from "./assistant-ui/composer-popover";
import { referenceOptionId } from "./reference-picker";

import type { MentionCandidate } from "./mentions";

/**
 * The `@` menu over the Chat composer, assistant-ui's Mentions: a small round badge, a name and a
 * tiny tag at the end of each row. Chopin comes first, tagged `agent`, with its mark; the people
 * who can read the document follow, those here first, tagged `human`, with their GitHub picture.
 * The document's parts are `#`'s.
 */
export function MentionPicker(
	{
		active,
		id,
		onActive,
		onSelect,
		options,
	}: {
		active: number;
		id: string;
		onActive: (index: number) => void;
		onSelect: (candidate: MentionCandidate) => void;
		options: readonly MentionCandidate[];
	},
) {
	useEffect(() => {
		let frame = requestAnimationFrame(() => {
			document.getElementById(referenceOptionId(id, active))?.scrollIntoView({ block: "nearest" });
		});
		return () => cancelAnimationFrame(frame);
	}, [active, id]);

	return (
		<ComposerPopover id={id} kind="mentions" label="Mentions">
			{options.map((candidate, index) => {
				let planner = candidate.kind === "planner";
				return (
					<ComposerPersonItem
						active={index === active}
						aria-selected={index === active}
						id={referenceOptionId(id, index)}
						key={candidate.login.toLowerCase()}
						onClick={() => onSelect(candidate)}
						onMouseDown={(event: { preventDefault: () => void }) => event.preventDefault()}
						onMouseEnter={() => onActive(index)}
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
						role="option"
						tabIndex={-1}
					/>
				);
			})}
		</ComposerPopover>
	);
}
