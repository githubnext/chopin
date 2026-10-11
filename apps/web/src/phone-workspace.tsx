/** Phone chrome: a floating bottom tab bar and a top bar that tucks away while reading. */

import { useEffect, useState } from "react";
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
		onSelect,
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
		onSelect: (destination: WorkspaceDestination, current: boolean, source: HTMLElement) => void;
		unanswered: number;
	},
) {
	let index = destinations.indexOf(active);
	return (
		<div className="phone-tab-row" data-phone-tab-row="">
			<nav
				aria-label="Workspace view"
				className="phone-tab-bar"
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
						</button>
					);
				})}
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
 * Hides the top bar while reading down the document or Decisions and brings it back on any
 * scroll up. Chat keeps its bar, because new messages scroll the transcript on their own.
 */
export function usePhoneTopBar(
	frame: RefObject<HTMLElement | null>,
	enabled: boolean,
	destination: WorkspaceDestination,
): boolean {
	let [hidden, setHidden] = useState(false);
	useEffect(() => setHidden(false), [destination, enabled]);
	useEffect(() => {
		let element = frame.current;
		if (!enabled || !element) return;
		let reduced = matchMedia("(prefers-reduced-motion: reduce)");
		let last = new WeakMap<Element, number>();
		let scroll = (event: Event) => {
			let target = event.target;
			if (!(target instanceof HTMLElement) || !target.matches(SCROLLERS)) return;
			let y = target.scrollTop;
			let previous = last.get(target) ?? y;
			last.set(target, y);
			if (reduced.matches || target.matches("[data-chat-scroll]")) return;
			if (y < TOP_BAR_REVEAL || previous - y > TOP_BAR_SLOP) setHidden(false);
			else if (y - previous > TOP_BAR_SLOP) setHidden(true);
		};
		element.addEventListener("scroll", scroll, { capture: true, passive: true });
		return () => element.removeEventListener("scroll", scroll, { capture: true });
	}, [enabled, frame]);
	return enabled && hidden;
}
