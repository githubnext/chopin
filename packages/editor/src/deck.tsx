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

import {
	arrange,
	bringForward,
	cycle,
	movingCard,
	PEEKS,
	position,
	settle,
	shuffleFrames,
	slot,
} from "./deck-order";

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

export function deckKey(
	key: string,
	target: "control" | "slot" | "other",
	modifiers: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
): 1 | -1 | undefined {
	if (modifiers.alt || modifiers.ctrl || modifiers.meta || modifiers.shift) return undefined;
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

export function prefersReduced(): boolean {
	return typeof matchMedia === "function"
		&& matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Hold a polite announcement this long so a held arrow key speaks only the last card. */
const ANNOUNCE_DELAY = 200;
/** A settle this soon after the reader touched the deck is one they caused. */
const CAUSE_WINDOW = 10_000;

function cssToken(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function cssMs(name: string, fallback: number): number {
	let value = Number.parseFloat(cssToken(name));
	return Number.isFinite(value) ? value : fallback;
}

/** Freeze a card where it is so a new move starts from this frame, not its end. */
function freeze(element: HTMLElement): { transform: string; opacity: string } {
	let style = getComputedStyle(element);
	let frozen = { transform: style.transform, opacity: style.opacity };
	for (let animation of element.getAnimations()) animation.cancel();
	return frozen;
}

export function Deck({ className, items, label, reduced = prefersReduced }: DeckProps) {
	let [order, setOrder] = useState(() => settle(arrange([], items), items));
	let current = arrange(order, items);
	let [announcement, setAnnouncement] = useState("");
	let root = useRef<HTMLDivElement>(null);
	let stage = useRef<HTMLDivElement>(null);
	let slots = useRef(new Map<string, HTMLElement>());
	let orderRef = useRef(order);
	let itemsRef = useRef(items);
	let lingering = useRef<number | undefined>(undefined);
	let announcing = useRef<number | undefined>(undefined);
	let touchedAt = useRef(-Infinity);
	let stageId = useId();
	orderRef.current = order;
	itemsRef.current = items;
	let top = current[0];
	let decided = items.filter(item => item.settled).length;

	let announce = (kind: "cycle" | "settle", id: string) => {
		let latest = itemsRef.current;
		let item = latest.find(each => each.id === id);
		if (!item) return;
		let text = deckAnnouncement(kind, position(latest, id), latest.length, item.label);
		window.clearTimeout(announcing.current);
		announcing.current = window.setTimeout(() => setAnnouncement(text), ANNOUNCE_DELAY);
	};

	/**
	 * Commit a new order, then play it: the card that passes the others shuffles
	 * under or over the deck, the rest slide one place, and the stage eases to
	 * the new top card's height. Every move starts from where the cards are now,
	 * so a reorder mid-shuffle continues the gesture instead of snapping.
	 */
	let reorder = (next: string[], kind: "cycle" | "settle" | undefined, direction?: 1 | -1) => {
		let previous = arrange(orderRef.current, itemsRef.current);
		let still = reduced();
		let frozen = new Map<string, { transform: string; opacity: string }>();
		let height: number | undefined;
		for (let [id, element] of slots.current) {
			if (still) { for (let animation of element.getAnimations()) animation.cancel(); }
			else frozen.set(id, freeze(element));
		}
		let stageElement = stage.current;
		if (stageElement && !still) height = stageElement.getBoundingClientRect().height;
		for (let animation of stageElement?.getAnimations() ?? []) animation.cancel();
		orderRef.current = next;
		flushSync(() => setOrder(next));
		if (kind && next[0] !== undefined) announce(kind, next[0]);
		if (still) return;

		let linger = cssMs("--duration-linger", 600);
		let easing = cssToken("--ease-out") || "ease-out";
		let moving = movingCard(previous, next, direction);
		for (let [id, element] of slots.current) {
			let from = frozen.get(id);
			let at = next.indexOf(id);
			if (!from || at === -1) continue;
			let place = slot(at);
			if (id === moving?.id) {
				let frames = shuffleFrames(
					from.transform,
					place.transform,
					moving.direction,
					next.length,
					at > PEEKS,
					easing,
				);
				element.animate(frames, { duration: linger * 1.4 });
				continue;
			}
			element.animate(
				[
					{ transform: from.transform, opacity: from.opacity },
					{ transform: place.transform, opacity: place.opacity },
				],
				{ duration: linger, easing },
			);
		}
		// The top card sets the stage's height; ease between the two so prose
		// below does not jump mid-shuffle.
		let after = stageElement?.getBoundingClientRect().height;
		if (stageElement && height !== undefined && after !== undefined && height !== after) {
			stageElement.animate([{ height: `${height}px` }, { height: `${after}px` }], {
				duration: linger * 1.4,
				easing,
			});
		}
	};

	// Keyed on settled state, so a reader may cycle a settled card back to the
	// top without it being sent away again. An answered card lingers on top
	// first so its result reads before it moves.
	let signature = items.map(item => `${item.id}:${item.settled ? 1 : 0}`).join();
	useEffect(() => {
		let before = arrange(orderRef.current, itemsRef.current);
		if (lingering.current !== undefined) return;
		if (settle(before, itemsRef.current).join() === before.join()) return;
		let focused = !!slots.current.get(before[0]!)?.contains(document.activeElement);
		lingering.current = window.setTimeout(() => {
			lingering.current = undefined;
			let latest = arrange(orderRef.current, itemsRef.current);
			let next = settle(latest, itemsRef.current);
			if (next.join() === latest.join()) return;
			let active = document.activeElement;
			let touched = performance.now() - touchedAt.current < CAUSE_WINDOW;
			// A settled card can drop the focused control, leaving focus on the body.
			let hadFocus = focused || !!slots.current.get(latest[0]!)?.contains(active)
				|| (touched && (active === null || active === document.body));
			// Only the reader's own answer is spoken; a collaborator's reorders quietly.
			let kind = touched && next[0] !== latest[0] ? "settle" as const : undefined;
			reorder(next, kind);
			if (hadFocus) slots.current.get(next[0]!)?.focus({ preventScroll: true });
		}, reduced() ? 0 : cssMs("--duration-linger", 600));
	}, [signature]);

	useEffect(() => () => {
		window.clearTimeout(lingering.current);
		window.clearTimeout(announcing.current);
	}, []);

	useEffect(() => {
		let element = root.current;
		if (!element) return;
		let touch = () => {
			touchedAt.current = performance.now();
		};
		let keydown = (event: KeyboardEvent) => {
			touch();
			let target = event.target as HTMLElement;
			let kind: "control" | "slot" | "other" = target.closest("[data-deck-control]")
				? "control"
				: target.matches("[data-deck-slot]")
				? "slot"
				: "other";
			if (event.defaultPrevented) return;
			let direction = deckKey(event.key, kind, {
				alt: event.altKey,
				ctrl: event.ctrlKey,
				meta: event.metaKey,
				shift: event.shiftKey,
			});
			if (!direction) return;
			event.preventDefault();
			event.stopPropagation();
			let next = cycle(arrange(orderRef.current, itemsRef.current), direction);
			reorder(next, "cycle", direction);
			if (kind === "slot") slots.current.get(next[0]!)?.focus({ preventScroll: true });
		};
		let front = (event: Event) => {
			let id = (event as CustomEvent<string>).detail;
			for (let slotElement of slots.current.values()) {
				for (let animation of slotElement.getAnimations()) animation.cancel();
			}
			let next = bringForward(arrange(orderRef.current, itemsRef.current), id);
			orderRef.current = next;
			flushSync(() => setOrder(next));
		};
		element.addEventListener("pointerdown", touch);
		element.addEventListener("keydown", keydown);
		element.addEventListener(DECK_FRONT_EVENT, front);
		return () => {
			element.removeEventListener("pointerdown", touch);
			element.removeEventListener("keydown", keydown);
			element.removeEventListener(DECK_FRONT_EVENT, front);
		};
	});

	let step = (direction: 1 | -1) => {
		reorder(cycle(arrange(orderRef.current, itemsRef.current), direction), "cycle", direction);
	};

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
				ref={stage}
				style={{ "--deck-depth": depth } as CSSProperties}
			>
				{items.map(item => {
					let at = current.indexOf(item.id);
					let place = slot(at);
					let isTop = at === 0;
					return (
						<div
							aria-hidden={isTop ? undefined : true}
							aria-label={`${position(items, item.id)} of ${items.length}: ${item.label}`}
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
					{decided > 0 && <span className="text-text-tertiary">{" · "}{decided} decided</span>}
				</span>
				<button
					aria-controls={stageId}
					aria-label="Previous decision"
					className="btn btn-icon btn-ghost btn-sm"
					data-deck-control=""
					onClick={() => step(-1)}
					type="button"
				>
					<ArrowLeftIcon aria-hidden="true" size={12} />
				</button>
				<button
					aria-controls={stageId}
					aria-label="Next decision"
					className="btn btn-icon btn-ghost btn-sm"
					data-deck-control=""
					onClick={() => step(1)}
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
