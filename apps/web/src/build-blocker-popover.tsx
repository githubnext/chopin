import { ArrowRightIcon } from "@chopin/icons";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { buildBlockerSummary } from "./build-blockers";
import { BuildBlockerGlyph } from "./build-blocker-glyph";
import "./build-blocker-popover.css";

import type { BuildBlocker } from "./build-blockers";

export function BuildBlockerPopover({ hot, items, onHover, onSelect, phone }: {
	hot?: boolean;
	items: readonly BuildBlocker[];
	onHover: (on: boolean) => void;
	onSelect: (item: BuildBlocker) => void;
	phone?: boolean;
}) {
	let id = useId();
	let trigger = useRef<HTMLButtonElement>(null);
	let panel = useRef<HTMLDivElement>(null);
	let pinned = useRef(false);
	let timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	let [open, setOpen] = useState(false);
	let summary = buildBlockerSummary(items);

	let place = useCallback(() => {
		let element = panel.current;
		let anchor = trigger.current?.getBoundingClientRect();
		if (!element || !anchor || !element.matches(":popover-open")) return;
		let margin = 12;
		let gap = 4;
		let width = element.offsetWidth;
		let height = element.offsetHeight;
		let below = anchor.bottom + gap;
		let top = below + height <= innerHeight - margin ? below : anchor.top - gap - height;
		element.style.left = `${
			Math.max(margin, Math.min(anchor.right - width, innerWidth - width - margin))
		}px`;
		element.style.top = `${Math.max(margin, Math.min(top, innerHeight - height - margin))}px`;
		element.style.visibility = "visible";
	}, []);

	useLayoutEffect(() => {
		if (!open) return;
		place();
		let observer = new ResizeObserver(place);
		if (panel.current) observer.observe(panel.current);
		window.addEventListener("resize", place);
		document.addEventListener("scroll", place, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", place);
			document.removeEventListener("scroll", place, true);
		};
	}, [open, place]);
	useEffect(() => () => clearTimeout(timer.current), []);

	let delay = (action: () => void) => {
		clearTimeout(timer.current);
		let token = getComputedStyle(document.documentElement).getPropertyValue("--duration-base");
		let ms = parseFloat(token) * (token.trim().endsWith("ms") ? 1 : 1000);
		timer.current = setTimeout(action, ms);
	};
	let leave = () => {
		clearTimeout(timer.current);
		if (pinned.current) return;
		delay(() => {
			if (!panel.current?.matches(":hover, :focus-within") && !trigger.current?.matches(":hover")) {
				panel.current?.hidePopover();
			}
		});
	};

	return (
		<>
			<button
				aria-controls={id}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={`${summary.label}. Show blockers`}
				className={phone
					? "build-status-link build-blocker-capsule"
					: "build-capsule build-blocker-capsule"}
				data-tone={summary.tone}
				data-hot={hot || undefined}
				onBlur={() => onHover(false)}
				onFocus={() => onHover(true)}
				onClick={event => {
					event.preventDefault();
					clearTimeout(timer.current);
					if (pinned.current && panel.current?.matches(":popover-open")) {
						panel.current.hidePopover();
						return;
					}
					pinned.current = true;
					panel.current?.showPopover({ source: trigger.current! });
					place();
					if (event.detail === 0) panel.current?.querySelector("button")?.focus();
				}}
				onPointerEnter={event => {
					onHover(true);
					clearTimeout(timer.current);
					if (event.pointerType === "touch" || !matchMedia("(hover: hover)").matches) return;
					delay(() => {
						panel.current?.showPopover({ source: trigger.current! });
						place();
					});
				}}
				onPointerLeave={() => {
					onHover(false);
					leave();
				}}
				popoverTarget={id}
				ref={trigger}
				type="button"
			>
				<BuildBlockerGlyph tone={summary.tone} />
				<span className="build-capsule-label">{summary.label}</span>
			</button>
			{typeof document !== "undefined" && createPortal(
				<div
					aria-label="Build blockers"
					className="build-blocker-popover"
					id={id}
					onBeforeToggle={event => {
						if (event.newState === "open") requestAnimationFrame(place);
					}}
					onPointerEnter={() => clearTimeout(timer.current)}
					onPointerLeave={leave}
					onToggle={event => {
						let opened = event.newState === "open";
						setOpen(opened);
						if (!opened) {
							pinned.current = false;
							clearTimeout(timer.current);
						}
					}}
					popover="auto"
					ref={panel}
					role="dialog"
					style={{ visibility: "hidden" }}
				>
					{items.map(item => (
						<button
							aria-label={`${item.kind === "decision" ? "Review" : "Open"}: ${item.title}`}
							className="build-blocker-row"
							key={`${item.kind}:${item.id}:${"question" in item ? item.question : ""}`}
							onClick={() => {
								panel.current?.hidePopover();
								onSelect(item);
							}}
							type="button"
						>
							<BuildBlockerGlyph tone={item.kind} />
							<span className="build-blocker-title">{item.title}</span>
							<ArrowRightIcon aria-hidden="true" className="build-blocker-arrow" />
						</button>
					))}
				</div>,
				document.body,
			)}
		</>
	);
}
