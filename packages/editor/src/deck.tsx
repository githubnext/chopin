// packages/editor/src/deck.tsx
/**
 * Several decisions worked through one at a time.
 *
 * The top card is the only live one; the cards behind show a header edge and
 * are inert. Order is the reader's own and never leaves this component.
 *
 * Keys are handled with a native listener because Lexical listens on the
 * content-editable root natively, above React's root, and would otherwise move
 * the caret before a synthetic handler could stop it.
 */

import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowLeftIcon, ArrowRightIcon } from "@chopin/icons";

import { arrange, bringForward, cycle, PEEKS, position, settle, slot } from "./deck-order";

import type { CSSProperties, ReactNode } from "react";

import "./deck.css";

export type DeckItem = {
	id: string;
	/** Answered, discarded or expired: kept behind the open cards. */
	settled: boolean;
	/** The decision's header, for the slide name and announcements. */
	label: string;
	card: ReactNode;
};

export type DeckProps = {
	items: DeckItem[];
	label: string;
	/** Whether to skip the shuffle. Defaults to the reduced-motion preference. */
	reduced?: () => boolean;
	className?: string;
};

export const DECK_FRONT_EVENT = "chopin:deck-front";

/** Bring the deck member that contains `element` to the top, synchronously. */
export function revealDeckItem(element: Element): void {
	let slotElement = element.closest<HTMLElement>("[data-deck-slot]");
	slotElement?.dispatchEvent(
		new CustomEvent(DECK_FRONT_EVENT, { bubbles: true, detail: slotElement.dataset.deckSlot }),
	);
}

export function deckKey(key: string, target: "control" | "slot" | "other"): 1 | -1 | undefined {
	if (target === "other") return undefined;
	if (key === "ArrowRight") return 1;
	if (key === "ArrowLeft") return -1;
	return undefined;
}

export function deckAnnouncement(
	kind: "cycle" | "settle",
	index: number,
	total: number,
	label: string,
): string {
	return kind === "cycle"
		? `Decision ${index} of ${total}: ${label}`
		: `Decided. Now showing ${index} of ${total}: ${label}`;
}

/** Used by the animated shuffle in the next change. */
export function prefersReduced(): boolean {
	return typeof matchMedia === "function"
		&& matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Deck({ className, items, label }: DeckProps) {
	let [order, setOrder] = useState(() => settle(arrange([], items), items));
	let current = arrange(order, items);
	let [announcement, setAnnouncement] = useState("");
	let root = useRef<HTMLDivElement>(null);
	let slots = useRef(new Map<string, HTMLElement>());
	let stageId = useId();
	let byId = new Map(items.map(item => [item.id, item]));
	let top = current[0];
	let decided = items.filter(item => item.settled).length;

	let reorder = (next: string[], kind: "cycle" | "settle") => {
		setOrder(next);
		let first = byId.get(next[0] ?? "");
		if (first) {
			setAnnouncement(deckAnnouncement(kind, position(items, first.id), items.length, first.label));
		}
	};

	// Task 4 replaces this effect's body with the timed, animated settle.
	useEffect(() => {
		let settled = settle(current, items);
		if (settled.join() !== current.join()) reorder(settled, "settle");
	});

	useEffect(() => {
		let element = root.current;
		if (!element) return;
		let keydown = (event: KeyboardEvent) => {
			let target = event.target as HTMLElement;
			let kind: "control" | "slot" | "other" = target.closest("[data-deck-control]")
				? "control"
				: target.matches("[data-deck-slot]")
				? "slot"
				: "other";
			let direction = deckKey(event.key, kind);
			if (!direction) return;
			event.preventDefault();
			event.stopPropagation();
			let next = cycle(arrange(order, items), direction);
			reorder(next, "cycle");
			if (kind === "slot") requestAnimationFrame(() => slots.current.get(next[0]!)?.focus());
		};
		let front = (event: Event) => {
			let id = (event as CustomEvent<string>).detail;
			flushSync(() => setOrder(previous => bringForward(arrange(previous, items), id)));
		};
		element.addEventListener("keydown", keydown);
		element.addEventListener(DECK_FRONT_EVENT, front);
		return () => {
			element.removeEventListener("keydown", keydown);
			element.removeEventListener(DECK_FRONT_EVENT, front);
		};
	});

	let depth = Math.min(current.length - 1, PEEKS);
	return (
		<div
			aria-label={label}
			aria-roledescription="carousel"
			className={`decision-deck${className ? ` ${className}` : ""}`}
			data-deck=""
			ref={root}
			role="region"
		>
			<div
				className="decision-deck-stage"
				id={stageId}
				style={{ "--deck-depth": depth } as CSSProperties}
			>
				{items.map(item => {
					let at = current.indexOf(item.id);
					let place = slot(at);
					let isTop = at === 0;
					return (
						<div
							aria-hidden={isTop ? undefined : true}
							aria-label={`${position(items, item.id)} of ${items.length}`}
							aria-roledescription="decision"
							className="decision-deck-slot"
							data-deck-settled={item.settled ? "" : undefined}
							data-deck-slot={item.id}
							data-deck-top={isTop ? "" : undefined}
							inert={!isTop}
							key={item.id}
							ref={element => {
								if (element) slots.current.set(item.id, element);
								else slots.current.delete(item.id);
							}}
							role="group"
							style={{ transform: place.transform, zIndex: place.zIndex, opacity: place.opacity }}
							tabIndex={isTop ? -1 : undefined}
						>
							{item.card}
						</div>
					);
				})}
			</div>
			<div className="decision-deck-nav">
				<span className="decision-deck-count">
					{position(items, top)} of {items.length}
					{decided > 0 && <span className="text-text-tertiary">· {decided} decided</span>}
				</span>
				<button
					aria-controls={stageId}
					aria-label="Previous decision"
					className="btn btn-icon btn-ghost btn-sm"
					data-deck-control=""
					onClick={() => reorder(cycle(current, -1), "cycle")}
					type="button"
				>
					<ArrowLeftIcon aria-hidden="true" size={12} />
				</button>
				<button
					aria-controls={stageId}
					aria-label="Next decision"
					className="btn btn-icon btn-ghost btn-sm"
					data-deck-control=""
					onClick={() => reorder(cycle(current, 1), "cycle")}
					type="button"
				>
					<ArrowRightIcon aria-hidden="true" size={12} />
				</button>
			</div>
			<p aria-atomic="true" aria-live="polite" className="sr-only" role="status">
				{announcement}
			</p>
		</div>
	);
}
