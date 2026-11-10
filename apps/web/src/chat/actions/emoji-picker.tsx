import { useEffect, useId, useMemo, useRef, useState } from "react";

import { firstEmoji } from "../emoji";
import { loadEmoji, searchEmoji } from "./emoji-data";

import type { KeyboardEvent } from "react";
import type { EmojiChoice, EmojiGroup } from "./emoji-data";

const COLUMNS = 8;
const TONES = [
	"\u270B",
	"\u270B\u{1F3FB}",
	"\u270B\u{1F3FC}",
	"\u270B\u{1F3FD}",
	"\u270B\u{1F3FE}",
	"\u270B\u{1F3FF}",
];
const TONE_NAMES = ["Default skin tone", "Light", "Medium light", "Medium", "Medium dark", "Dark"];

export function EmojiPicker({ id, onPick }: { id: string; onPick: (emoji: string) => void }) {
	let field = useRef<HTMLInputElement>(null);
	let grid = useRef<HTMLDivElement>(null);
	let labelId = useId();
	let [query, setQuery] = useState("");
	let [tone, setTone] = useState(0);
	let [active, setActive] = useState(0);
	let [groups, setGroups] = useState<EmojiGroup[]>();
	let typed = firstEmoji(query);
	let searching = query.trim() !== "" && !typed;
	let choices = useMemo<EmojiChoice[]>(
		() => groups && searching ? searchEmoji(query, groups, tone) : [],
		[groups, query, searching, tone],
	);
	let items: EmojiChoice[] = typed
		? [{ emoji: typed, name: typed }]
		: searching
		? choices
		: (groups ?? []).flatMap(group => searchEmoji("", [group], tone));
	let current = Math.min(active, Math.max(0, items.length - 1));

	useEffect(() => {
		let cancelled = false;
		void loadEmoji().then(loaded => {
			if (!cancelled) setGroups(loaded);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	let focusItem = (index: number) => {
		setActive(index);
		requestAnimationFrame(() => {
			let button = grid.current?.querySelectorAll<HTMLButtonElement>("[data-emoji]")[index];
			button?.focus();
			button?.scrollIntoView({ block: "nearest" });
		});
	};
	let gridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		let delta = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS } as Record<
			string,
			number | undefined
		>)[event.key];
		let target = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : undefined;
		if (delta === undefined && target === undefined) return;
		event.preventDefault();
		event.stopPropagation();
		let next = target ?? current + (delta ?? 0);
		if (next < 0) field.current?.focus();
		else focusItem(Math.min(items.length - 1, next));
	};
	let fieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" && items.length > 0) {
			event.preventDefault();
			focusItem(0);
		} else if (event.key === "Enter" && (typed || items.length === 1)) {
			event.preventDefault();
			onPick(typed ?? items[0]!.emoji);
		}
	};

	let button = (choice: EmojiChoice, index: number) => (
		<button
			className="emoji-picker-item"
			data-emoji=""
			key={`${choice.emoji}-${index}`}
			onClick={() => onPick(choice.emoji)}
			onFocus={() => setActive(index)}
			tabIndex={current === index ? 0 : -1}
			type="button"
		>
			{choice.emoji}
		</button>
	);
	let offset = 0;

	return (
		<div
			aria-labelledby={labelId}
			aria-modal="false"
			className="emoji-picker"
			id={id}
			role="dialog"
		>
			<span className="sr-only" id={labelId}>Add reaction</span>
			<input
				aria-label="Search emoji, or paste one"
				autoComplete="off"
				className="emoji-picker-field"
				enterKeyHint="done"
				onChange={event => {
					setQuery(event.target.value);
					setActive(0);
				}}
				onKeyDown={fieldKeyDown}
				placeholder="Search or paste an emoji"
				ref={field}
				spellCheck={false}
				type="text"
				value={query}
			/>
			<div className="emoji-picker-list" onKeyDown={gridKeyDown} ref={grid}>
				{typed && <div className="emoji-picker-grid" role="group">{button(items[0]!, 0)}</div>}
				{!typed && searching && choices.length > 0 && (
					<div className="emoji-picker-grid" role="group">
						{choices.map((choice, index) =>
							button(choice, index)
						)}
					</div>
				)}
				{!typed && !searching && groups?.map(group => {
					let start = offset;
					offset += group.entries.length;
					return (
						<div className="emoji-picker-group" key={group.label}>
							<p className="emoji-picker-heading">{group.label}</p>
							<div aria-label={group.label} className="emoji-picker-grid" role="group">
								{group.entries.map((entry, index) =>
									button(
										{
											emoji: tone > 0 ? entry.tones?.[tone - 1] ?? entry.emoji : entry.emoji,
											name: entry.name,
										},
										start + index,
									)
								)}
							</div>
						</div>
					);
				})}
				{!typed && !groups && <p className="emoji-picker-empty" role="status">Loading emoji</p>}
				{!typed && searching && groups && choices.length === 0 && (
					<p className="emoji-picker-empty" role="status">No emoji found</p>
				)}
			</div>
			<div aria-label="Skin tone" className="emoji-picker-tones" role="group">
				{TONES.map((glyph, index) => (
					<button
						aria-label={TONE_NAMES[index]}
						aria-pressed={tone === index}
						className="emoji-picker-tone"
						key={glyph}
						onClick={() => setTone(index)}
						type="button"
					>
						{glyph}
					</button>
				))}
			</div>
		</div>
	);
}
