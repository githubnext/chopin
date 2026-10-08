import { useEffect } from "react";

const DELAY = 400;
// After a tooltip was visible, the next one opens at once for this long.
const WARM = 300;
const GAP = 6;

function hasVisibleText(button: HTMLButtonElement): boolean {
	let walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
	while (walker.nextNode()) {
		let node = walker.currentNode;
		if (!node.textContent?.trim()) continue;
		let parent = node.parentElement;
		if (!parent || parent.closest("svg, [aria-hidden='true'], .sr-only, [hidden]")) continue;
		let style = getComputedStyle(parent);
		if (style.display !== "none" && style.visibility !== "hidden") return true;
	}
	return false;
}

function iconButton(target: EventTarget | null): HTMLElement | null {
	if (!(target instanceof Element)) return null;
	// Non-button marks (such as presence faces) opt in with an explicit data-tooltip.
	let marked = target.closest<HTMLElement>("[data-tooltip]:not(button)");
	if (marked && !marked.closest("[inert]")) return marked;
	let button = target.closest<HTMLButtonElement>("button");
	if (
		!button || button.disabled || button.closest("[inert]")
		|| button.matches(
			".sr-only, .navigation-drawer-backdrop, .navigation-modal-backdrop, .plan-comment-button, .plan-decision-marker",
		)
	) {
		return null;
	}
	// A text button opts in when its tooltip adds detail its label does not say.
	if (button.hasAttribute("data-tooltip-detail") && button.getAttribute("data-tooltip")) {
		return button;
	}
	if (hasVisibleText(button)) return null;
	if (
		!button.getAttribute("data-tooltip") && !button.getAttribute("aria-label")
		&& !button.getAttribute("title") && !button.querySelector(".sr-only")
	) return null;
	return button;
}

// A persistent toggle (such as the sidebar) is expanded without covering anything.
function openPopup(element: HTMLElement): boolean {
	let popup = element.getAttribute("aria-haspopup");
	return element.getAttribute("aria-expanded") === "true" && popup !== null && popup !== "false";
}

/**
 * Tooltips use sentence case.
 * Names and handles opt out so they keep their own casing.
 */
export function tooltipText(label: string, verbatim: boolean): string {
	return verbatim
		? label.trim()
		: label.trim().replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

/** Hover tooltips never show on coarse pointers; focus ones only for keyboard focus. */
export function tooltipTrigger(
	source: "hover" | "focus",
	state: { coarse: boolean; focusVisible: boolean },
): boolean {
	return source === "hover" ? !state.coarse : state.focusVisible;
}

function focusVisible(element: Element): boolean {
	try {
		return element.matches(":focus-visible");
	} catch {
		return true;
	}
}

function keyboardFocused(target: EventTarget | null): HTMLElement | null {
	let button = iconButton(target);
	return button && focusVisible(button) ? button : null;
}

export function IconTooltip() {
	useEffect(() => {
		let tooltip = document.createElement("div");
		tooltip.className = "icon-tooltip";
		tooltip.setAttribute("data-icon-tooltip", "");
		tooltip.setAttribute("aria-hidden", "true");
		document.body.append(tooltip);
		let active: HTMLElement | null = null;
		let hovered: HTMLElement | null = null;
		let focused: HTMLElement | null = null;
		// Escape dismisses the focused control's tooltip until focus moves.
		let dismissed: HTMLElement | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let originalTitle: string | null = null;
		// A pressed trigger stays quiet until the pointer leaves it.
		let pressed: HTMLElement | null = null;
		let warmUntil = 0;

		function hide(instant = false) {
			clearTimeout(timer);
			timer = undefined;
			if (tooltip.hasAttribute("data-visible")) warmUntil = performance.now() + WARM;
			if (instant) tooltip.setAttribute("data-instant", "");
			else tooltip.removeAttribute("data-instant");
			tooltip.removeAttribute("data-visible");
			if (active && originalTitle !== null && !active.hasAttribute("title")) {
				active.setAttribute("title", originalTitle);
			}
			active = null;
			originalTitle = null;
		}

		function enter(button: HTMLElement | null) {
			if (button === active) return;
			hide();
			if (!button || button === pressed) return;
			active = button;
			originalTitle = button.getAttribute("title");
			if (originalTitle !== null) button.removeAttribute("title");
			let show = (instant: boolean) => {
				timer = undefined;
				if (!button.isConnected || openPopup(button)) return hide();
				if (instant) tooltip.setAttribute("data-instant", "");
				else tooltip.removeAttribute("data-instant");
				let label = button.getAttribute("data-tooltip") ?? button.getAttribute("aria-label")
					?? originalTitle ?? button.querySelector(".sr-only")?.textContent;
				if (!label) return hide();
				tooltip.textContent = tooltipText(label, button.hasAttribute("data-tooltip-verbatim"));
				let rect = button.getBoundingClientRect();
				// A row's description card sits beside its rail (data-tooltip-edge) when there is room.
				if (button.dataset.tooltipSide === "right") {
					tooltip.dataset.side = "right";
					let tooltipBox = tooltip.getBoundingClientRect();
					let right = (button.closest("[data-tooltip-edge]") ?? button).getBoundingClientRect()
						.right;
					if (right + GAP + tooltipBox.width <= window.innerWidth - 8) {
						let half = tooltipBox.height / 2;
						tooltip.style.top = `${
							Math.max(
								8 + half,
								Math.min(rect.top + rect.height / 2, window.innerHeight - 8 - half),
							)
						}px`;
						tooltip.style.left = `${right + GAP}px`;
						tooltip.setAttribute("data-visible", "");
						return;
					}
				}
				tooltip.dataset.side = "bottom";
				let tooltipBox = tooltip.getBoundingClientRect();
				let below = rect.top < tooltipBox.height + GAP;
				tooltip.style.top = `${below ? rect.bottom + GAP : rect.top - GAP}px`;
				tooltip.dataset.side = below ? "bottom" : "top";
				tooltip.style.left = `${
					Math.max(
						8,
						Math.min(
							rect.left + rect.width / 2 - tooltipBox.width / 2,
							window.innerWidth - tooltipBox.width - 8,
						),
					)
				}px`;
				tooltip.setAttribute("data-visible", "");
			};
			if (performance.now() < warmUntil) show(true);
			else timer = setTimeout(() => show(false), DELAY);
		}

		let coarse = window.matchMedia("(pointer: coarse)");

		function pointerOver(event: PointerEvent) {
			if (
				event.pointerType === "touch"
				|| !tooltipTrigger("hover", { coarse: coarse.matches, focusVisible: false })
			) return;
			hovered = iconButton(event.target);
			enter(hovered ?? focused);
		}

		function pointerDown(event: PointerEvent) {
			pressed = iconButton(event.target);
			hide(true);
		}

		function expandedChange(records: MutationRecord[]) {
			for (let record of records) {
				let target = record.target as HTMLElement;
				if (target === active && openPopup(target)) {
					if (target === hovered) pressed = target;
					hide(true);
				}
			}
		}

		function pointerOut(event: PointerEvent) {
			if (
				pressed?.contains(event.target as Node) && !pressed.contains(event.relatedTarget as Node)
			) {
				pressed = null;
			}
			if (
				hovered?.contains(event.target as Node)
				&& !hovered.contains(event.relatedTarget as Node)
			) {
				hovered = null;
				enter(focused);
			}
		}

		function focusOut(event: FocusEvent) {
			if (
				focused?.contains(event.target as Node)
				&& !focused.contains(event.relatedTarget as Node)
			) {
				focused = null;
				enter(hovered);
			}
		}

		function focusIn(event: FocusEvent) {
			let target = event.target;
			if (!(target instanceof Element) || !focusVisible(target)) return;
			dismissed = null;
			focused = iconButton(target);
			enter(hovered ?? focused);
		}

		function scroll() {
			hovered = null;
			let current = keyboardFocused(document.activeElement);
			focused = current === dismissed ? null : current;
			hide();
			if (focused) enter(focused);
		}

		document.addEventListener("pointerover", pointerOver, true);
		document.addEventListener("pointerout", pointerOut, true);
		document.addEventListener("focusin", focusIn, true);
		document.addEventListener("focusout", focusOut, true);
		document.addEventListener("pointerdown", pointerDown, true);
		let observer = new MutationObserver(expandedChange);
		observer.observe(document.body, {
			attributes: true,
			attributeFilter: ["aria-expanded"],
			subtree: true,
		});
		document.addEventListener("scroll", scroll, true);
		let resize = () => hide();
		window.addEventListener("resize", resize);
		let keyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (focused) dismissed = focused;
			focused = null;
			hide();
		};
		document.addEventListener("keydown", keyDown, true);
		return () => {
			hide();
			tooltip.remove();
			document.removeEventListener("pointerover", pointerOver, true);
			document.removeEventListener("pointerout", pointerOut, true);
			document.removeEventListener("focusin", focusIn, true);
			document.removeEventListener("focusout", focusOut, true);
			document.removeEventListener("pointerdown", pointerDown, true);
			observer.disconnect();
			document.removeEventListener("scroll", scroll, true);
			window.removeEventListener("resize", resize);
			document.removeEventListener("keydown", keyDown, true);
		};
	}, []);
	return null;
}
