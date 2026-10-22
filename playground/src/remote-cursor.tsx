import type { HybridMarkdownEditorRef } from "@github-ui/hybrid-markdown-editor/types";
import { type CSSProperties, type RefObject, useEffect, useRef } from "react";
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

/** A collaborator's caret drawn over the editor from a document position. */
export function RemoteCursor(
	{ editor, cursor }: { editor: RefObject<HybridMarkdownEditorRef | null>; cursor: Cursor },
) {
	let element = useRef<HTMLDivElement>(null);
	let position = useRef(cursor);
	position.current = cursor;

	useEffect(() => {
		let frame = 0;
		let tick = () => {
			frame = requestAnimationFrame(tick);
			let node = element.current;
			let view = editor.current?.view;
			let current = position.current;
			if (!node) return;
			if (!view || !current) {
				node.hidden = true;
				return;
			}
			let coords = view.coordsAtPos(Math.min(current.pos, view.state.doc.length), -1);
			let bounds = view.scrollDOM.getBoundingClientRect();
			if (!coords || coords.bottom < bounds.top || coords.top > bounds.bottom) {
				node.hidden = true;
				return;
			}
			node.hidden = false;
			node.style.transform = `translate(${coords.left}px, ${coords.top}px)`;
			node.style.height = `${coords.bottom - coords.top}px`;
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [editor]);

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
