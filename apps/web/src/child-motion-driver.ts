import {
	CHILD_MOTION_STORAGE_KEY,
	childMotionStyle,
	clipInset,
	motionOrigin,
	rectTransform,
	settledBox,
	zoomStart,
} from "./child-motion";

import type { Box, ChildMotionStyle } from "./child-motion";

let toggleEnabled = import.meta.env.DEV || import.meta.env.VITE_CHILD_MOTION_TOGGLE === "on";

export function readChildMotionStyle() {
	let stored: string | null = null;
	try {
		stored = localStorage.getItem(CHILD_MOTION_STORAGE_KEY);
	} catch {
		// Storage can be unavailable; Lift is the default.
	}
	return childMotionStyle(toggleEnabled, stored);
}

/** Resolves once every animation has finished or been cancelled, so a close never sticks. */
export function animationsSettled(animations: { finished: Promise<unknown> }[]): Promise<void> {
	return Promise.allSettled(animations.map(animation => animation.finished)).then(() => {});
}

/** Registered time tokens compute to seconds (`0.6s`), unregistered ones keep their units. */
function milliseconds(value: string, fallback: number) {
	let amount = Number.parseFloat(value);
	if (!Number.isFinite(amount) || amount <= 0) return fallback;
	return /\ds\s*$/.test(value) ? amount * 1000 : amount;
}

function tokens(element: Element) {
	let style = getComputedStyle(element);
	return {
		open: milliseconds(style.getPropertyValue("--child-open-dur"), 600),
		close: milliseconds(style.getPropertyValue("--child-close-dur"), 250),
		easing: style.getPropertyValue("--child-ease").trim() || "ease-out",
		radius: style.getPropertyValue("--radius-panel").trim() || "12px",
		reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
	};
}

/** Freeze an element's in-flight values, then drop its animations, so the next move starts here. */
function settle(element: HTMLElement) {
	let style = getComputedStyle(element);
	let now = { clipPath: style.clipPath, opacity: style.opacity, transform: style.transform };
	for (let animation of element.getAnimations()) animation.cancel();
	return now;
}

function usable(box: Box) {
	return Number.isFinite(box.width) && Number.isFinite(box.height) && box.width >= 1
		&& box.height >= 1;
}

function scaleOf(transform: string) {
	return transform === "none" ? 1 : new DOMMatrixReadOnly(transform).a;
}

/** Big enough to scale from: a sliver would round Zoom's scale to zero. */
function landable(rect: Box, box: Box) {
	return usable(rect) && rect.width >= box.width / 100;
}

/** The opener's rect inside the card, or the card's lower centre; never a degenerate box. */
function originIn(opener: Box | undefined, box: Box) {
	let from = motionOrigin(opener, box);
	return landable(from, box) ? from : motionOrigin(undefined, box);
}

function parts(card: HTMLElement) {
	let shadow = card.previousElementSibling;
	return {
		content: card.querySelector<HTMLElement>(":scope > .anchored-child-content"),
		face: card.querySelector<HTMLElement>(":scope > .anchored-child-face"),
		shadow: shadow instanceof HTMLElement && shadow.classList.contains("anchored-child-shadow")
			? shadow
			: null,
	};
}

/** The stack element that recedes for this style: the whole root card, or its plan for Zoom. */
function receding(card: HTMLElement, motion: ChildMotionStyle) {
	let stack = card.closest<HTMLElement>(".workspace-document-stack");
	return motion === "lift"
		? stack?.querySelector<HTMLElement>(":scope > .workspace-document-panel") ?? null
		: stack?.querySelector<HTMLElement>(
			'[data-document-view="plan"]:not(.workspace-child-slot *)',
		) ?? null;
}

/** Compact always presents with the stack bar, so the stack's attribute is the style in force. */
function effective(card: HTMLElement, requested: ChildMotionStyle): ChildMotionStyle {
	let stack = card.closest<HTMLElement>(".workspace-document-stack");
	return stack?.dataset.childMotion === "zoom" ? "zoom" : requested;
}

/** The card an opener belongs to: a research card's open control covers the whole card. */
function cardOf(opener: Element): HTMLElement | undefined {
	let card = opener.closest("[data-research-ready]") ?? opener;
	return card instanceof HTMLElement ? card : undefined;
}

/**
 * The opener's card as the root document shows it now. The root can replace its content while a
 * child is open, so a detached opener is found again by its accessible name.
 */
function rootSlot(opener: Element | undefined, stack: Element | null): HTMLElement | undefined {
	if (!opener || !stack) return undefined;
	let live: Element | null | undefined = opener.isConnected ? opener : undefined;
	let label = opener.getAttribute("aria-label");
	if (!live && label) {
		live = [...stack.querySelectorAll(`[aria-label="${CSS.escape(label)}"]`)].find(element =>
			!element.closest(".workspace-child-slot")
		);
	}
	let slot = live ? cardOf(live) : undefined;
	return slot?.offsetParent && stack.contains(slot) && !slot.closest(".workspace-child-slot")
		? slot
		: undefined;
}

/** A still copy of the opener drawn inside the card at `at`, so the card reads as the opener. */
function faceOf(card: HTMLElement, slot: HTMLElement, at: Box, box: Box) {
	let face = slot.cloneNode(true) as HTMLElement;
	// A copy would replay its parts' entrances, so it keeps each part as it looks now instead.
	let originals = [slot, ...slot.querySelectorAll<HTMLElement>("*")];
	let copies = [face, ...face.querySelectorAll<HTMLElement>("*")];
	originals.forEach((original, index) => {
		let copy = copies[index];
		if (!copy) return;
		let style = getComputedStyle(original);
		Object.assign(copy.style, {
			animation: "none",
			opacity: style.opacity,
			transform: style.transform,
			transition: "none",
		});
	});
	face.classList.add("anchored-child-face");
	face.removeAttribute("id");
	for (let element of face.querySelectorAll("[id]")) element.removeAttribute("id");
	face.inert = true;
	face.setAttribute("aria-hidden", "true");
	Object.assign(face.style, {
		left: `${at.left - box.left}px`,
		top: `${at.top - box.top}px`,
		width: `${at.width}px`,
		height: `${at.height}px`,
	});
	card.append(face);
	return face;
}

let openers = new WeakMap<HTMLElement, Element>();

/** Remember the opener so a close can find its slot again. */
export function rememberOpener(card: HTMLElement, opener: Element | null | undefined) {
	if (opener) openers.set(card, opener);
}

export function openChild(
	card: HTMLElement,
	opener: DOMRect | undefined,
	requested: ChildMotionStyle,
) {
	let t = tokens(card);
	// Reduced motion keeps the stylesheet's crossfade, which settling would cancel.
	if (t.reduced) return;
	let motion = effective(card, requested);
	let { content, face, shadow } = parts(card);
	let was = settle(card);
	let shift = content ? settle(content) : undefined;
	let cast = shadow ? settle(shadow) : undefined;
	let faded = face ? Number(settle(face).opacity) : 0;
	face?.remove();
	let box = card.getBoundingClientRect();
	if (!usable(box)) return;
	let from = originIn(opener, box);
	let fallback = motionOrigin(undefined, box);
	let fromOpener = from.left !== fallback.left || from.top !== fallback.top
		|| from.width !== fallback.width;
	let parent = receding(card, motion);
	if (parent && motion === "zoom") {
		let style = getComputedStyle(parent);
		// Moving the pivot of a plan that is still pushed in would make it jump.
		if (scaleOf(style.transform) === 1) {
			let p = parent.getBoundingClientRect();
			parent.style.transformOrigin = `${from.left - p.left + from.width / 2}px ${
				from.top - p.top + from.height / 2
			}px`;
		}
	}
	let eased = { duration: t.open, easing: t.easing };
	let full = `inset(0px 0px 0px 0px round ${t.radius})`;
	if (motion === "lift") {
		let fresh = was.clipPath === "none";
		card.animate([
			{ clipPath: fresh ? clipInset(from, box, t.radius) : was.clipPath },
			{ clipPath: clipInset(box, box, t.radius) },
		], eased);
		// The clicked card may already be detached; its copy still shows what was clicked.
		let raw = openers.get(card);
		let slot = fresh && fromOpener && raw ? cardOf(raw) : undefined;
		// Opacity runs linearly: under the ease-out curve it would land in the first third.
		if (content) {
			content.animate([
				{
					transform: fresh
						? `translate(${from.left - box.left}px, ${from.top - box.top}px)`
						: shift!.transform,
				},
				{ transform: "none" },
			], eased);
			content.animate(
				fresh
					? [{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1, offset: 0.8 }, {
						opacity: 1,
					}]
					: [{ opacity: Number(shift!.opacity) }, { opacity: 1 }],
				{ duration: t.open },
			);
		}
		if (slot) {
			let lifted = faceOf(card, slot, from, box);
			lifted.animate([
				{ transform: "none" },
				{ transform: `translate(${box.left - from.left}px, ${box.top - from.top}px)` },
			], eased);
			lifted.animate([{ opacity: 1 }, { opacity: 1, offset: 0.3 }, { opacity: 0, offset: 0.65 }, {
				opacity: 0,
			}], { duration: t.open, fill: "forwards" }).onfinish = () => lifted.remove();
		} else if (faded > 0 && face) {
			// A reopen mid-close lets the returning face go rather than snapping it away.
			card.append(face);
			face.animate([{ opacity: faded }, { opacity: 0 }], { duration: t.open / 3, fill: "forwards" })
				.onfinish = () => face.remove();
		}
		shadow?.animate([
			{ transform: fresh ? rectTransform(from, box) : cast!.transform },
			{ transform: "none" },
		], eased);
		return;
	}
	let fresh = was.transform === "none" && was.clipPath === "none";
	card.style.transformOrigin = "0 0";
	card.animate([
		fresh
			? { ...zoomStart(from, box, t.radius), opacity: 0 }
			: {
				clipPath: was.clipPath === "none" ? full : was.clipPath,
				opacity: Number(was.opacity),
				transform: was.transform,
			},
		{ opacity: 1, offset: 0.2 },
		{ clipPath: full, opacity: 1, transform: "none" },
	], eased);
	content?.animate(
		fresh
			? [{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1, offset: 0.75 }, { opacity: 1 }]
			: [{ opacity: Number(shift!.opacity) }, { opacity: 1 }],
		{ duration: t.open },
	);
}

export function closeChild(card: HTMLElement, requested: ChildMotionStyle): Promise<void> {
	let t = tokens(card);
	// Reduced motion closes with the stylesheet's fade-out; wait for it rather than cancel it.
	if (t.reduced) return animationsSettled(card.getAnimations());
	let motion = effective(card, requested);
	let { content, face, shadow } = parts(card);
	let was = settle(card);
	let shift = content ? settle(content) : undefined;
	let cast = shadow ? settle(shadow) : undefined;
	let faded = face ? Number(settle(face).opacity) : 0;
	face?.remove();
	let box = card.getBoundingClientRect();
	if (!usable(box)) return Promise.resolve();
	let parent = receding(card, motion);
	let slot = rootSlot(openers.get(card), card.closest(".workspace-document-stack"));
	let target: Box | undefined;
	if (slot && parent) {
		// Aim at where the card will be once the root has finished settling, not where it is now.
		let style = getComputedStyle(parent);
		let scale = scaleOf(style.transform);
		let p = parent.getBoundingClientRect();
		let [ox = 0, oy = 0] = style.transformOrigin.split(" ").map(Number.parseFloat);
		// A scale about (ox, oy) leaves that point fixed at the layout box's left + ox.
		let pivot = { x: p.left + ox * scale, y: p.top + oy * scale };
		let settled = Number.isFinite(scale) && scale > 0
			? settledBox(slot.getBoundingClientRect(), scale, pivot)
			: undefined;
		if (settled && landable(settled, box)) target = settled;
	}
	let eased = { duration: t.close, easing: t.easing, fill: "forwards" as const };
	let linear = { duration: t.close, fill: "forwards" as const };
	let from = was.clipPath === "none" ? clipInset(box, box, t.radius) : was.clipPath;
	let animations: Animation[] = [];
	if (!target) {
		// Nowhere to land: fade where it stands, holding any half-grown frame.
		let held = { clipPath: was.clipPath, transform: was.transform };
		animations.push(
			card.animate([{ ...held, opacity: Number(was.opacity) }, { ...held, opacity: 0 }], eased),
		);
		if (content) {
			let still = { opacity: Number(shift!.opacity), transform: shift!.transform };
			animations.push(content.animate([still, still], eased));
		}
		if (shadow) {
			let still = { transform: cast!.transform };
			animations.push(shadow.animate([{ ...still, opacity: 1 }, { ...still, opacity: 0 }], eased));
		}
	} else if (motion === "lift") {
		animations.push(
			card.animate([{ clipPath: from }, { clipPath: clipInset(target, box, t.radius) }], eased),
		);
		if (content) {
			animations.push(content.animate([
				{ transform: shift!.transform },
				{ transform: `translate(${target.left - box.left}px, ${target.top - box.top}px)` },
			], eased));
			animations.push(content.animate([
				{ opacity: Number(shift!.opacity) },
				{ opacity: 0, offset: 0.5 },
				{ opacity: 0 },
			], linear));
		}
		let returning = faceOf(card, slot!, target, box);
		animations.push(returning.animate([
			{ opacity: faded },
			{ opacity: faded, offset: 0.2 },
			{ opacity: 1, offset: 0.55 },
			{ opacity: 1 },
		], linear));
		if (shadow) {
			animations.push(shadow.animate([
				{ transform: cast!.transform },
				{ transform: rectTransform(target, box) },
			], eased));
		}
	} else {
		card.style.transformOrigin = "0 0";
		animations.push(card.animate([
			{ clipPath: from, opacity: Number(was.opacity), transform: was.transform },
			{ opacity: 1, offset: 0.8 },
			{ ...zoomStart(target, box, t.radius), opacity: 0 },
		], eased));
		if (content) {
			animations.push(content.animate([
				{ opacity: Number(shift!.opacity) },
				{ opacity: 0, offset: 0.4 },
				{ opacity: 0 },
			], linear));
		}
	}
	return animationsSettled(animations);
}
