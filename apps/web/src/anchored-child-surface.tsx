import { childDocumentPath, documentPath } from "@chopin/protocol/document-url";
import { MagnifierIcon } from "@chopin/icons";
import { Fragment, useLayoutEffect, useRef } from "react";

export { childCloseAction, childFocusTransition, childHistoryState } from "./child-history";
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
	{ entries, focusKey, motion, onClosed, presentation }: {
		entries: { id: string; label: string; node: ReactNode }[];
		focusKey?: string;
		motion: ChildMotionStyle;
		onClosed: () => void;
		origin?: () => DOMRect | undefined;
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
	useLayoutEffect(() => {
		if (presentation !== "closing") return;
		let current = true;
		let running = layer.current?.getAnimations({ subtree: true }) ?? [];
		void Promise.all(running.map(animation => animation.finished)).then(
			() => current && closed.current(),
			() => {},
		);
		return () => {
			current = false;
		};
	}, [presentation]);
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
