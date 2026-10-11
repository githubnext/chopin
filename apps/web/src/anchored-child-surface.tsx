import { childDocumentPath, documentPath } from "@chopin/protocol/document-url";
import { MagnifierIcon } from "@chopin/icons";
import { Fragment, useLayoutEffect, useRef } from "react";

import { closeChild, openChild, rememberOpener } from "./child-motion-driver";
import { openerRect } from "./child-origin";

export { childCloseAction, childFocusTransition, childHistoryState } from "./child-history";
export { animationsSettled } from "./child-motion-driver";
export { childPresentation } from "./document-workspace-state";

import type { CSSProperties, ReactNode } from "react";
import type { ChildMotionStyle } from "./child-motion";
import type { ChildPresentation } from "./document-workspace-state";

export type {
	ChildFocusAttempt,
	ChildFocusEvent,
	ChildFocusState,
	ChildFocusToken,
} from "./child-history";
export type { ChildPresentation } from "./document-workspace-state";

export type ParentDocumentAddress = {
	owner: string;
	repository: string;
	slug: string;
};

export function anchoredChildPaths(parent: ParentDocumentAddress, childSlug?: string) {
	return {
		child: childSlug
			? childDocumentPath(parent.owner, parent.repository, parent.slug, childSlug)
			: undefined,
		parent: documentPath(parent.owner, parent.repository, parent.slug),
	};
}

export function rebaseChildHistoryState(
	state: unknown,
	parent: string,
): unknown {
	if (
		typeof state !== "object" || state === null
		|| !("chopinChildParent" in state)
		|| typeof state.chopinChildParent !== "string"
	) return state;
	let previous = new URL(state.chopinChildParent, "http://chopin.local");
	return {
		...state,
		chopinChildParent: `${parent}${previous.search}${previous.hash}`,
	};
}

export function AnchoredChildSurface(
	{ entries, focusKey, motion, onClosed, origin, presentation }: {
		entries: { id: string; label: string; node: ReactNode }[];
		focusKey?: string;
		motion: ChildMotionStyle;
		onClosed: () => void;
		origin?: () => Element | undefined;
		presentation: ChildPresentation;
	},
) {
	let layer = useRef<HTMLDivElement>(null);
	let focused = useRef<string | undefined>(undefined);
	let closed = useRef(onClosed);
	closed.current = onClosed;
	let depth = entries.length;
	useLayoutEffect(() => {
		if (presentation !== "open" || !focusKey || focused.current === focusKey) return;
		focused.current = focusKey;
		layer.current?.querySelector<HTMLElement>(":scope > .anchored-child-card:last-of-type")
			?.focus({ preventScroll: true });
	}, [focusKey, presentation]);
	let latestOrigin = useRef(origin);
	latestOrigin.current = origin;
	let generation = useRef(0);
	let opening = useRef<{ card: HTMLElement; opener?: Element; rect?: DOMRect; at: number }>(
		undefined,
	);
	let front = () =>
		layer.current?.querySelector<HTMLElement>(":scope > .anchored-child-card:last-of-type");
	useLayoutEffect(() => {
		let card = front();
		if (!card) return;
		let token = ++generation.current;
		if (presentation === "open") {
			let opener = latestOrigin.current?.();
			let rect = openerRect(opener);
			opening.current = { at: performance.now(), card, opener, rect };
			rememberOpener(card, opener);
			openChild(card, rect, motion);
			return;
		}
		opening.current = undefined;
		if (presentation !== "closing") return;
		// The root may have replaced the opener since the open; prefer the one it shows now.
		let live = latestOrigin.current?.();
		if (live?.isConnected) rememberOpener(card, live);
		let done = () => {
			if (generation.current === token) closed.current();
		};
		void closeChild(card, motion).then(done, done);
	}, [presentation]);
	let cardKey = entries.at(-1)?.id;
	useLayoutEffect(() => {
		// A canonical URL can rekey the open card; the new one carries on from the same moment.
		let card = front();
		let open = opening.current;
		if (!card || !open || open.card === card || presentation !== "open") return;
		opening.current = { ...open, card };
		rememberOpener(card, open.opener);
		openChild(card, open.rect, motion);
		let elapsed = performance.now() - open.at;
		for (let animation of layer.current?.getAnimations({ subtree: true }) ?? []) {
			animation.currentTime = elapsed;
		}
	}, [cardKey]);
	return (
		<div className="anchored-child-layer" data-child-motion={motion} ref={layer}>
			{entries.map((entry, index) => (
				<Fragment key={entry.id}>
					{motion === "lift" && <div aria-hidden="true" className="anchored-child-shadow" />}
					<section
						aria-label={`Child document: ${entry.label}`}
						className="anchored-child-card"
						style={{ "--level": index + 1, "--depth": depth } as CSSProperties}
						tabIndex={-1}
					>
						<div className="anchored-child-content">
							{motion === "lift" && (
								<div className="anchored-child-title">
									<MagnifierIcon aria-hidden="true" size={14} />
									<span>{entry.label}</span>
								</div>
							)}
							{entry.node}
						</div>
					</section>
				</Fragment>
			))}
		</div>
	);
}
