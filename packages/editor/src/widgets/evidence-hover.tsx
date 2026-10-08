import { ChevronIcon, CloseIcon } from "@chopin/icons";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

import { evidencePoint } from "../evidence-geometry";
import type { EvidenceSide } from "../evidence-geometry";
import { planScroller } from "../scroll";
import { useTransitionPresence } from "../transition-presence";

import type { CSSProperties, ReactNode } from "react";

/** What a host knows about a card's evidence: a one-line summary and the full listing. */
export type DecisionEvidence = {
	summary: ReactNode;
	content: ReactNode;
	/** The host's popover motion contract. */
	motion?: { readonly className: string; readonly closeDuration: number };
};

type Position = { top: number; left: number; side: EvidenceSide };
type EvidenceControl = {
	active: boolean;
	summary: ReactNode;
	open: boolean;
	id: string;
	trigger: React.RefObject<HTMLButtonElement | null>;
	toggle: () => void;
};

let EvidenceContext = createContext<EvidenceControl | null>(null);

export function useEvidenceAvailable(): boolean {
	return !!useContext(EvidenceContext)?.active;
}

/** The card's evidence summary, which is also the only way to open the listing. */
export function EvidenceTrigger() {
	let evidence = useContext(EvidenceContext);
	if (!evidence?.active) return null;
	return (
		<button
			aria-controls={evidence.open ? evidence.id : undefined}
			aria-expanded={evidence.open}
			aria-haspopup="dialog"
			className="question-evidence btn btn-sm btn-ghost"
			onClick={evidence.toggle}
			ref={evidence.trigger}
			type="button"
		>
			<span className="sr-only">Evidence:</span>
			{evidence.summary}
			<ChevronIcon aria-hidden="true" size={12} />
		</button>
	);
}

/** Evidence remains card-local, but opens only through its summary control. */
export function EvidenceHover({ active, children, evidence, question }: {
	active: boolean;
	children: ReactNode;
	evidence: DecisionEvidence | null;
	question: string;
}) {
	let content = evidence?.content ?? null;
	let [open, setOpen] = useState(false);
	let [position, setPosition] = useState<Position>();
	let card = useRef<HTMLDivElement>(null);
	let panel = useRef<HTMLDivElement>(null);
	let trigger = useRef<HTMLButtonElement>(null);
	let focusPending = useRef(false);
	let id = useId();
	let visible = active && !!content && open;
	// The listing that is fading out keeps what it showed when it was dismissed.
	let motion = evidence?.motion;
	let presence = useTransitionPresence(
		visible ? content : undefined,
		motion?.closeDuration ?? 0,
		!motion,
	);
	let revealed = useRef(false);
	let dismiss = useCallback((returnFocus = false) => {
		focusPending.current = false;
		setOpen(false);
		if (returnFocus) trigger.current?.focus({ preventScroll: true });
	}, []);

	useEffect(() => {
		if (!active || !content) dismiss();
	}, [active, content, dismiss]);
	useLayoutEffect(() => {
		if (!visible || !position || !focusPending.current) return;
		focusPending.current = false;
		// The dialog takes focus itself, so its close control does not open with a tooltip.
		panel.current?.focus();
	}, [visible, position]);

	useEffect(() => {
		if (!visible) return;
		let onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			dismiss(true);
		};
		let onPointerDown = (event: PointerEvent) => {
			let target = event.target;
			if (!(target instanceof Node)) return;
			if (!trigger.current?.contains(target) && !panel.current?.contains(target)) dismiss();
		};
		let onFocus = (event: FocusEvent) => {
			let target = event.target;
			if (!(target instanceof Node)) return;
			if (!trigger.current?.contains(target) && !panel.current?.contains(target)) dismiss();
		};
		let onHidden = () => {
			if (document.hidden) dismiss();
		};
		document.addEventListener("keydown", onKey, true);
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("focusin", onFocus);
		document.addEventListener("visibilitychange", onHidden);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("focusin", onFocus);
			document.removeEventListener("visibilitychange", onHidden);
		};
	}, [visible, dismiss]);
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
			let bounds = anchor.getBoundingClientRect();
			let scroller = planScroller(card.current);
			let viewport = scroller?.getBoundingClientRect();
			if (
				viewport
				&& (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom)
			) {
				dismiss();
				return;
			}
			let next = evidencePoint(
				bounds,
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
		document.addEventListener("scroll", place, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", place);
			document.removeEventListener("scroll", place, true);
		};
	}, [visible, content, dismiss]);

	// A sheet must not cover the card it explains: lift the card's actions above it once.
	useLayoutEffect(() => {
		if (!visible || position?.side !== "sheet" || revealed.current) return;
		revealed.current = true;
		let summary = trigger.current?.getBoundingClientRect();
		let owner = planScroller(card.current)
			?? card.current?.closest<HTMLElement>("[data-plan-decisions-scroll]");
		let sheet = panel.current?.offsetHeight;
		if (!summary || !owner || !sheet) return;
		let overlap = summary.bottom + 12 - (innerHeight - sheet);
		if (overlap > 0) owner.scrollTop += overlap;
	}, [visible, position]);

	return (
		<EvidenceContext.Provider
			value={{
				active,
				summary: evidence?.summary,
				open: visible,
				id,
				trigger,
				toggle: () => {
					if (visible) dismiss();
					else {
						focusPending.current = true;
						revealed.current = false;
						setPosition(undefined);
						setOpen(true);
					}
				},
			}}
		>
			<div
				className="plan-evidence-host"
				data-evidence-available={active ? "" : undefined}
				ref={card}
			>
				{children}
				{presence.phase !== "closed" && createPortal(
					<div className="plan-evidence-popover">
						<div
							aria-hidden={visible ? undefined : true}
							aria-label={`Evidence for ${question}`}
							className={`plan-evidence-panel ${motion?.className ?? ""} ${presence.className}`}
							data-motion-presentation={position?.side === "sheet" ? "sheet" : undefined}
							data-side={position?.side}
							id={id}
							inert={!visible}
							onClick={event => {
								if (event.target instanceof Element && event.target.closest("button")) dismiss();
							}}
							ref={panel}
							role="dialog"
							style={!position
								? { left: 0, top: 0, visibility: "hidden" }
								: position.side === "sheet"
								? undefined
								: {
									left: position.left,
									top: position.top,
									"--motion-origin-x": position.side === "left" ? "100%" : "0%",
									"--motion-origin-y": position.side === "above" ? "100%" : "0%",
								} as CSSProperties}
							tabIndex={-1}
						>
							<header className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-page py-1.5 pr-1.5 pl-3">
								<h3 className="m-0 text-sm font-medium text-text-primary">Evidence</h3>
								<button
									aria-label="Close evidence"
									className="btn btn-icon btn-ghost"
									onClick={event => {
										event.stopPropagation();
										dismiss(true);
									}}
									type="button"
								>
									<CloseIcon aria-hidden="true" size={14} />
								</button>
							</header>
							{presence.value}
						</div>
					</div>,
					document.body,
				)}
			</div>
		</EvidenceContext.Provider>
	);
}
