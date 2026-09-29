/**
 * A fence's language, chosen from the app's own menu.
 *
 * The trigger is a ghost button and the list is a portalled listbox styled
 * like every other picker, rather than the operating system's select. The
 * panel lives on `body`, outside the contenteditable, so opening it never
 * moves the caret and the editor's clipping never crops it.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronIcon } from "@chopin/icons";

import { useTransitionPresence } from "../transition-presence";

import type { CSSProperties, KeyboardEvent } from "react";

export type LanguageOption = readonly [id: string, label: string];

const GAP = 4;
const MARGIN = 8;
const MAX_HEIGHT = 288;

export function LanguageMenu(
	{ disabled, onChange, options, value }: {
		disabled?: boolean;
		onChange: (value: string) => void;
		options: readonly LanguageOption[];
		value: string;
	},
) {
	let [open, setOpen] = useState(false);
	// By id, not index: a collaborator can add or remove the unlisted-language row.
	let [activeId, setActiveId] = useState(value);
	let [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
	let trigger = useRef<HTMLButtonElement>(null);
	let panel = useRef<HTMLDivElement>(null);
	let listId = useId();
	let presence = useTransitionPresence(open ? true : undefined, 150, false);
	let selected = Math.max(0, options.findIndex(([id]) => id === value));
	let found = options.findIndex(([id]) => id === activeId);
	let active = found < 0 ? selected : found;
	let setActive = (next: number | ((index: number) => number)) => {
		let index = typeof next === "function" ? next(active) : next;
		let option = options[index];
		if (option) setActiveId(option[0]);
	};
	let label = options[selected]?.[1] ?? value;

	useLayoutEffect(() => {
		if (!open) return;
		let place = (event?: Event) => {
			// The menu's own scrolling must not reposition it.
			if (event?.target instanceof Node && panel.current?.contains(event.target)) return;
			let rect = trigger.current?.getBoundingClientRect();
			if (!rect) return;
			let below = window.innerHeight - rect.bottom - GAP - MARGIN;
			let above = rect.top - GAP - MARGIN;
			let height = Math.min(MAX_HEIGHT, Math.max(below, above));
			let flip = below < Math.min(MAX_HEIGHT, panel.current?.scrollHeight ?? MAX_HEIGHT)
				&& above > below;
			setPosition({
				left: Math.max(MARGIN, rect.left),
				maxHeight: height,
				top: flip ? undefined : rect.bottom + GAP,
				bottom: flip ? window.innerHeight - rect.top + GAP : undefined,
				transformOrigin: flip ? "bottom left" : "top left",
				visibility: "visible",
			});
		};
		place();
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open]);

	// Keep the highlighted option in view as the keyboard moves through a long list.
	useEffect(() => {
		if (!open) return;
		panel.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [open, active]);

	useEffect(() => {
		if (!open) return;
		let dismiss = (event: PointerEvent) => {
			let target = event.target as Node;
			if (panel.current?.contains(target) || trigger.current?.contains(target)) return;
			setOpen(false);
		};
		document.addEventListener("pointerdown", dismiss, true);
		return () => document.removeEventListener("pointerdown", dismiss, true);
	}, [open]);

	let show = () => {
		setActiveId(value);
		setOpen(true);
		requestAnimationFrame(() => panel.current?.focus());
	};

	let close = () => {
		setOpen(false);
		trigger.current?.focus();
	};

	let choose = (index: number) => {
		let option = options[index];
		if (option && option[0] !== value) onChange(option[0]);
		close();
	};

	let onKey = (event: KeyboardEvent) => {
		let last = options.length - 1;
		let step: Record<string, () => void> = {
			ArrowDown: () => setActive(index => Math.min(last, index + 1)),
			ArrowUp: () => setActive(index => Math.max(0, index - 1)),
			Home: () => setActive(0),
			End: () => setActive(last),
			Enter: () => choose(active),
			" ": () => choose(active),
			Escape: () => close(),
		};
		// The panel is portalled to the end of body, so hand focus back to the
		// trigger and let the browser's default Tab continue from there.
		if (event.key === "Tab") {
			setOpen(false);
			trigger.current?.focus();
			return;
		}
		let action = step[event.key];
		if (action) {
			event.preventDefault();
			event.stopPropagation();
			action();
			return;
		}
		// Type to jump, as a native select does.
		if (event.key.length === 1) {
			let letter = event.key.toLowerCase();
			let found = options.findIndex(([, name], index) =>
				index > active && name.toLowerCase().startsWith(letter)
			);
			if (found < 0) found = options.findIndex(([, name]) => name.toLowerCase().startsWith(letter));
			if (found >= 0) setActive(found);
		}
	};

	return (
		<>
			<button
				aria-controls={open ? listId : undefined}
				aria-expanded={open}
				aria-haspopup="listbox"
				aria-label={`Code language: ${label}`}
				className="plan-code-language btn btn-sm btn-ghost gap-1 text-text-tertiary"
				disabled={disabled}
				onClick={() => (open ? close() : show())}
				onKeyDown={event => {
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						show();
					}
				}}
				// Keep the caret where it is; see the source toggle beside it.
				onMouseDown={event => event.preventDefault()}
				ref={trigger}
				type="button"
			>
				{label}
				<ChevronIcon aria-hidden="true" className="rotate-90" />
			</button>
			{presence.phase !== "closed" && createPortal(
				<div
					aria-activedescendant={`${listId}-${active}`}
					aria-label="Code language"
					className={`plan-language-menu motion-dropdown ${presence.className} fixed z-50 min-w-40 overflow-y-auto rounded-lg bg-page p-1 ring-hairline shadow-overlay`}
					id={listId}
					onKeyDown={onKey}
					ref={panel}
					role="listbox"
					style={position}
					tabIndex={-1}
				>
					{options.map(([id, name], index) => (
						<div
							aria-selected={index === selected}
							className={`motion-picker-option flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm ${
								index === active ? "bg-selected" : ""
							}`}
							data-index={index}
							id={`${listId}-${index}`}
							key={id || "plain"}
							onClick={() => choose(index)}
							onPointerMove={() => setActive(index)}
							role="option"
						>
							<span className="min-w-0 flex-1 truncate">{name}</span>
							{index === selected && (
								<CheckIcon aria-hidden="true" className="shrink-0 text-brand-ink" size={14} />
							)}
						</div>
					))}
				</div>,
				document.body,
			)}
		</>
	);
}
