/**
 * Comment controls painted over the document, never into it.
 *
 * The collaborative tree is prose alone. Thread chrome belongs to one reader,
 * so this adapter resolves its anchors into DOM rectangles and portals ordinary
 * React controls into the document page.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";

import { DraftCard, ThreadCard } from "./comments";
import { gutterPoint, popoverPoint } from "./comment-geometry";
import { $rangeOf } from "./marks";
import { blockElement } from "./scroll";
import { useThreads } from "./threads";

import type { CSSProperties } from "react";
import type { Point, Rect } from "./comment-geometry";
import type { ThreadStore, ThreadView } from "./threads";

type PlacedThread = { view: ThreadView; button: Point };

function rect(value: DOMRect): Rect {
	return {
		top: value.top,
		right: value.right,
		bottom: value.bottom,
		left: value.left,
		width: value.width,
		height: value.height,
	};
}

/** A small thread summary while a reader is deciding whether to open it. */
function Preview({ style, view }: { style: CSSProperties; view: ThreadView }) {
	let replies = Math.max(0, view.thread.notes.length - 1);
	return (
		<div className="plan-comment-preview" role="tooltip" style={style}>
			<p>{view.quote}</p>
			{replies > 0 && <span>{replies} {replies === 1 ? "reply" : "replies"}</span>}
		</div>
	);
}

export function CommentLayer({ store }: { store: ThreadStore }) {
	let [editor] = useLexicalComposerContext();
	let state = useThreads(store);
	let [host, setHost] = useState<HTMLElement>();
	let [placed, setPlaced] = useState<PlacedThread[]>([]);
	let [preview, setPreview] = useState<string>();
	let [pinned, setPinned] = useState<string>();
	let root = useRef<HTMLDivElement>(null);
	let close = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	let failures = useRef(new Set<string>());

	useEffect(() => {
		setHost(document.querySelector<HTMLElement>(".plan-document") ?? undefined);
	}, []);

	let measure = () => {
		if (!host) return;
		let page = rect(host.getBoundingClientRect());
		let next: PlacedThread[] = [];

		for (let view of state.threads) {
			if (view.thread.status !== "open") continue;
			try {
				let target = editor.getEditorState().read(() => {
					let exact = view.places[0] && $rangeOf(editor, view.places[0]);
					return exact?.getBoundingClientRect() ?? (view.targetKey
						? blockElement(editor, view.targetKey)?.getBoundingClientRect()
						: undefined);
				});
				if (!target || (target.width === 0 && target.height === 0)) continue;
				let targetRect = rect(target);
				next.push({ view, button: gutterPoint(targetRect, page) });
			} catch (error) {
				// This may run from a Lexical update listener. A broken anchor is
				// one lost button, never a broken update chain.
				if (failures.current.has(view.thread.id)) continue;
				failures.current.add(view.thread.id);
				console.error(`[plan] could not measure comment ${view.thread.id}:`, error);
			}
		}

		setPlaced(next);
	};

	useLayoutEffect(() => {
		measure();
	}, [host, state.threads]);

	useEffect(() => {
		if (!host) return;
		let update = () => measure();
		let off = editor.registerUpdateListener(update);
		host.addEventListener("scroll", update, true);
		let observer = new ResizeObserver(update);
		observer.observe(host);
		return () => {
			off();
			host.removeEventListener("scroll", update, true);
			observer.disconnect();
		};
	}, [editor, host, state.threads]);

	useEffect(() => () => clearTimeout(close.current), []);

	useEffect(() => {
		if (!pinned) return;
		let outside = (event: PointerEvent) => {
			if (root.current?.contains(event.target as Node)) return;
			setPinned(undefined);
		};
		let escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setPinned(undefined);
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", escape);
		};
	}, [pinned]);

	if (!host) return null;

	let orphaned = state.threads.filter(view => view.thread.status === "open" && view.orphaned);
	let enter = (id: string) => {
		clearTimeout(close.current);
		setPreview(id);
		store.focus(id);
	};
	let leave = (id: string) => {
		clearTimeout(close.current);
		close.current = setTimeout(() => {
			if (pinned !== id) setPreview(current => current === id ? undefined : current);
			store.focus(undefined);
		}, 100);
	};
	let card = (view: ThreadView) => (
		<ThreadCard
			busy={false}
			focused={state.focused === view.thread.id}
			inDocument
			key={view.thread.id}
			onAccept={() => store.accept(view.thread.id)}
			onBlur={() => leave(view.thread.id)}
			onDismiss={() => store.dismiss(view.thread.id)}
			onFocus={() => enter(view.thread.id)}
			onReply={text => store.reply(view.thread.id, text)}
			onRetry={() => store.retry(view.thread.id)}
			onReveal={() => store.reveal(view.thread.id)}
			onTyping={writing => store.announce(view.thread.id, writing)}
			quote={view.quote}
			view={view}
			writing={state.writing[view.thread.id]}
		/>
	);

	return createPortal(
		<div className="plan-comment-layer" ref={root}>
			{placed.map(({ button, view }) => {
				let shown = pinned === view.thread.id;
				let cardWidth = Math.min(384, host.clientWidth * 0.8);
				let cardPoint = popoverPoint(
					{
						top: host.getBoundingClientRect().top + button.top,
						left: host.getBoundingClientRect().left + button.left,
						right: host.getBoundingClientRect().left + button.left + 24,
						bottom: host.getBoundingClientRect().top + button.top + 24,
						width: 24,
						height: 24,
					},
					host.getBoundingClientRect(),
					cardWidth,
				);
				return (
					<div key={view.thread.id}>
						<button
							aria-label={`Comment on “${view.quote}”`}
							className="plan-comment-button"
							onBlur={() => leave(view.thread.id)}
							onClick={() =>
								setPinned(current => current === view.thread.id ? undefined : view.thread.id)}
							onFocus={() => enter(view.thread.id)}
							onMouseEnter={() => enter(view.thread.id)}
							onMouseLeave={() => leave(view.thread.id)}
							style={button}
							type="button"
						>
							💬
						</button>
						{preview === view.thread.id && !shown && (
							<Preview style={{ top: button.top, left: button.left + 32 }} view={view} />
						)}
						{shown && (
							<div
								aria-label="Comment thread"
								className="plan-comment-card"
								onMouseEnter={() => enter(view.thread.id)}
								onMouseLeave={() => leave(view.thread.id)}
								role="dialog"
								style={cardPoint}
							>
								{card(view)}
							</div>
						)}
					</div>
				);
			})}

			{state.draft?.placement && (
				<div
					aria-label="New comment"
					className="plan-comment-card"
					role="dialog"
					style={gutterPoint(state.draft.placement, host.getBoundingClientRect())}
				>
					<DraftCard
						busy={false}
						onCancel={() => store.draft(undefined)}
						onSend={text => store.start(text)}
						quote={state.draft.quote}
					/>
				</div>
			)}

			{orphaned.length > 0 && (
				<div className="plan-comment-orphans">
					<button
						aria-expanded={pinned === "orphans"}
						aria-label={`${orphaned.length} orphaned comments`}
						className="plan-comment-orphan-button"
						onClick={() => setPinned(current => current === "orphans" ? undefined : "orphans")}
						type="button"
					>
						{orphaned.length} comments without prose
					</button>
					{pinned === "orphans" && (
						<div
							aria-label="Orphaned comments"
							className="plan-comment-card plan-comment-orphan-card"
							role="dialog"
						>
							{orphaned.map(card)}
						</div>
					)}
				</div>
			)}
		</div>,
		host,
	);
}
