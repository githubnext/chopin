import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
	evidencePoint,
	HOVER_CLOSE_MS,
	HOVER_OPEN_MS,
	pointerOverCard,
} from "../evidence-geometry";
import { planScroller } from "../scroll";

import type { ReactNode } from "react";

type Phase = "idle" | "pending" | "open";
type Position = { top: number; left: number; side: "right" | "left" };
type Pointer = { x: number; y: number };

/** A card-local hover surface; the wrapper remains mounted as evidence changes. */
export function EvidenceHover({ active, children, content, question }: {
	active: boolean;
	children: ReactNode;
	content: ReactNode | null;
	question: string;
}) {
	let [phase, setPhase] = useState<Phase>("idle");
	let [position, setPosition] = useState<Position>();
	let [suppressed, setSuppressed] = useState(false);
	let card = useRef<HTMLDivElement>(null);
	let panel = useRef<HTMLDivElement>(null);
	let timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	let pointer = useRef<Pointer | undefined>(undefined);
	let suppressedNow = useRef(false);
	let onCard = useRef(false);
	let onPanel = useRef(false);
	let activeNow = useRef(active);
	let phaseNow = useRef(phase);
	activeNow.current = active;
	phaseNow.current = phase;
	let visible = active && phase === "open";

	let clearTimer = useCallback(() => {
		clearTimeout(timer.current);
		timer.current = undefined;
	}, []);
	let clearSuppression = useCallback(() => {
		if (!suppressedNow.current) return;
		suppressedNow.current = false;
		setSuppressed(false);
	}, []);
	let dismiss = useCallback((intentional = false, at?: Pointer) => {
		if (intentional) {
			let article = card.current?.querySelector<HTMLElement>("article");
			let overlaps = !!article
				&& pointerOverCard(article.getBoundingClientRect(), at ?? pointer.current);
			suppressedNow.current = overlaps;
			setSuppressed(overlaps);
		}
		clearTimer();
		onCard.current = false;
		onPanel.current = false;
		phaseNow.current = "idle";
		setPhase("idle");
		setPosition(undefined);
	}, [clearTimer]);
	let focusedPanel = useCallback(() => !!panel.current?.contains(document.activeElement), []);
	let closeLater = useCallback(() => {
		clearTimer();
		if (phaseNow.current !== "open") return;
		if (onCard.current || onPanel.current || focusedPanel()) return;
		timer.current = setTimeout(() => {
			if (!onCard.current && !onPanel.current && !focusedPanel()) dismiss();
		}, HOVER_CLOSE_MS);
	}, [clearTimer, dismiss, focusedPanel]);

	useLayoutEffect(() => {
		if (!active) {
			clearSuppression();
			dismiss();
		}
	}, [active, clearSuppression, dismiss]);
	useEffect(() => () => clearTimer(), [clearTimer]);
	useEffect(() => {
		if (!suppressed) return;
		let move = (event: PointerEvent) => {
			pointer.current = { x: event.clientX, y: event.clientY };
			let article = card.current?.querySelector<HTMLElement>("article");
			if (!article || !pointerOverCard(article.getBoundingClientRect(), pointer.current)) {
				clearSuppression();
			}
		};
		document.addEventListener("pointermove", move, { passive: true });
		return () => document.removeEventListener("pointermove", move);
	}, [clearSuppression, suppressed]);
	useLayoutEffect(() => {
		if (!active) return;
		let article = card.current?.querySelector<HTMLElement>("article");
		if (!article) return;
		let enter = (event: PointerEvent) => {
			pointer.current = { x: event.clientX, y: event.clientY };
			onCard.current = true;
			if (suppressedNow.current) return;
			if (phaseNow.current === "open") {
				clearTimer();
				return;
			}
			clearTimer();
			phaseNow.current = "pending";
			setPhase("pending");
			timer.current = setTimeout(() => {
				if (!activeNow.current) return;
				phaseNow.current = "open";
				setPhase("open");
			}, HOVER_OPEN_MS);
		};
		let leave = (event: PointerEvent) => {
			pointer.current = { x: event.clientX, y: event.clientY };
			onCard.current = false;
			clearSuppression();
			if (phaseNow.current === "pending") dismiss();
			else if (phaseNow.current === "open") closeLater();
		};
		let move = (event: PointerEvent) => {
			pointer.current = { x: event.clientX, y: event.clientY };
		};
		article.addEventListener("pointerenter", enter);
		article.addEventListener("pointerleave", leave);
		article.addEventListener("pointermove", move, { passive: true });
		return () => {
			article.removeEventListener("pointerenter", enter);
			article.removeEventListener("pointerleave", leave);
			article.removeEventListener("pointermove", move);
		};
	}, [active, clearSuppression, clearTimer, closeLater, dismiss]);
	useLayoutEffect(() => {
		if (!visible) return;
		let surface = panel.current;
		if (!surface) return;
		let enter = (event?: PointerEvent) => {
			if (event) pointer.current = { x: event.clientX, y: event.clientY };
			onPanel.current = true;
			clearTimer();
		};
		let leave = (event: PointerEvent) => {
			pointer.current = { x: event.clientX, y: event.clientY };
			onPanel.current = false;
			closeLater();
		};
		let move = (event: PointerEvent) => {
			pointer.current = { x: event.clientX, y: event.clientY };
		};
		surface.addEventListener("pointerenter", enter);
		surface.addEventListener("pointerleave", leave);
		surface.addEventListener("pointermove", move, { passive: true });
		if (surface.matches(":hover")) enter();
		return () => {
			surface.removeEventListener("pointerenter", enter);
			surface.removeEventListener("pointerleave", leave);
			surface.removeEventListener("pointermove", move);
		};
	}, [visible, clearTimer, closeLater]);
	useEffect(() => {
		if (!active || phase === "idle") return;
		let onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			let hadPanelFocus = focusedPanel();
			dismiss(true);
			if (hadPanelFocus) {
				card.current?.querySelector<HTMLElement>("article button")?.focus({ preventScroll: true });
			}
		};
		let onScroll = () => dismiss(true);
		let onFocus = (event: FocusEvent) => {
			let target = event.target;
			if (!(target instanceof Node)) return;
			if (!card.current?.contains(target) && !panel.current?.contains(target)) dismiss();
		};
		let onHidden = () => {
			if (document.hidden) dismiss();
		};
		let scroller = planScroller(card.current);
		document.addEventListener("keydown", onKey, true);
		document.addEventListener("focusin", onFocus);
		document.addEventListener("visibilitychange", onHidden);
		scroller?.addEventListener("scroll", onScroll, { capture: true, passive: true });
		return () => {
			document.removeEventListener("keydown", onKey, true);
			document.removeEventListener("focusin", onFocus);
			document.removeEventListener("visibilitychange", onHidden);
			scroller?.removeEventListener("scroll", onScroll, true);
		};
	}, [active, dismiss, focusedPanel, phase]);

	useLayoutEffect(() => {
		if (!visible) return;
		let anchor = card.current?.querySelector<HTMLElement>("article");
		let surface = panel.current;
		if (!anchor || !surface) return;
		let place = () => {
			if (!anchor.isConnected || anchor.getClientRects().length === 0) {
				dismiss();
				return;
			}
			let next = evidencePoint(
				anchor.getBoundingClientRect(),
				{ width: innerWidth, height: innerHeight },
				surface.offsetWidth,
				surface.offsetHeight,
			);
			setPosition(current =>
				current?.left === next.left && current.top === next.top && current.side === next.side
					? current
					: next
			);
		};
		place();
		let observer = new ResizeObserver(place);
		observer.observe(anchor);
		observer.observe(surface);
		window.addEventListener("resize", place);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", place);
		};
	}, [visible, content, dismiss]);

	return (
		<div
			className="plan-evidence-host"
			data-evidence-hover={active ? "" : undefined}
			ref={card}
		>
			{children}
			{visible && content && createPortal(
				<div className="plan-evidence-popover">
					<div
						aria-label={`Evidence for ${question}`}
						className="plan-evidence-panel"
						data-side={position?.side}
						onBlurCapture={event => {
							let next = event.relatedTarget;
							if (
								!event.currentTarget.contains(next as Node) && !onCard.current && !onPanel.current
							) {
								closeLater();
							}
						}}
						onClick={event => {
							if (event.target instanceof Element && event.target.closest("button")) {
								dismiss(
									true,
									event.detail === 0
										? pointer.current
										: { x: event.clientX, y: event.clientY },
								);
							}
						}}
						onFocusCapture={clearTimer}
						ref={panel}
						role="dialog"
						style={position
							? { left: position.left, top: position.top }
							: { left: 0, top: 0, visibility: "hidden" }}
					>
						{content}
					</div>
				</div>,
				document.body,
			)}
		</div>
	);
}
