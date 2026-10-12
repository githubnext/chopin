/** Phone chrome: a floating bottom tab bar and a top bar that tucks away while reading. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Count } from "@chopin/editor/count";
import { DecisionIcon, DocumentIcon, MessageIcon, WrenchIcon } from "@chopin/icons";

import { DocumentActivityDot } from "./document-activity";
import "./phone-workspace.css";

import type { CSSProperties, ReactNode, RefObject } from "react";
import type { DocumentActivity } from "./document-activity";
import type { WorkspaceDestination } from "./workspace-model";

/** Scrolled less than this from the top, the top bar always shows. */
const TOP_BAR_REVEAL = 60;
/** Ignore scroll jitter smaller than this before hiding or showing the top bar. */
const TOP_BAR_SLOP = 6;

const SCROLLERS =
	"[data-plan-scroll], [data-plan-decisions-scroll], [data-build-view-scroll], [data-chat-scroll]";

const ICONS = { build: WrenchIcon, chat: MessageIcon, decisions: DecisionIcon, plan: DocumentIcon };
const NAMES = { build: "Build", chat: "Chat", decisions: "Decisions", plan: "Document" };

export function PhoneTabBar(
	{
		action,
		active,
		buildReason,
		chatActivity,
		destinations,
		documentActivity,
		labels,
		minimised = false,
		onRestore,
		onSelect,
		toolbar,
		unanswered,
	}: {
		/** The circular control at the bar's trailing end, such as an edit toggle. */
		action?: ReactNode;
		active: WorkspaceDestination;
		/** Set while Build cannot open yet: the id of the text that says why. */
		buildReason?: string;
		chatActivity: { unread: number; busy: boolean };
		destinations: WorkspaceDestination[];
		documentActivity?: DocumentActivity;
		labels: Record<WorkspaceDestination, string>;
		/** Shrinks the tabs to one circle showing the current tab while reading down a pane. */
		minimised?: boolean;
		onRestore?: () => void;
		onSelect: (destination: WorkspaceDestination, current: boolean, source: HTMLElement) => void;
		/** Takes the tabs' place while set, such as formatting while editing; stays above the keyboard. */
		toolbar?: ReactNode;
		unanswered: number;
	},
) {
	let index = destinations.indexOf(active);
	let small = minimised && !toolbar;
	let nav = useRef<HTMLElement>(null);
	let restoring = useRef(false);
	// Restoring from the circle hands focus to the current tab, since the circle itself goes inert.
	useLayoutEffect(() => {
		if (small || !restoring.current) return;
		restoring.current = false;
		nav.current?.querySelector<HTMLElement>('.phone-tab[aria-current="page"]')?.focus({
			preventScroll: true,
		});
	}, [small]);
	let restore = (focus: boolean) => {
		restoring.current = focus;
		onRestore?.();
	};
	let ActiveIcon = index < 0 ? undefined : ICONS[active];
	// The circle shows one icon, so it marks unseen activity on any other tab with a dot.
	let elsewhere = (active !== "decisions" && unanswered > 0)
		|| (active !== "chat" && (chatActivity.busy || chatActivity.unread > 0));
	return (
		<div
			className="phone-tab-row"
			data-phone-tab-minimised={small ? "" : undefined}
			data-phone-tab-row=""
			data-phone-tab-toolbar={toolbar ? "" : undefined}
		>
			{toolbar && <div className="phone-tab-toolbar">{toolbar}</div>}
			<nav
				hidden={!!toolbar}
				aria-label="Workspace view"
				className="phone-tab-bar"
				ref={nav}
				style={{ "--phone-tab-count": destinations.length } as CSSProperties}
			>
				<span
					aria-hidden="true"
					className="phone-tab-indicator"
					hidden={index < 0}
					style={{ "--phone-tab-index": Math.max(0, index) } as CSSProperties}
				/>
				{destinations.map(destination => {
					let current = destination === active;
					let unavailable = destination === "build" && buildReason !== undefined;
					let Icon = ICONS[destination];
					return (
						<button
							aria-current={current ? "page" : undefined}
							aria-describedby={unavailable ? buildReason : undefined}
							aria-disabled={unavailable || undefined}
							aria-label={labels[destination]}
							className="phone-tab"
							data-press="small"
							inert={small}
							key={destination}
							onClick={event => {
								if (!unavailable) onSelect(destination, current, event.currentTarget);
							}}
							type="button"
						>
							<span className="phone-tab-icon">
								<Icon aria-hidden="true" size={24} />
								{destination === "plan" && !current && (
									<DocumentActivityDot activity={documentActivity} placement="corner" />
								)}
								{destination === "decisions" && unanswered > 0 && (
									<span aria-hidden="true" className="phone-tab-badge" data-plan-decision-count>
										<Count motion ring>{unanswered}</Count>
									</span>
								)}
								{destination === "chat" && !current
									&& (chatActivity.busy || chatActivity.unread > 0) && (
									<span
										aria-hidden="true"
										className="phone-tab-dot"
										data-busy={chatActivity.busy || undefined}
									/>
								)}
							</span>
							<span aria-hidden="true" className="phone-tab-label">{NAMES[destination]}</span>
							{destination === "decisions" && unanswered > 0 && (
								<span aria-hidden="true" className="phone-tab-badge-inline">
									<Count>{unanswered}</Count>
								</span>
							)}
						</button>
					);
				})}
				{ActiveIcon && (
					<button
						aria-hidden={small ? undefined : true}
						aria-label={`Show tabs, ${labels[active]}`}
						className="phone-tab-mini"
						data-press="small"
						inert={!small}
						onClick={() => restore(true)}
						onFocus={() => restore(true)}
						type="button"
					>
						<span className="phone-tab-icon">
							<ActiveIcon aria-hidden="true" size={24} />
							{active === "decisions" && unanswered > 0 && (
								<span aria-hidden="true" className="phone-tab-badge">
									<Count ring>{unanswered}</Count>
								</span>
							)}
							{elsewhere && <span aria-hidden="true" className="phone-tab-dot" />}
						</span>
					</button>
				)}
			</nav>
			{action}
		</div>
	);
}

/** The active pane's own scroller, so tapping its tab again can return to the top. */
export function phonePaneScroller(pane: Element | null | undefined): HTMLElement | undefined {
	return pane?.querySelector<HTMLElement>(SCROLLERS) ?? undefined;
}

/**
 * Hides the top bar and minimises the tab bar while reading down the document, Decisions or Build,
 * and brings both back on any scroll up, or when focus moves into either. Chat keeps its bar, because new messages scroll
 * the transcript on their own. The bar's small title waits until the document's own heading
 * has scrolled under the bar; other destinations have no heading, so it always shows there.
 */
export function usePhoneTopBar(
	root: RefObject<HTMLElement | null>,
	enabled: boolean,
	destination: WorkspaceDestination,
): { hidden: boolean; show: () => void; titleHidden: boolean } {
	let [hidden, setHidden] = useState(false);
	let [headingVisible, setHeadingVisible] = useState(true);
	useEffect(() => setHidden(false), [destination, enabled]);
	useEffect(() => {
		let element = root.current;
		if (!enabled || !element) return;
		let reduced = matchMedia("(prefers-reduced-motion: reduce)");
		let last = new WeakMap<Element, number>();
		let frame = 0;
		// Collaborative edits mutate the document often; measure at most once a frame.
		let measure = () => {
			if (!frame) frame = requestAnimationFrame(measureNow);
		};
		let measureNow = () => {
			frame = 0;
			let scroller = element.querySelector<HTMLElement>(
				'[data-document-view="plan"] [data-plan-scroll]',
			);
			let heading = scroller?.querySelector(".plan-content h1");
			let bar = element.querySelector<HTMLElement>(".phone-top-bar");
			// Until the document arrives its skeleton stands in for the heading, so the title waits.
			if (scroller?.querySelector(".phone-skeleton-page")) return setHeadingVisible(true);
			if (!scroller || !heading || !bar) return setHeadingVisible(false);
			let barBottom = scroller.getBoundingClientRect().top + bar.offsetHeight;
			setHeadingVisible(heading.getBoundingClientRect().bottom > barBottom);
		};
		let scroll = (event: Event) => {
			let target = event.target;
			if (!(target instanceof HTMLElement) || !target.matches(SCROLLERS)) return;
			if (target.matches("[data-plan-scroll]")) measure();
			// Rubber-banding past either end is not a reading direction.
			let y = Math.min(
				Math.max(0, target.scrollTop),
				Math.max(0, target.scrollHeight - target.clientHeight),
			);
			// Panes open at their top, so a first scroll event already has a direction.
			let previous = last.get(target) ?? 0;
			last.set(target, y);
			if (reduced.matches || target.matches("[data-chat-scroll]")) return;
			if (y < TOP_BAR_REVEAL || previous - y > TOP_BAR_SLOP) setHidden(false);
			else if (y - previous > TOP_BAR_SLOP) setHidden(true);
		};
		let focus = (event: FocusEvent) => {
			if (
				event.target instanceof Element && event.target.closest(".phone-top-bar, .phone-tab-row")
			) {
				setHidden(false);
			}
		};
		// The heading arrives with the document, after this effect first runs.
		let content = new ResizeObserver(measure);
		let observed = element.querySelector('[data-document-view="plan"]');
		if (observed) content.observe(observed);
		let mutations = new MutationObserver(measure);
		if (observed) mutations.observe(observed, { childList: true, subtree: true });
		measure();
		element.addEventListener("scroll", scroll, { capture: true, passive: true });
		element.addEventListener("focusin", focus);
		return () => {
			cancelAnimationFrame(frame);
			content.disconnect();
			mutations.disconnect();
			element.removeEventListener("scroll", scroll, { capture: true });
			element.removeEventListener("focusin", focus);
		};
	}, [enabled, root]);
	let show = useCallback(() => setHidden(false), []);
	return {
		hidden: enabled && hidden,
		show,
		titleHidden: enabled && destination === "plan" && headingVisible,
	};
}
