import { useEffect, useRef, useState } from "react";

import type { KeyboardEvent, ReactNode, RefObject } from "react";

/**
 * A palette's result list with roving focus. One row is active at a time: the
 * keyboard, the pointer, and a non-empty query (which pre-highlights the first
 * enabled row so Enter acts on it from the field) all move the same highlight.
 */
export function PaletteListbox<T>(
	{
		enabled = () => true,
		input,
		itemKey,
		items,
		label,
		onChoose,
		query,
		renderItem,
		itemLabel,
	}: {
		enabled?: (item: T) => boolean;
		input: RefObject<HTMLInputElement | null>;
		itemKey: (item: T) => string;
		items: T[];
		label: string;
		onChoose: (item: T) => void;
		query: string;
		renderItem: (item: T) => ReactNode;
		itemLabel?: (item: T) => string | undefined;
	},
) {
	let list = useRef<HTMLDivElement>(null);
	let [active, setActive] = useState<number>();
	let usable = items.flatMap((item, index) => enabled(item) ? [index] : []);
	let typed = query.trim() !== "";
	let first = usable[0];

	// A new query or result set re-anchors the highlight on the first match.
	let signature = `${query}\u0000${items.map(itemKey).join("\u0000")}`;
	useEffect(() => {
		setActive(typed ? first : undefined);
	}, [signature]);

	let rows = () => Array.from(list.current?.querySelectorAll<HTMLElement>("[role=option]") ?? []);

	function focusRow(index: number | undefined) {
		if (index === undefined) return;
		setActive(index);
		let row = rows()[index];
		row?.focus();
		row?.scrollIntoView({ block: "nearest" });
	}

	function returnToField() {
		setActive(typed ? first : undefined);
		list.current?.closest(".navigation-palette-list")?.scrollTo({ top: 0 });
		input.current?.focus();
	}

	// The field stays a plain text box; it hands the keyboard to the list.
	useEffect(() => {
		let field = input.current;
		if (!field) return;
		let onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				let next = active === undefined ? first : usable.find(index => index > active);
				focusRow(next ?? active);
			} else if (event.key === "Enter" && active !== undefined && !event.isComposing) {
				event.preventDefault();
				onChoose(items[active]!);
			}
		};
		field.addEventListener("keydown", onKey);
		return () => field.removeEventListener("keydown", onKey);
	});

	function rowKey(event: KeyboardEvent<HTMLElement>, index: number) {
		let position = usable.indexOf(index);
		let target: number | undefined;
		if (event.key === "ArrowDown") target = usable[position + 1] ?? index;
		else if (event.key === "ArrowUp") {
			event.preventDefault();
			if (position <= 0) returnToField();
			else focusRow(usable[position - 1]);
			return;
		} else if (event.key === "Home") target = usable[0];
		else if (event.key === "End") target = usable.at(-1);
		else if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			onChoose(items[index]!);
			return;
		} else return;
		event.preventDefault();
		focusRow(target);
	}

	let tabStop = active ?? first;
	return (
		<div
			aria-label={label}
			className="navigation-palette-options"
			ref={list}
			role="listbox"
		>
			{items.map((item, index) => {
				let on = enabled(item);
				return (
					<div
						aria-disabled={on ? undefined : true}
						aria-label={itemLabel?.(item)}
						aria-selected={index === active}
						className="navigation-palette-option"
						key={itemKey(item)}
						onClick={() => on && onChoose(item)}
						onFocus={() => on && setActive(index)}
						onKeyDown={event => on && rowKey(event, index)}
						onPointerMove={event => {
							if (!on || event.pointerType !== "mouse" || index === active) return;
							setActive(index);
							// Keep Enter acting on the highlighted row wherever focus already sits.
							if (document.activeElement?.getAttribute("role") === "option") {
								event.currentTarget.focus({ preventScroll: true });
							}
						}}
						role="option"
						tabIndex={on && index === tabStop ? 0 : -1}
					>
						{renderItem(item)}
					</div>
				);
			})}
		</div>
	);
}
