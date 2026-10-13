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

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChevronIcon } from "@chopin/icons";

import {
	arrange,
	arriveFrames,
	AWAY_DROP,
	bringForward,
	leaveFrames,
	lift,
	movingCard,
	PEEKS,
	position,
	settle,
	slot,
	step as stepOrder,
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
	/** After the deck unmounts while it held the reader's focus, with the card that was on top. */
	onLeave?: (top: string) => void;
};

export const DECK_FRONT_EVENT = "chopin:deck-front";

/** Bring the deck member that contains `element` to the top, synchronously. */
export function revealDeckItem(element: Element): void {
	let slotElement = element.closest<HTMLElement>("[data-deck-slot]");
	slotElement?.dispatchEvent(
		new CustomEvent(DECK_FRONT_EVENT, { bubbles: true, detail: slotElement.dataset.deckSlot }),
	);
}

/** The step an arrow key asks for, or undefined when it does not move the deck or hits an end. */
export function deckKey(
	key: string,
	target: "control" | "slot" | "other",
	modifiers: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
	place?: { index: number; total: number },
): 1 | -1 | undefined {
	if (modifiers.alt || modifiers.ctrl || modifiers.meta || modifiers.shift) return undefined;
	if (target === "other") return undefined;
	let direction: 1 | -1 | undefined = key === "ArrowRight"
		? 1
		: key === "ArrowLeft"
		? -1
		: undefined;
	if (!direction || !place) return direction;
	let next = place.index + direction;
	return next < 1 || next > place.total ? undefined : direction;
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

/** A time token in milliseconds. The build may minify `600ms` to `.6s`, so read the unit. */
export function cssMs(name: string, fallback: number): number {
	return parseMs(cssToken(name), fallback);
}

export function parseMs(token: string, fallback: number): number {
	let value = Number.parseFloat(token);
	if (!Number.isFinite(value)) return fallback;
	return /\ds$/.test(token) ? value * 1000 : value;
}

type Frozen = {
	transform: string;
	opacity: number;
	zIndex: number;
	/** The content cover's opacity. */
	cover: number;
	/** Whether the card was mid-move, so its layer and opacity are not its slot's. */
	moving: boolean;
};

/** A move that holds the card on a layer outside its slot's. */
const MOVE = "deck-move";

/** The card's own animations, its cover's included, but not those of the card inside it. */
function own(element: HTMLElement): Animation[] {
	return element.getAnimations({ subtree: true })
		.filter(animation => (animation.effect as KeyframeEffect | null)?.target === element);
}

/** How far an eased move of `duration` has come at `time`, from 0 to 1. */
function eased(time: number, duration: number, easing: string): number {
	let probe = new Animation(new KeyframeEffect(null, null, { duration, easing }));
	probe.currentTime = time;
	return Number(probe.effect?.getComputedTiming().progress ?? 1);
}

/** Animate a card's content cover, which hides its content while it sits behind. */
function cover(element: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
	return element.animate(frames, { ...options, pseudoElement: "::after" });
}

/** Freeze a card where it is so a new move starts from this frame, not its end. */
function freeze(element: HTMLElement): Frozen {
	let style = getComputedStyle(element);
	let animations = own(element);
	let frozen = {
		transform: style.transform,
		opacity: Number(style.opacity),
		zIndex: Number(style.zIndex) || 0,
		cover: Number(getComputedStyle(element, "::after").opacity),
		moving: animations.some(animation => animation.id === MOVE),
	};
	for (let animation of animations) animation.cancel();
	return frozen;
}

export function Deck({ items, label, onLeave, reduced = prefersReduced }: DeckProps) {
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
	let focusWithin = useRef(false);
	let leaveRef = useRef(onLeave);
	let topRef = useRef<string | undefined>(undefined);
	orderRef.current = order;
	itemsRef.current = items;
	leaveRef.current = onLeave;
	let top = current[0];
	topRef.current = top;

	let announce = (kind: "cycle" | "settle", id: string) => {
		let latest = itemsRef.current;
		let item = latest.find(each => each.id === id);
		if (!item) return;
		let text = deckAnnouncement(kind, position(latest, id), latest.length, item.label);
		window.clearTimeout(announcing.current);
		announcing.current = window.setTimeout(() => setAnnouncement(text), ANNOUNCE_DELAY);
	};

	/**
	 * Commit a new order, then play it: the old top card slides away in front of
	 * the deck and reappears behind, or the new one slides back in over it; the
	 * rest rise or sink one place, their covers fading as they go, and the stage
	 * eases to the new top card's height. Every move starts from where the cards
	 * are now, so a reorder mid-move continues the gesture instead of snapping.
	 */
	let reorder = (next: string[], kind: "cycle" | "settle" | undefined, direction?: 1 | -1) => {
		let previous = arrange(orderRef.current, itemsRef.current);
		let still = reduced();
		let frozen = new Map<string, Frozen>();
		for (let [id, element] of slots.current) frozen.set(id, freeze(element));
		let stageElement = stage.current;
		let height = stageElement?.getBoundingClientRect().height;
		for (let animation of stageElement?.getAnimations() ?? []) animation.cancel();
		orderRef.current = next;
		flushSync(() => setOrder(next));
		if (kind && next[0] !== undefined) announce(kind, next[0]);

		let outgoing = previous[0] === next[0] ? undefined : previous[0];
		let after = stageElement?.getBoundingClientRect().height ?? 0;
		if (still) {
			// Without movement, the old top card fades out where it stood, over the new one.
			let element = slots.current.get(outgoing ?? "");
			let from = frozen.get(outgoing ?? "");
			if (!element || !from) return;
			let duration = cssMs("--duration-base", 200);
			let over = 101 + next.length;
			let front = slot(0).transform;
			element.animate([
				{ transform: front, opacity: from.opacity, zIndex: over, bottom: "auto" },
				{ transform: front, opacity: 0, zIndex: over, bottom: "auto" },
			], { id: MOVE, duration });
			cover(element, [{ opacity: 0 }, { opacity: 0 }], { duration });
			return;
		}

		let duration = cssMs("--deck-move-dur", 320);
		let easing = cssToken("--deck-ease") || "ease-out";
		let moving = movingCard(previous, next, direction);
		for (let [id, element] of slots.current) {
			let from = frozen.get(id);
			let at = next.indexOf(id);
			if (!from || at === -1) continue;
			let place = slot(at);
			let covered = at === 0 ? 0 : 1;
			// Only the old top card leaves in front; a card settling from behind just changes place.
			if (id === moving?.id && moving.direction === "back" && id === outgoing) {
				let frames = leaveFrames(from, place.transform, next.length, at > PEEKS, easing);
				// Until it is out of sight it keeps its own height, not the new top card's,
				// but is clipped at the stage's lower edge so it never covers the pager or prose.
				frames.card[0]!.bottom = "auto";
				frames.card[1]!.bottom = "auto";
				// Its own height: after the commit its box is stretched to the new top card's.
				element.style.bottom = "auto";
				let natural = element.offsetHeight;
				element.style.bottom = "";
				let top = element.offsetTop;
				let drop = AWAY_DROP
					* Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
				let before = height ?? after;
				let leave: Keyframe[] = [];
				for (let step = 0; step <= 5; step++) {
					let offset = step / 10;
					// The pager rides the stage's eased height; the card falls linearly.
					let floor = before + (after - before) * eased(offset * duration, duration, easing);
					let scale = 1 - 0.02 * (offset / 0.5);
					let hidden = Math.max(0, natural - (floor - top - drop * (offset / 0.5)) / scale);
					leave.push({ offset, clipPath: `inset(-2rem -2rem ${hidden}px -2rem)` });
				}
				frames.card.splice(1, 0, ...leave.slice(1, -1));
				frames.card[0]!.clipPath = leave[0]!.clipPath;
				frames.card[5]!.clipPath = leave[5]!.clipPath;
				frames.card[6]!.clipPath = "inset(-2rem -2rem 0px -2rem)";
				frames.card[7]!.clipPath = "inset(-2rem -2rem 0px -2rem)";
				// Behind the deck it takes the stage's height again, or a tall card would show below it.
				frames.card[6]!.bottom = "0px";
				frames.card[7]!.bottom = "0px";
				element.animate(frames.card, { id: MOVE, duration });
				cover(element, frames.cover, { duration });
				continue;
			}
			if (id === moving?.id && moving.direction === "front") {
				let frames = arriveFrames(place.transform, next.length, from.moving ? from : undefined);
				element.animate(frames, { id: MOVE, duration, easing });
				if (from.moving && from.cover > 0) {
					cover(element, [{ opacity: from.cover }, { opacity: 0 }], { duration, easing });
				}
				continue;
			}
			// A card caught mid-move eases back to its slot's layer too.
			let layer = (zIndex: number) => from.moving ? { zIndex } : {};
			element.animate(
				[
					{ transform: from.transform, opacity: from.opacity, ...layer(from.zIndex) },
					{ transform: place.transform, opacity: place.opacity, ...layer(place.zIndex) },
				],
				{ id: from.moving ? MOVE : "", duration, easing },
			);
			if (from.cover !== covered) {
				// The new top card's content arrives within the old one's fade; a card going
				// behind keeps its content until the one arriving over it has shown its own.
				let timing = covered === 0 ? { duration: duration / 2, easing } : { duration };
				cover(element, [{ opacity: from.cover }, { opacity: covered }], timing);
			}
		}
		// The top card sets the stage's height; ease between the two so prose
		// below does not jump mid-move.
		if (stageElement && height !== undefined && height !== after) {
			stageElement.animate([{ height: `${height}px` }, { height: `${after}px` }], {
				duration,
				easing,
			});
		}
		// The incoming top card joins the flow at its own height. Reveal what the
		// old stage did not show at the stage's pace, so it never paints over the
		// controls and prose below before the stage has grown to hold it.
		let incoming = next[0] === previous[0] ? undefined : slots.current.get(next[0] ?? "");
		if (stageElement && incoming && height !== undefined) {
			let shown = height - Number.parseFloat(getComputedStyle(stageElement).paddingTop);
			let hidden = incoming.offsetHeight - shown;
			if (hidden > 0) {
				incoming.animate(
					[
						{ clipPath: `inset(-2rem -2rem ${hidden}px -2rem)` },
						{ clipPath: "inset(-2rem -2rem 0px -2rem)" },
					],
					{ duration, easing },
				);
			}
		}
	};

	// Reaching an end disables the pressed arrow, which drops its focus; keep focus in the pager.
	let pagerFocused = () => !!document.activeElement?.closest("[data-deck-control]");
	let keepFocus = (had: boolean) => {
		let active = document.activeElement;
		let lost = active === null || active === document.body
			|| (active instanceof HTMLButtonElement && active.disabled);
		if (!had || !lost) return;
		root.current?.querySelector<HTMLButtonElement>("[data-deck-control]:not(:disabled)")?.focus();
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
		lingering.current = undefined;
		window.clearTimeout(announcing.current);
	}, []);

	// A deck can dissolve under the reader, for instance when its last open card is
	// answered. Its focused control goes with it, so hand focus on rather than drop it.
	useLayoutEffect(() => () => {
		let active = document.activeElement;
		let inside = !!active && !!root.current?.contains(active);
		let dropped = (active === null || active === document.body) && focusWithin.current
			&& performance.now() - touchedAt.current < CAUSE_WINDOW;
		let id = topRef.current;
		let leave = leaveRef.current;
		if ((inside || dropped) && id !== undefined && leave) {
			requestAnimationFrame(() => leave(id));
		}
	}, []);

	useEffect(() => {
		let element = root.current;
		if (!element) return;
		let touch = () => {
			touchedAt.current = performance.now();
		};
		let keydown = (event: KeyboardEvent) => {
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
			}, {
				index: position(itemsRef.current, orderRef.current[0]),
				total: itemsRef.current.length,
			});
			if (!direction) return;
			touch();
			event.preventDefault();
			event.stopPropagation();
			let next = stepOrder(
				arrange(orderRef.current, itemsRef.current),
				itemsRef.current,
				direction,
			);
			if (!next) return;
			let had = pagerFocused();
			reorder(next, "cycle", direction);
			if (kind === "slot") slots.current.get(next[0]!)?.focus({ preventScroll: true });
			else keepFocus(had);
		};
		let front = (event: Event) => {
			let id = (event as CustomEvent<string>).detail;
			for (let slotElement of slots.current.values()) {
				for (let animation of own(slotElement)) animation.cancel();
			}
			for (let animation of stage.current?.getAnimations() ?? []) animation.cancel();
			let next = bringForward(arrange(orderRef.current, itemsRef.current), id);
			orderRef.current = next;
			flushSync(() => setOrder(next));
		};
		let focusin = () => {
			focusWithin.current = true;
		};
		// Removing the focused control reports no destination; keep the last answer then.
		let focusout = (event: FocusEvent) => {
			let next = event.relatedTarget as Node | null;
			if (next && !element.contains(next)) focusWithin.current = false;
		};
		// A click also covers a control activated from the keyboard; typing is not a touch.
		element.addEventListener("pointerdown", touch);
		element.addEventListener("click", touch);
		element.addEventListener("focusin", focusin);
		element.addEventListener("focusout", focusout);
		element.addEventListener("keydown", keydown);
		element.addEventListener(DECK_FRONT_EVENT, front);
		return () => {
			element.removeEventListener("pointerdown", touch);
			element.removeEventListener("click", touch);
			element.removeEventListener("focusin", focusin);
			element.removeEventListener("focusout", focusout);
			element.removeEventListener("keydown", keydown);
			element.removeEventListener(DECK_FRONT_EVENT, front);
		};
	});

	let step = (direction: 1 | -1) => {
		let next = stepOrder(arrange(orderRef.current, itemsRef.current), itemsRef.current, direction);
		if (!next) return;
		let had = pagerFocused();
		reorder(next, "cycle", direction);
		keepFocus(had);
	};
	let index = position(items, top);

	return (
		<div
			aria-label={label}
			aria-roledescription="carousel"
			className="decision-deck"
			data-deck=""
			ref={root}
			role="group"
		>
			<div
				className="decision-deck-stage"
				id={stageId}
				ref={stage}
				style={{ "--deck-lift": lift(current.length) } as CSSProperties}
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
							data-deck-depth={isTop ? undefined : Math.min(at, PEEKS)}
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
			{items.length > 1 && (
				<div className="decision-deck-nav">
					<div className="decision-deck-pager">
						<button
							aria-controls={stageId}
							aria-label="Previous decision"
							className="decision-deck-step"
							data-deck-control=""
							disabled={index <= 1}
							onClick={() => step(-1)}
							type="button"
						>
							<ChevronIcon aria-hidden="true" className="decision-deck-back" size={14} />
						</button>
						<span className="decision-deck-count">
							<span className="decision-deck-index">{index}</span> of {items.length}
						</span>
						<button
							aria-controls={stageId}
							aria-label="Next decision"
							className="decision-deck-step"
							data-deck-control=""
							disabled={index >= items.length}
							onClick={() => step(1)}
							type="button"
						>
							<ChevronIcon aria-hidden="true" size={14} />
						</button>
					</div>
				</div>
			)}
			<p aria-atomic="true" aria-live="polite" className="sr-only" role="status">
				{announcement}
			</p>
		</div>
	);
}
