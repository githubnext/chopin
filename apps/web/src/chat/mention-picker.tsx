import { ChopinMark } from "./agent-mark";
import { useEffect, useState } from "react";

import { referenceOptionId } from "./reference-picker";

import type { MentionCandidate } from "./mentions";

/** At most this many rows show before the list scrolls: 8 × 2rem plus the 0.25rem padding. */
const LIST_HEIGHT = "16.5rem";

function Avatar({ login }: { login: string }) {
	let [failed, setFailed] = useState(false);
	if (failed) {
		return (
			<span
				aria-hidden="true"
				className="grid size-5 shrink-0 place-items-center rounded-md bg-selected text-xs font-medium text-text-secondary uppercase"
			>
				{login[0]}
			</span>
		);
	}
	return (
		<img
			alt=""
			className="block size-5 shrink-0 rounded-md bg-selected"
			onError={() => setFailed(true)}
			referrerPolicy="no-referrer"
			src={`https://github.com/${encodeURIComponent(login)}.png?size=40`}
		/>
	);
}

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
			className="absolute bottom-full left-2.5 z-30 mb-1 w-max min-w-48 max-w-[calc(100%-1.25rem)] overflow-y-auto rounded-lg bg-page p-1 ring-hairline shadow-resting-strong"
			data-chat-mention-picker=""
			data-focus-boundary=""
			style={{ maxHeight: `min(${LIST_HEIGHT}, 45dvh, 45vh)` }}
		>
			<div aria-label="Mentions" id={id} role="listbox">
				{options.map((option, index) => (
					<button
						aria-label={option.login}
						aria-selected={index === active}
						className={`flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm ${
							index === active ? "bg-selected" : "hover:bg-hover"
						}`}
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
							: <Avatar login={option.login} />}
						<span className="min-w-0 flex-1 truncate">{option.login}</span>
					</button>
				))}
			</div>
		</div>
	);
}
