import { ChopinMark, Face } from "@chopin/editor";
import { useEffect } from "react";

import { ComposerMenu, ComposerMenuItem } from "./assistant-ui/composer-model";
import { referenceOptionId } from "./reference-picker";

import type { MentionCandidate } from "./mentions";

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
		<ComposerMenu variant="mentions">
			<div aria-label="Mentions" id={id} role="listbox">
				{options.map((option, index) => (
					<ComposerMenuItem
						active={index === active}
						aria-label={option.login}
						id={referenceOptionId(id, index)}
						key={option.login.toLowerCase()}
						onClick={() => onSelect(option)}
						onMouseDown={event => event.preventDefault()}
						onMouseEnter={() => onActive(index)}
						selected={index === active}
					>
						{option.kind === "planner"
							? (
								<span aria-hidden="true" className="flex shrink-0">
									<ChopinMark circle />
								</span>
							)
							: <Face decorative handle={option.login} size={20} titled={false} />}
						<span className="min-w-0 flex-1 truncate">{option.login}</span>
					</ComposerMenuItem>
				))}
			</div>
		</ComposerMenu>
	);
}
