/**
 * A Mermaid diagram in a decision card.
 *
 * Drawn by the document's own Mermaid renderer, theme and strict security
 * level, inside the same frame. A card is narrow, so a wide chart opens fitted
 * to its width, with "Actual size" to scroll it at its drawn size instead, and
 * a phone can open it full screen. A card is short, so a tall drawing is held to
 * a bounded height until the reader expands it. Nothing is loaded or drawn until
 * the card is near the viewport, and a source Mermaid cannot draw is shown as
 * code rather than an error.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { Diagram, renderMermaid } from "./render-blocks";

import type { RefObject } from "react";

type Drawn = { source: string; html: string } | { source: string; failed: true };

/** Starts work once the element is within a screen of the viewport. */
function useNear(element: RefObject<HTMLElement | null>): boolean {
	let [near, setNear] = useState(false);
	useEffect(() => {
		let target = element.current;
		if (near || !target) return;
		if (typeof IntersectionObserver === "undefined") {
			setNear(true);
			return;
		}
		let observer = new IntersectionObserver(entries => {
			if (entries.some(entry => entry.isIntersecting)) setNear(true);
		}, { rootMargin: "100% 0px" });
		observer.observe(target);
		return () => observer.disconnect();
	}, [element, near]);
	return near;
}

export function CardDiagram({ source }: { source: string }) {
	// Mermaid uses the key in element IDs and CSS selectors, so it keeps to letters and digits.
	let key = `card-${useId().replace(/[^A-Za-z0-9]/g, "")}`;
	let frame = useRef<HTMLDivElement>(null);
	let near = useNear(frame);
	let [drawn, setDrawn] = useState<Drawn>();
	let [expanded, setExpanded] = useState(false);
	let [overflows, setOverflows] = useState(false);

	useEffect(() => {
		if (!near) return;
		let cancelled = false;
		renderMermaid(key, source).then(
			html => !cancelled && setDrawn({ source, html }),
			() => !cancelled && setDrawn({ source, failed: true }),
		);
		return () => {
			cancelled = true;
		};
	}, [key, near, source]);

	let current = drawn?.source === source ? drawn : undefined;
	let html = current && "html" in current ? current.html : undefined;

	useLayoutEffect(() => {
		let element = frame.current;
		if (!element || !html) return;
		// The drawing and its controls, laid end to end, against the frame's bounded height.
		let measure = () => {
			let content = [...element.children].reduce(
				(total, child) => total + child.getBoundingClientRect().height,
				0,
			);
			setOverflows(content > element.clientHeight + 1);
		};
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [html, expanded]);

	if (current && "failed" in current) {
		return (
			<pre className="question-diagram-source" data-question-diagram="failed">
				<code>{source}</code>
			</pre>
		);
	}
	return (
		<div className="question-diagram" data-question-diagram={html ? "drawn" : "pending"}>
			<div
				ref={frame}
				className="question-diagram-frame"
				data-bounded={expanded ? undefined : ""}
				data-overflows={overflows && !expanded ? "" : undefined}
			>
				{html
					? <Diagram id={key} html={html} stale={false} fitted />
					: <div aria-label="Drawing diagram" className="question-diagram-pending" role="img" />}
			</div>
			{html && (overflows || expanded) && (
				<div className="question-diagram-more">
					<button
						aria-expanded={expanded}
						className="btn btn-sm btn-ghost text-text-tertiary"
						onClick={() => setExpanded(!expanded)}
						type="button"
					>
						{expanded ? "Show less" : "Show whole diagram"}
					</button>
				</div>
			)}
		</div>
	);
}
