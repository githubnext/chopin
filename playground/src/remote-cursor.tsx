import { type CSSProperties, type RefObject, useEffect, useRef } from "react";
import type { Blocks } from "./plan-document";
import { displayName } from "./plans";
import styles from "./plans.module.css";
import type { Cursor } from "./store";

let colors: Record<string, string> = {
	copilot: "var(--fgColor-done)",
	"theo-nguyen": "var(--fgColor-severe)",
};

export function cursorColor(login: string) {
	return colors[login] ?? "var(--fgColor-accent)";
}

function blockAt(blocks: Blocks, pos: number) {
	let index = blocks.findIndex(([start, end]) => pos >= start && pos <= end);
	if (index >= 0) return index;
	return blocks.findLastIndex(([start]) => start <= pos);
}

/**
 * Marks the rendered block a collaborator is editing with a bar in the gutter, and keeps that
 * block's end in view as it grows.
 */
export function RemoteCursor(
	{ body, blocks, cursor }: {
		body: RefObject<HTMLDivElement | null>;
		blocks: Blocks;
		cursor: Cursor;
	},
) {
	let element = useRef<HTMLDivElement>(null);
	let latest = useRef({ blocks, cursor });
	latest.current = { blocks, cursor };

	useEffect(() => {
		let frame = 0;
		let revealed = "";
		let tick = () => {
			frame = requestAnimationFrame(tick);
			let node = element.current;
			let scroller = body.current;
			let { blocks, cursor } = latest.current;
			if (!node) return;
			let rendered = scroller?.querySelector(".markdown-body")?.children;
			let block = cursor && rendered ? rendered[blockAt(blocks, cursor.pos)] : undefined;
			if (!scroller || !block) {
				node.hidden = true;
				revealed = "";
				return;
			}
			let bounds = scroller.getBoundingClientRect();
			// Block wrappers use `display: contents`, so measure what they contain.
			let range = document.createRange();
			range.selectNodeContents(block);
			let rect = range.getBoundingClientRect();
			let key = `${cursor?.pos}:${rect.bottom - rect.top}`;
			if (key !== revealed) {
				revealed = key;
				let margin = bounds.height / 6;
				if (rect.bottom > bounds.bottom - margin) {
					scroller.scrollTop += Math.min(
						rect.bottom - (bounds.bottom - margin),
						rect.top - bounds.top - margin,
					);
				} else if (rect.top < bounds.top + margin) {
					scroller.scrollTop -= bounds.top + margin - rect.top;
				}
				if (bounds.bottom > window.innerHeight) {
					window.scrollBy({ top: bounds.bottom - window.innerHeight });
				}
				return;
			}
			let top = Math.max(rect.top, bounds.top);
			let bottom = Math.min(rect.bottom, bounds.bottom);
			if (bottom <= top) {
				node.hidden = true;
				return;
			}
			node.hidden = false;
			node.style.transform = `translate(${(bounds.left + rect.left) / 2}px, ${top}px)`;
			node.style.height = `${bottom - top}px`;
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [body]);

	let login = cursor?.login ?? "";
	return (
		<div
			ref={element}
			className={styles.remoteCursor}
			style={{ "--cursor-color": cursorColor(login) } as CSSProperties}
			aria-hidden="true"
			hidden
		>
			<span className={styles.remoteCursorFlag}>{displayName(login)}</span>
		</div>
	);
}
