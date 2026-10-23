import { md2html } from "@github-ui/md2html";
import { UnsafeHTMLDiv } from "@github-ui/safe-html/UnsafeHTML";
import type { SafeHTMLString } from "@github-ui/sanitize/safe-html-string";
import { useMemo, useRef } from "react";
import { displayName } from "./plans";
import styles from "./plans.module.css";
import { RemoteCursor } from "./remote-cursor";
import type { PlanState } from "./store";

/** Source ranges of the top-level blocks, in the order their elements render. */
export type Blocks = [start: number, end: number][];

/**
 * Splits Markdown at blank lines and headings outside code fences, so each block renders on its
 * own and a source offset maps to exactly one rendered element.
 */
function split(markdown: string) {
	let blocks: Blocks = [];
	let start = -1;
	let fence = "";
	let offset = 0;
	let close = (end: number) => {
		if (start >= 0) blocks.push([start, end]);
		start = -1;
	};
	for (let line of markdown.split("\n")) {
		let end = offset + line.length;
		let marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker?.startsWith(fence)) fence = "";
		} else if (marker) {
			if (start < 0) start = offset;
			fence = marker;
		} else if (!line.trim()) close(offset);
		else if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) {
			close(offset);
			blocks.push([offset, end]);
		} else if (start < 0) start = offset;
		offset = end + 1;
	}
	close(markdown.length);
	return blocks;
}

let cache = new Map<string, SafeHTMLString>();

function html(markdown: string) {
	let hit = cache.get(markdown);
	if (hit === undefined) {
		hit = md2html(markdown);
		if (cache.size > 200) cache.clear();
		cache.set(markdown, hit);
	}
	return hit;
}

/** The plan as rendered Markdown, live as collaborators write it. */
export function PlanDocument({ state }: { state: PlanState }) {
	let body = useRef<HTMLDivElement>(null);
	let blocks = useMemo(() => split(state.body), [state.body]);

	return (
		<section className={styles.document} aria-label="Plan">
			<div className={styles.documentHeader}>
				<span>
					<strong>{displayName(state.updatedBy)}</strong> edited {state.updated}
				</span>
			</div>
			<div ref={body} className={styles.documentBody}>
				<div className={`markdown-body ${styles.markdown}`}>
					{blocks.map(([start, end], index) => (
						<UnsafeHTMLDiv
							// Blocks are positional; a stable index keeps unchanged blocks mounted.
							key={index}
							className={styles.block}
							html={html(state.body.slice(start, end))}
							preset="markdown"
						/>
					))}
				</div>
			</div>
			<RemoteCursor body={body} blocks={blocks} cursor={state.cursor} />
		</section>
	);
}
