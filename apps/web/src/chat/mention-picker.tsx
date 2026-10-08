import { ChopinMark } from "./agent-mark";
import { Face } from "@chopin/editor";
import { useEffect } from "react";

import { referenceOptionId } from "./reference-picker";

import type { MentionCandidate } from "./mentions";

/** At most this many rows show before the list scrolls: 8 × 2rem plus the 0.25rem padding. */
const LIST_HEIGHT = "16.5rem";

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
		<div
			className="absolute bottom-full left-2.5 z-30 mb-1 w-max min-w-48 max-w-[calc(100%-1.25rem)] overflow-y-auto menu-surface"
			data-chat-mention-picker=""
			data-menu-enter=""
			data-focus-boundary=""
			style={{ maxHeight: `min(${LIST_HEIGHT}, 45dvh, 45vh)` }}
		>
			<div aria-label="Mentions" id={id} role="listbox">
				{options.map((option, index) => (
					<button
						aria-label={option.login}
						aria-selected={index === active}
						className="menu-item"
						data-active={index === active || undefined}
						id={referenceOptionId(id, index)}
						key={option.login.toLowerCase()}
						onClick={() => onSelect(option)}
						onMouseDown={event => event.preventDefault()}
						onMouseEnter={() => onActive(index)}
						role="option"
						tabIndex={-1}
						type="button"
					>
						{option.kind === "planner"
							? (
								<span aria-hidden="true" className="flex shrink-0">
									<ChopinMark circle />
								</span>
							)
							: <Face decorative handle={option.login} size={20} titled={false} />}
						<span className="min-w-0 flex-1 truncate">{option.login}</span>
					</button>
				))}
			</div>
		</div>
	);
}
