import { useEffect, useId, useState } from "react";

import "./document-contents.css";

import type { CSSProperties, RefObject } from "react";

export type ContentsHeading = { element: HTMLElement; level: number; text: string };

/** The top-level headings of the document on show, skipping any inside cards or tables. */
export function documentHeadings(root: ParentNode | null | undefined): ContentsHeading[] {
	let content = root?.querySelector<HTMLElement>(".plan-content");
	if (!content) return [];
	return [...content.querySelectorAll<HTMLElement>(":scope > :is(h1, h2, h3)")]
		.map(element => ({
			element,
			level: Number(element.tagName.slice(1)),
			text: element.textContent?.trim() ?? "",
		}))
		.filter(heading => heading.text);
}

/** The heading whose section holds the top of the scroller's view. */
export function currentHeading(headings: ContentsHeading[]): ContentsHeading | undefined {
	let scroller = headings[0]?.element.closest<HTMLElement>("[data-plan-scroll]");
	if (!scroller) return headings[0];
	// A heading just scrolled to sits at the top; a little slack keeps it current.
	let top = scroller.getBoundingClientRect().top + Math.min(scroller.clientHeight / 4, 96);
	let found = headings[0];
	for (let heading of headings) {
		if (heading.element.getBoundingClientRect().top > top) break;
		found = heading;
	}
	return found;
}

function sameOutline(a: ContentsHeading[], b: ContentsHeading[]): boolean {
	return a.length === b.length
		&& a.every((heading, index) =>
			heading.element === b[index]!.element
			&& heading.text === b[index]!.text
			&& heading.level === b[index]!.level
		);
}

/** The opening prose of a heading's section, up to the next heading of any level. */
export function sectionExcerpt(heading: HTMLElement, limit = 240): string {
	let text = "";
	for (
		let node = heading.nextElementSibling;
		node && !/^H[1-6]$/.test(node.tagName) && text.length < limit;
		node = node.nextElementSibling
	) {
		// Prose only: code, tables and widgets carry chrome (language labels, cells) that reads badly.
		if (!/^(P|UL|OL|BLOCKQUOTE)$/.test(node.tagName)) continue;
		// innerText keeps the breaks between list items that textContent runs together.
		let part = (node as HTMLElement).innerText?.replace(/\s+/g, " ").trim();
		if (part) text += (text ? " " : "") + part;
	}
	return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/**
 * The outline of the document on show as quiet ticks in its right margin, one per heading. Hovering
 * or focusing a tick peeks at that section beside it; choosing one scrolls there. It follows edits,
 * an earlier version replacing the live document, and the reader's scroll.
 */
export function DocumentContents(
	{ area, root }: {
		/** Holds every document that can be on show; watched for edits and scrolls. */
		area: RefObject<HTMLElement | null>;
		/** The document on show now. */
		root: () => ParentNode | null | undefined;
	},
) {
	let id = useId();
	let [headings, setHeadings] = useState<ContentsHeading[]>([]);
	let [current, setCurrent] = useState<HTMLElement>();
	let [peek, setPeek] = useState<{ index: number; top: number }>();
	// The card keeps its last section while it fades out, so it never empties mid-fade.
	let [shown, setShown] = useState<{ index: number; top: number }>();

	useEffect(() => {
		let container = area.current;
		if (!container) return;
		let frame = 0;
		let found: ContentsHeading[] = [];
		let outline = () => {
			found = documentHeadings(root());
			setHeadings(previous => sameOutline(previous, found) ? previous : found);
			setCurrent(currentHeading(found)?.element);
		};
		let schedule = (refresh: () => void) => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(refresh);
		};
		let observer = new MutationObserver(() => schedule(outline));
		observer.observe(container, {
			attributeFilter: ["hidden"],
			attributes: true,
			characterData: true,
			childList: true,
			subtree: true,
		});
		let scrolled = () => schedule(() => setCurrent(currentHeading(found)?.element));
		container.addEventListener("scroll", scrolled, { capture: true, passive: true });
		outline();
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			container.removeEventListener("scroll", scrolled, { capture: true });
		};
	}, [area, root]);

	if (headings.length < 2) return null;
	let shallowest = Math.min(...headings.map(heading => heading.level));
	let open = (index: number, tick: HTMLElement) => {
		let next = { index, top: tick.offsetTop + tick.offsetHeight / 2 };
		setPeek(next);
		setShown(next);
	};
	let card = shown && headings[shown.index];
	return (
		<nav
			aria-label="Contents"
			className="document-contents"
			onMouseLeave={() => setPeek(undefined)}
			style={{ "--contents-count": headings.length } as CSSProperties}
		>
			<ol className="document-contents-ticks">
				{headings.map((heading, index) => (
					<li key={index}>
						<button
							aria-current={heading.element === current ? "location" : undefined}
							aria-describedby={peek?.index === index ? `${id}-peek` : undefined}
							aria-labelledby={`${id}-${index}`}
							className="document-contents-tick"
							data-depth={Math.min(heading.level - shallowest, 2)}
							data-peeked={peek?.index === index ? "" : undefined}
							onBlur={() => setPeek(undefined)}
							onClick={() => {
								let still = matchMedia("(prefers-reduced-motion: reduce)").matches;
								heading.element.scrollIntoView({
									behavior: still ? "auto" : "smooth",
									block: "start",
								});
							}}
							onFocus={event => open(index, event.currentTarget)}
							onMouseEnter={event => open(index, event.currentTarget)}
							type="button"
						/>
					</li>
				))}
			</ol>
			{/* Names live outside the ticks, so the shared icon tooltip leaves them to the peek. */}
			<div hidden>
				{headings.map((heading, index) => (
					<span id={`${id}-${index}`} key={index}>{heading.text}</span>
				))}
			</div>
			<div
				aria-hidden={!peek}
				className="document-contents-peek"
				data-open={peek ? "" : undefined}
				id={`${id}-peek`}
				style={{ "--peek-top": `${shown?.top ?? 0}px` } as CSSProperties}
			>
				{card && (
					<>
						<p className="document-contents-peek-title">{card.text}</p>
						<p className="document-contents-peek-text">{sectionExcerpt(card.element)}</p>
					</>
				)}
			</div>
		</nav>
	);
}
