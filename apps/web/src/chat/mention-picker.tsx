import { ChopinMark, Face, PLANNER_NAME } from "@chopin/editor";
import { useEffect } from "react";
import { ComposerPersonItem } from "@/components/assistant-ui/elements/composer";
import { ComposerPopover } from "./assistant-ui/composer-popover";
import { referenceOptionId } from "./reference-picker";

import { PRESENCE_WORDS } from "./planner-status";

import "./presence-dot.css";

import type { MentionCandidate } from "./mentions";
import type { PlannerPresence } from "./planner-status";

/**
 * The `@` menu over the Chat composer, assistant-ui's Mentions: a small round badge, a name and a
 * tiny tag at the end of each row. Chopin comes first, tagged `agent`, with its mark; the people
 * who can read the document follow, those here first, tagged `human`, with their GitHub picture.
 * Chopin's mark carries its presence as Slack's picker does a person's (`presence-dot.css`), with
 * the state in its name. The document's parts are `#`'s.
 */
export function MentionPicker(
	{
		active,
		id,
		onActive,
		onSelect,
		options,
		presence,
	}: {
		active: number;
		id: string;
		onActive: (index: number) => void;
		onSelect: (candidate: MentionCandidate) => void;
		options: readonly MentionCandidate[];
		/** Chopin's presence, where the document's Planner runs on a machine. */
		presence?: PlannerPresence;
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
				let name = planner ? PLANNER_NAME : candidate.login;
				return (
					<ComposerPersonItem
						active={index === active}
						aria-label={planner && presence
							? `${name}, agent, ${PRESENCE_WORDS[presence]}`
							: undefined}
						aria-selected={index === active}
						id={referenceOptionId(id, index)}
						key={candidate.login.toLowerCase()}
						onClick={() => onSelect(candidate)}
						onMouseDown={(event: { preventDefault: () => void }) => event.preventDefault()}
						onMouseEnter={() => onActive(index)}
						person={{
							name,
							role: planner ? "agent" : "human",
							avatar: (
								<>
									<span aria-hidden="true" className="presence-host">
										{planner
											? <ChopinMark circle />
											: <Face decorative handle={candidate.login} size={20} titled={false} />}
										{planner && presence && (
											<span className="presence-dot" data-presence={presence} />
										)}
									</span>
								</>
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
