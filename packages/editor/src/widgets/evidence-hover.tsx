import { CodeIcon } from "@chopin/icons";
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
import { planScroller } from "../scroll";

import type { ReactNode } from "react";

type Position = { top: number; left: number; side: "right" | "left" };
type EvidenceControl = {
	active: boolean;
	open: boolean;
	id: string;
	trigger: React.RefObject<HTMLButtonElement | null>;
	toggle: () => void;
};

let EvidenceContext = createContext<EvidenceControl | null>(null);

export function EvidenceTrigger() {
	let evidence = useContext(EvidenceContext);
	if (!evidence?.active) return null;
	return (
		<button
			aria-controls={evidence.open ? evidence.id : undefined}
			aria-expanded={evidence.open}
			aria-label="Inspect decision evidence"
			className="btn btn-icon btn-ghost"
			onClick={evidence.toggle}
			ref={evidence.trigger}
			title="Inspect decision evidence"
			type="button"
		>
			<CodeIcon aria-hidden="true" size={14} />
		</button>
	);
}

/** Evidence remains card-local, but opens only through its header control. */
export function EvidenceHover({ active, children, content, question }: {
	active: boolean;
	children: ReactNode;
	content: ReactNode | null;
	question: string;
}) {
	let [open, setOpen] = useState(false);
	let [position, setPosition] = useState<Position>();
	let card = useRef<HTMLDivElement>(null);
	let panel = useRef<HTMLDivElement>(null);
	let trigger = useRef<HTMLButtonElement>(null);
	let focusPending = useRef(false);
	let id = useId();
	let visible = active && !!content && open;
	let dismiss = useCallback((returnFocus = false) => {
		focusPending.current = false;
		setOpen(false);
		setPosition(undefined);
		if (returnFocus) trigger.current?.focus({ preventScroll: true });
	}, []);

	useEffect(() => {
		if (!active || !content) dismiss();
	}, [active, content, dismiss]);
	useLayoutEffect(() => {
		if (!visible || !position || !focusPending.current) return;
		focusPending.current = false;
		panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
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

	return (
		<EvidenceContext.Provider
			value={{
				active,
				open: visible,
				id,
				trigger,
				toggle: () => {
					if (visible) dismiss();
					else {
						focusPending.current = true;
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
				{visible && createPortal(
					<div className="plan-evidence-popover">
						<div
							aria-label={`Evidence for ${question}`}
							className="plan-evidence-panel"
							data-side={position?.side}
							id={id}
							onClick={event => {
								if (event.target instanceof Element && event.target.closest("button")) dismiss();
							}}
							ref={panel}
							role="dialog"
							style={position
								? { left: position.left, top: position.top }
								: { left: 0, top: 0, visibility: "hidden" }}
						>
							<div className="flex justify-end px-3 pt-2">
								<button
									aria-label="Close evidence"
									className="btn btn-sm btn-ghost"
									onClick={event => {
										event.stopPropagation();
										dismiss(true);
									}}
									type="button"
								>
									Close
								</button>
							</div>
							{content}
						</div>
					</div>,
					document.body,
				)}
			</div>
		</EvidenceContext.Provider>
	);
}
