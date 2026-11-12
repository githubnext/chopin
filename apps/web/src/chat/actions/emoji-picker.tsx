import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
	BallIcon,
	CarIcon,
	ClockIcon,
	CupIcon,
	FlagIcon,
	HeartIcon,
	LeafIcon,
	LightbulbIcon,
	MagnifierIcon,
	SmileyIcon,
} from "@chopin/icons";

import { firstEmoji } from "../emoji";
import { emojiIndex, loadEmoji, searchEmoji, shownAt } from "./emoji-data";
import { frequent, readTone, readUses, writeTone } from "./emoji-frequent";
import { moveInGrid } from "./emoji-grid";
import "./emoji-picker.css";

import type { IconProps } from "@chopin/icons";
import type { KeyboardEvent, ReactElement } from "react";
import type { CategoryId, EmojiChoice, EmojiGroup } from "./emoji-data";

const COLUMNS = 9;
const TONES = [
	"\u270B",
	"\u270B\u{1F3FB}",
	"\u270B\u{1F3FC}",
	"\u270B\u{1F3FD}",
	"\u270B\u{1F3FE}",
	"\u270B\u{1F3FF}",
];
const TONE_NAMES = ["Default skin tone", "Light", "Medium light", "Medium", "Medium dark", "Dark"];

type SectionId = "frequent" | CategoryId;
const TABS: readonly { id: SectionId; label: string; Icon: (props: IconProps) => ReactElement }[] =
	[
		{ id: "frequent", label: "Frequently used", Icon: ClockIcon },
		{ id: "people", label: "Smileys and people", Icon: SmileyIcon },
		{ id: "nature", label: "Animals and nature", Icon: LeafIcon },
		{ id: "food", label: "Food and drink", Icon: CupIcon },
		{ id: "activity", label: "Activities", Icon: BallIcon },
		{ id: "travel", label: "Travel and places", Icon: CarIcon },
		{ id: "objects", label: "Objects", Icon: LightbulbIcon },
		{ id: "symbols", label: "Symbols", Icon: HeartIcon },
		{ id: "flags", label: "Flags", Icon: FlagIcon },
	];

type Section = { id: string; label: string; items: EmojiChoice[] };

/**
 * Slack's emoji picker, in Chopin's colours: a search field, a row of category tabs whose marker
 * follows the scroll, sticky headings over a grid of the platform's own emoji (Frequently used
 * first), and a footer that previews the emoji under the pointer or the focus by its Slack name,
 * beside the hand that chooses the skin tone, which is remembered.
 */
export function EmojiPicker({ id, onPick }: { id: string; onPick: (emoji: string) => void }) {
	let field = useRef<HTMLInputElement>(null);
	let list = useRef<HTMLDivElement>(null);
	let toneButton = useRef<HTMLButtonElement>(null);
	let chooser = useRef<HTMLDivElement>(null);
	let base = useId();
	let labelId = `${base}-label`;
	let [query, setQuery] = useState("");
	let [tone, setTone] = useState(readTone);
	let [toneOpen, setToneOpen] = useState(false);
	let [active, setActive] = useState(0);
	let [hovered, setHovered] = useState<EmojiChoice>();
	let [visible, setVisible] = useState<SectionId>("frequent");
	let [groups, setGroups] = useState<EmojiGroup[]>();
	let [uses] = useState(readUses);
	let index = useMemo(() => groups ? emojiIndex(groups) : new Map<string, EmojiChoice>(), [groups]);
	let typed = firstEmoji(query);
	let searching = query.trim() !== "" && !typed;

	let sections = useMemo<Section[]>(() => {
		if (typed) return [{ id: "typed", label: "Emoji", items: [{ emoji: typed, name: typed }] }];
		if (!groups) return [];
		if (searching) {
			return [{ id: "results", label: "Search results", items: searchEmoji(query, groups, tone) }];
		}
		return [
			{
				id: "frequent",
				label: "Frequently used",
				items: frequent(uses).map(emoji => index.get(emoji) ?? { emoji, name: emoji }),
			},
			...groups.map(group => ({
				id: group.id,
				label: group.label,
				items: group.entries.map(entry => shownAt(entry, tone)),
			})),
		];
	}, [groups, index, query, searching, tone, typed, uses]);
	let items = useMemo(() => sections.flatMap(section => section.items), [sections]);
	let sizes = sections.map(section => section.items.length);
	let current = Math.min(active, Math.max(0, items.length - 1));
	let preview = hovered ?? items[current];

	// The picker loads after its panel is placed, so it takes the focus itself once it is drawn.
	useEffect(() => {
		field.current?.focus({ preventScroll: true });
	}, []);

	useEffect(() => {
		let cancelled = false;
		void loadEmoji().then(loaded => {
			if (!cancelled) setGroups(loaded);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (toneOpen) chooser.current?.querySelector<HTMLButtonElement>("[aria-pressed=true]")?.focus();
	}, [toneOpen]);

	let focusItem = (next: number) => {
		setActive(next);
		requestAnimationFrame(() => {
			let button = list.current?.querySelectorAll<HTMLButtonElement>("[data-emoji]")[next];
			button?.focus({ preventScroll: true });
			button?.scrollIntoView({ block: "nearest" });
		});
	};
	let gridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		let next = moveInGrid(sizes, current, event.key, COLUMNS);
		if (next === undefined) field.current?.focus();
		else focusItem(next);
	};
	let fieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" && items.length > 0) {
			event.preventDefault();
			focusItem(0);
		} else if (event.key === "Enter" && (typed || (searching && items.length > 0))) {
			event.preventDefault();
			onPick(typed ?? items[0]!.emoji);
		}
	};
	let tabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		let move = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number | undefined>)[event.key];
		if (move === undefined) return;
		event.preventDefault();
		let tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")];
		let at = tabs.indexOf(document.activeElement as HTMLButtonElement);
		tabs[(at + move + tabs.length) % tabs.length]?.focus();
	};

	// The tab marked is the section at the top of the list, as the list scrolls.
	let spy = () => {
		let scroller = list.current;
		if (!scroller || searching || typed) return;
		let top = scroller.getBoundingClientRect().top;
		let at: SectionId = "frequent";
		for (let section of scroller.querySelectorAll<HTMLElement>("[data-emoji-section]")) {
			if (section.getBoundingClientRect().top - top > 8) break;
			at = section.dataset.emojiSection as SectionId;
		}
		setVisible(current => current === at ? current : at);
	};
	let jump = (section: SectionId) => {
		setQuery("");
		setVisible(section);
		requestAnimationFrame(() => {
			let scroller = list.current;
			let target = scroller?.querySelector<HTMLElement>(`[data-emoji-section="${section}"]`);
			if (!scroller || !target) return;
			let reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
			scroller.scrollTo({
				top: target.offsetTop,
				behavior: reduce ? "auto" : "smooth",
			});
		});
	};
	let chooseTone = (next: number) => {
		setTone(next);
		writeTone(next);
		setToneOpen(false);
		requestAnimationFrame(() => toneButton.current?.focus());
	};

	let offset = 0;
	let loading = !typed && !groups;
	let empty = searching && groups && items.length === 0;

	return (
		<div
			aria-labelledby={labelId}
			aria-modal="false"
			className="emoji-picker"
			id={id}
			role="dialog"
		>
			<span className="sr-only" id={labelId}>Add reaction</span>
			<label className="emoji-picker-search">
				<MagnifierIcon aria-hidden="true" />
				<input
					aria-label="Search emoji, or paste one"
					autoComplete="off"
					className="emoji-picker-field"
					enterKeyHint="done"
					onChange={event => {
						setQuery(event.target.value);
						setActive(0);
						setHovered(undefined);
						list.current?.scrollTo({ top: 0 });
					}}
					onKeyDown={fieldKeyDown}
					placeholder="Search all emoji"
					ref={field}
					spellCheck={false}
					type="text"
					value={query}
				/>
			</label>
			<div
				aria-label="Emoji categories"
				className="emoji-picker-tabs"
				onKeyDown={tabKeyDown}
				role="tablist"
			>
				{TABS.map(({ id: tab, label, Icon }) => {
					let selected = !searching && !typed && visible === tab;
					return (
						<button
							aria-label={label}
							aria-selected={selected}
							className="emoji-picker-tab"
							data-tooltip={label}
							key={tab}
							onClick={() => jump(tab)}
							role="tab"
							tabIndex={visible === tab ? 0 : -1}
							type="button"
						>
							<Icon aria-hidden="true" />
						</button>
					);
				})}
			</div>
			<div
				className="emoji-picker-list"
				onKeyDown={gridKeyDown}
				onMouseLeave={() => setHovered(undefined)}
				onScroll={spy}
				ref={list}
			>
				{sections.map(section => {
					let start = offset;
					offset += section.items.length;
					if (section.items.length === 0) return null;
					let heading = `${base}-${section.id}`;
					return (
						<section
							aria-labelledby={heading}
							className="emoji-picker-group"
							data-emoji-section={section.id}
							key={section.id}
						>
							<h3 className="emoji-picker-heading" id={heading}>{section.label}</h3>
							<div aria-labelledby={heading} className="emoji-picker-grid" role="group">
								{section.items.map((choice, at) => {
									let position = start + at;
									return (
										<button
											className="emoji-picker-item"
											data-emoji=""
											key={`${choice.emoji}-${position}`}
											onClick={() => onPick(choice.emoji)}
											onFocus={() => {
												setActive(position);
												setHovered(undefined);
											}}
											onMouseEnter={() => setHovered(choice)}
											tabIndex={current === position ? 0 : -1}
											type="button"
										>
											{choice.emoji}
										</button>
									);
								})}
							</div>
						</section>
					);
				})}
				{loading && <p className="emoji-picker-empty" role="status">Loading emoji</p>}
				{empty && <p className="emoji-picker-empty" role="status">No emoji found</p>}
			</div>
			<div className="emoji-picker-footer">
				{toneOpen
					? (
						<div
							aria-label="Skin tone"
							className="emoji-picker-tones"
							ref={chooser}
							role="group"
						>
							{TONES.map((glyph, at) => (
								<button
									aria-label={TONE_NAMES[at]}
									aria-pressed={tone === at}
									className="emoji-picker-tone"
									key={glyph}
									onClick={() => chooseTone(at)}
									type="button"
								>
									{glyph}
								</button>
							))}
						</div>
					)
					: (
						<div aria-hidden="true" className="emoji-picker-preview">
							{preview && (
								<>
									<span className="emoji-picker-preview-emoji">{preview.emoji}</span>
									<span className="emoji-picker-preview-name">
										{preview.shortcode ?? preview.name}
									</span>
								</>
							)}
						</div>
					)}
				{!toneOpen && (
					<button
						aria-label={`Skin tone: ${TONE_NAMES[tone]}`}
						className="emoji-picker-tone emoji-picker-tone-button"
						data-tooltip="Skin tone"
						onClick={() => setToneOpen(true)}
						ref={toneButton}
						type="button"
					>
						{TONES[tone]}
					</button>
				)}
			</div>
		</div>
	);
}
