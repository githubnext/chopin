import { useEffect } from "react";

const DELAY = 400;
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

function iconButton(target: EventTarget | null): HTMLButtonElement | null {
	if (!(target instanceof Element)) return null;
	let button = target.closest<HTMLButtonElement>("button");
	if (
		!button || button.disabled || button.closest("[inert]")
		|| button.matches(
			".sr-only, .navigation-drawer-backdrop, .navigation-modal-backdrop, .plan-comment-button",
		)
	) {
		return null;
	}
	if (hasVisibleText(button)) return null;
	if (
		!button.getAttribute("data-tooltip") && !button.getAttribute("aria-label")
		&& !button.getAttribute("title") && !button.querySelector(".sr-only")
	) return null;
	return button;
}

export function IconTooltip() {
	useEffect(() => {
		let tooltip = document.createElement("div");
		tooltip.className = "icon-tooltip";
		tooltip.setAttribute("data-icon-tooltip", "");
		tooltip.setAttribute("aria-hidden", "true");
		document.body.append(tooltip);
		let active: HTMLButtonElement | null = null;
		let hovered: HTMLButtonElement | null = null;
		let focused: HTMLButtonElement | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let originalTitle: string | null = null;

		function hide() {
			clearTimeout(timer);
			timer = undefined;
			tooltip.removeAttribute("data-visible");
			if (active && originalTitle !== null && !active.hasAttribute("title")) {
				active.setAttribute("title", originalTitle);
			}
			active = null;
			originalTitle = null;
		}

		function enter(button: HTMLButtonElement | null) {
			if (button === active) return;
			hide();
			if (!button) return;
			active = button;
			originalTitle = button.getAttribute("title");
			if (originalTitle !== null) button.removeAttribute("title");
			timer = setTimeout(() => {
				if (!button.isConnected) return hide();
				let label = button.getAttribute("data-tooltip") ?? button.getAttribute("aria-label")
					?? originalTitle ?? button.querySelector(".sr-only")?.textContent;
				if (!label) return hide();
				tooltip.textContent = label.trim().replace(
					/(^|\s)([a-z])/g,
					(_, space, letter) => space + letter.toUpperCase(),
				);
				let rect = button.getBoundingClientRect();
				let below = rect.top < tooltip.offsetHeight + GAP;
				tooltip.style.top = `${below ? rect.bottom + GAP : rect.top - GAP}px`;
				tooltip.dataset.side = below ? "bottom" : "top";
				tooltip.style.left = `${
					Math.max(
						8,
						Math.min(
							rect.left + rect.width / 2 - tooltip.offsetWidth / 2,
							window.innerWidth - tooltip.offsetWidth - 8,
						),
					)
				}px`;
				tooltip.setAttribute("data-visible", "");
			}, DELAY);
		}

		function pointerOver(event: PointerEvent) {
			if (event.pointerType === "touch") return;
			hovered = iconButton(event.target);
			enter(hovered ?? focused);
		}

		function pointerOut(event: PointerEvent) {
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
			focused = iconButton(event.target);
			enter(hovered ?? focused);
		}

		function scroll() {
			hovered = null;
			focused = iconButton(document.activeElement);
			hide();
			if (focused) enter(focused);
		}

		document.addEventListener("pointerover", pointerOver, true);
		document.addEventListener("pointerout", pointerOut, true);
		document.addEventListener("focusin", focusIn, true);
		document.addEventListener("focusout", focusOut, true);
		document.addEventListener("pointerdown", hide, true);
		document.addEventListener("scroll", scroll, true);
		window.addEventListener("resize", hide);
		let keyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") hide();
		};
		document.addEventListener("keydown", keyDown, true);
		return () => {
			hide();
			tooltip.remove();
			document.removeEventListener("pointerover", pointerOver, true);
			document.removeEventListener("pointerout", pointerOut, true);
			document.removeEventListener("focusin", focusIn, true);
			document.removeEventListener("focusout", focusOut, true);
			document.removeEventListener("pointerdown", hide, true);
			document.removeEventListener("scroll", scroll, true);
			window.removeEventListener("resize", hide);
			document.removeEventListener("keydown", keyDown, true);
		};
	}, []);
	return null;
}
