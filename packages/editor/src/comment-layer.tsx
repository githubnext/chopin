/** Reader-local comment chrome overlays rather than mutates collaborative prose. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ChatCircleIcon } from "@phosphor-icons/react";

import { DraftCard, ThreadCard } from "./comments";
import { gutterPoint, popoverPoint } from "./comment-geometry";
import { containsHit, passageHits } from "./comment-hits";
import { $rangeOf } from "./marks";
import { blockElement } from "./scroll";
import { useThreads } from "./threads";

import type { CSSProperties } from "react";
import type { Point, Rect } from "./comment-geometry";
import type { PassageHit } from "./comment-hits";
import type { ThreadStore, ThreadView } from "./threads";

type PlacedThread = { view: ThreadView; button: Point; hits: PassageHit[] };
type PassagePress = { id: string; left: number; pointer: number; top: number; moved: boolean };

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

function Preview({
	id,
	onMeasure,
	style,
	view,
}: {
	id: string;
	onMeasure: (element: HTMLDivElement | null) => void;
	style: CSSProperties;
	view: ThreadView;
}) {
	let replies = Math.max(0, view.thread.notes.length - 1);
	return (
		<div
			className="plan-comment-preview"
			id={id}
			ref={onMeasure}
			role="tooltip"
			style={style}
		>
			<p>{view.quote}</p>
			{replies > 0 && <span>{replies} {replies === 1 ? "reply" : "replies"}</span>}
		</div>
	);
}

function replyState(view: ThreadView): string {
	let replies = Math.max(0, view.thread.notes.length - 1);
	return replies === 0
		? "No replies waiting."
		: `${replies} ${replies === 1 ? "reply" : "replies"} waiting.`;
}

export function CommentLayer({ store }: { store: ThreadStore }) {
	let [editor] = useLexicalComposerContext();
	let state = useThreads(store);
	let [host, setHost] = useState<HTMLElement>();
	let [placed, setPlaced] = useState<PlacedThread[]>([]);
	let [preview, setPreview] = useState<string>();
	let [pinned, setPinned] = useState<string>();
	let [cardHeights, setCardHeights] = useState<{ [id: string]: number }>({});
	let root = useRef<HTMLDivElement>(null);
	let placedRef = useRef<PlacedThread[]>([]);
	let hoverOwner = useRef<string | undefined>(undefined);
	let press = useRef<PassagePress | undefined>(undefined);
	let close = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	let failures = useRef(new Set<string>());

	useEffect(() => {
		setHost(document.querySelector<HTMLElement>(".plan-document") ?? undefined);
	}, []);

	let enter = useCallback((id: string) => {
		clearTimeout(close.current);
		setPreview(id);
		store.focus(id);
	}, [store]);
	let leave = useCallback((id: string) => {
		clearTimeout(close.current);
		close.current = setTimeout(() => {
			if (pinned !== id) setPreview(current => current === id ? undefined : current);
			store.focus(undefined);
		}, 100);
	}, [pinned, store]);
	let hover = useCallback((id: string) => {
		if (hoverOwner.current === id) return;
		if (hoverOwner.current) leave(hoverOwner.current);
		hoverOwner.current = id;
		enter(id);
	}, [enter, leave]);
	let unhover = useCallback((id: string) => {
		if (hoverOwner.current !== id) return;
		hoverOwner.current = undefined;
		leave(id);
	}, [leave]);

	let measure = () => {
		if (!host) return;
		let page = rect(host.getBoundingClientRect());
		let next: PlacedThread[] = [];

		for (let view of state.threads) {
			if (view.thread.status !== "open") continue;
			try {
				let target = editor.getEditorState().read(() => {
					let exact = view.places[0] && $rangeOf(editor, view.places[0]);
					if (exact) {
						return {
							bounds: exact.getBoundingClientRect(),
							hits: Array.from(exact.getClientRects(), rect),
						};
					}
					let fallback = view.targetKey
						? blockElement(editor, view.targetKey)?.getBoundingClientRect()
						: undefined;
					return fallback ? { bounds: fallback, hits: [] } : undefined;
				});
				if (!target || (target.bounds.width === 0 && target.bounds.height === 0)) continue;
				let targetRect = rect(target.bounds);
				next.push({
					view,
					button: gutterPoint(targetRect, page),
					hits: passageHits(page, target.hits),
				});
			} catch (error) {
				// A bad anchor must not break Lexical's update listener.
				if (failures.current.has(view.thread.id)) continue;
				failures.current.add(view.thread.id);
				console.error(`[plan] could not measure comment ${view.thread.id}:`, error);
			}
		}

		placedRef.current = next;
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
		if (!host) return;
		let over = (event: MouseEvent | PointerEvent): PlacedThread | undefined => {
			let page = host.getBoundingClientRect();
			let point = { top: event.clientY - page.top, left: event.clientX - page.left };
			return placedRef.current.find(entry => containsHit(entry.hits, point));
		};
		let inProse = (target: EventTarget | null) =>
			!!target && editor.getRootElement()?.contains(target as Node);
		let down = (event: PointerEvent) => {
			press.current = undefined;
			if (
				event.button !== 0 || root.current?.contains(event.target as Node) || !inProse(event.target)
			) return;
			let entry = over(event);
			if (!entry) return;
			press.current = {
				id: entry.view.thread.id,
				left: event.clientX,
				pointer: event.pointerId,
				top: event.clientY,
				moved: false,
			};
		};
		let move = (event: PointerEvent) => {
			let pending = press.current;
			if (
				pending?.pointer === event.pointerId
				&& Math.hypot(event.clientX - pending.left, event.clientY - pending.top) > 3
			) pending.moved = true;
			// Keep native prose selection outside the controls.
			if (root.current?.contains(event.target as Node)) return;
			let next = over(event)?.view.thread.id;
			if (next) hover(next);
			else if (hoverOwner.current) unhover(hoverOwner.current);
		};
		let click = (event: MouseEvent) => {
			let pending = press.current;
			press.current = undefined;
			if (
				!pending
				|| pending.moved
				|| root.current?.contains(event.target as Node)
				|| !inProse(event.target)
			) return;
			let entry = over(event);
			let selection = getSelection();
			if (entry?.view.thread.id !== pending.id || (selection && !selection.isCollapsed)) return;
			enter(pending.id);
			setPinned(current => current === pending.id ? undefined : pending.id);
		};
		let out = () => {
			if (hoverOwner.current) unhover(hoverOwner.current);
		};
		let cancel = () => {
			press.current = undefined;
		};
		host.addEventListener("pointerdown", down);
		host.addEventListener("pointermove", move);
		host.addEventListener("click", click);
		host.addEventListener("pointerleave", out);
		host.addEventListener("pointercancel", cancel);
		return () => {
			host.removeEventListener("pointerdown", down);
			host.removeEventListener("pointermove", move);
			host.removeEventListener("click", click);
			host.removeEventListener("pointerleave", out);
			host.removeEventListener("pointercancel", cancel);
		};
	}, [editor, enter, host, hover, unhover]);

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
	let card = (view: ThreadView) => (
		<ThreadCard
			busy={false}
			focused={state.focused === view.thread.id}
			inDocument
			key={view.thread.id}
			onAccept={() => store.accept(view.thread.id)}
			onBlur={() => unhover(view.thread.id)}
			onDismiss={() => store.dismiss(view.thread.id)}
			onFocus={() => hover(view.thread.id)}
			onReply={text => store.reply(view.thread.id, text)}
			onRetry={() => store.retry(view.thread.id)}
			onReveal={() => store.reveal(view.thread.id)}
			onTyping={writing => store.announce(view.thread.id, writing)}
			quote={view.quote}
			view={view}
			writing={state.writing[view.thread.id]}
		/>
	);
	let rememberHeight = (id: string, element: HTMLDivElement | null) => {
		let height = element?.offsetHeight;
		if (!height) return;
		setCardHeights(current => current[id] === height ? current : { ...current, [id]: height });
	};
	let page = host.getBoundingClientRect();
	let cardWidth = Math.min(384, host.clientWidth * 0.8);
	let previewWidth = Math.min(288, host.clientWidth * 0.8);

	return createPortal(
		<div className="plan-comment-layer" ref={root}>
			{placed.map(({ button, hits, view }) => {
				let shown = pinned === view.thread.id;
				let previewId = `plan-comment-preview-${view.thread.id}`;
				let cardPoint = popoverPoint(
					{
						top: page.top + button.top,
						left: page.left + button.left,
						right: page.left + button.left + 24,
						bottom: page.top + button.top + 24,
						width: 24,
						height: 24,
					},
					page,
					cardWidth,
					cardHeights[view.thread.id] ?? 0,
				);
				return (
					<div key={view.thread.id}>
						{hits.map((hit, index) => (
							<div
								aria-hidden="true"
								className="plan-comment-hit"
								data-plan-comment-hit={view.thread.id}
								key={index}
								style={hit}
							/>
						))}
						<button
							aria-label={`Comment on “${view.quote}”. ${replyState(view)}`}
							aria-controls={shown ? `plan-comment-thread-${view.thread.id}` : undefined}
							aria-describedby={preview === view.thread.id && !shown ? previewId : undefined}
							aria-description={replyState(view)}
							aria-expanded={shown}
							className="plan-comment-button"
							onBlur={() => unhover(view.thread.id)}
							onClick={() =>
								setPinned(current => current === view.thread.id ? undefined : view.thread.id)}
							onFocus={() => hover(view.thread.id)}
							onMouseEnter={() => hover(view.thread.id)}
							onMouseLeave={() => unhover(view.thread.id)}
							style={button}
							type="button"
						>
							<ChatCircleIcon aria-hidden="true" size={14} />
						</button>
						{preview === view.thread.id && !shown && (
							<Preview
								id={previewId}
								onMeasure={element => rememberHeight(`preview:${view.thread.id}`, element)}
								style={{
									...popoverPoint(
										{
											top: page.top + button.top,
											left: page.left + button.left,
											right: page.left + button.left + 24,
											bottom: page.top + button.top + 24,
											width: 24,
											height: 24,
										},
										page,
										previewWidth,
										cardHeights[`preview:${view.thread.id}`] ?? 96,
									),
									width: previewWidth,
								}}
								view={view}
							/>
						)}
						{shown && (
							<div
								aria-label="Comment thread"
								className="plan-comment-card"
								id={`plan-comment-thread-${view.thread.id}`}
								ref={element => rememberHeight(view.thread.id, element)}
								onMouseEnter={() => hover(view.thread.id)}
								onMouseLeave={() => unhover(view.thread.id)}
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
					ref={element => rememberHeight("draft", element)}
					style={popoverPoint(
						state.draft.placement,
						page,
						cardWidth,
						cardHeights.draft ?? 0,
					)}
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
