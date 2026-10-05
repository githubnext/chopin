/** Reader-local comment chrome overlays rather than mutates collaborative prose. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { MessageIcon } from "@chopin/icons";
import { useCellValue } from "@mdxeditor/gurx";
import { $getNodeByKey } from "lexical";

import { Author, DraftCard, ThreadCard, ThreadList } from "./comments";
import { blockMarkerPoints, commentCardPoint, markerRect, popoverPoint } from "./comment-geometry";
import { containsHit, passageHits } from "./comment-hits";
import { CommentSheet, usesCommentSheet } from "./comment-sheet";
import { useCommentSheetReveal } from "./comment-sheet-reveal";
import { $rangeOf } from "./marks";
import { blockElement } from "./scroll";
import { COARSE_POINTER_QUERY, PRIMARY_COARSE_POINTER_QUERY } from "./pointer";
import { useThreads } from "./threads";
import { useTransitionPresence } from "./transition-presence";
import { widgets$ } from "./widget-options";

import type { CSSProperties, ReactNode } from "react";
import type { BlockMarkerPoint, CardSide, Point, Rect } from "./comment-geometry";
import type { PassageHit } from "./comment-hits";
import type { ThreadStore, ThreadView } from "./threads";

/** The visible chip; a coarse pointer gets a larger, invisible hit area around it. */
const CHIP = 24;
const TOUCH_TARGET = 44;
/** The gutter strip beside the prose that block markers, even grouped ones, occupy. */
const MARKER_LANE = 56;

type PlacedThread = {
	view: ThreadView;
	/** The block marker that stands for this thread. */
	marker: string;
	hits: PassageHit[];
	passages: Rect[];
};
/** One marker per commented block, standing for every open thread on it. */
type PlacedMarker = {
	key: string;
	views: ThreadView[];
	excerpt: string;
	button: BlockMarkerPoint;
	/** The first line box's height; a touch target stays within it so the next line takes taps. */
	line: number;
};
type MeasuredThread = {
	view: ThreadView;
	passages: Rect[];
	hits: Rect[];
};
type MeasuredBlock = {
	key: string;
	block: Rect;
	line: { top: number; height: number };
	excerpt: string;
	threads: MeasuredThread[];
};

/** A pinned list of one block's threads, as opposed to a pinned thread id. */
const LIST = "list:";

function dialogId(pinned: string): string {
	return pinned.startsWith(LIST)
		? `plan-comment-list-${pinned.slice(LIST.length)}`
		: `plan-comment-thread-${pinned}`;
}

function excerptOf(text: string): string {
	let flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 48 ? `${flat.slice(0, 47).trimEnd()}…` : flat;
}

/** The first line box of a block, from its own type metrics. */
function firstLine(element: HTMLElement, box: Rect): { top: number; height: number } {
	let style = getComputedStyle(element);
	let height = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || CHIP;
	let inset = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0);
	return { top: box.top + inset, height: Math.min(height, box.height - inset || height) };
}

/** The prose column: the editor root inside its padding. */
function proseColumn(root: HTMLElement): Rect {
	let box = root.getBoundingClientRect();
	let style = getComputedStyle(root);
	let left = box.left + (parseFloat(style.paddingLeft) || 0);
	let right = box.right - (parseFloat(style.paddingRight) || 0);
	return { top: box.top, right, bottom: box.bottom, left, width: right - left, height: box.height };
}

function union(rects: Rect[]): Rect | undefined {
	if (rects.length === 0) return undefined;
	let top = Math.min(...rects.map(item => item.top));
	let right = Math.max(...rects.map(item => item.right));
	let bottom = Math.max(...rects.map(item => item.bottom));
	let left = Math.min(...rects.map(item => item.left));
	return { top, right, bottom, left, width: right - left, height: bottom - top };
}

function chipWidth(count: number): number {
	return count > 1 ? 30 + 7 * String(count).length : CHIP;
}

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

type PreviewRequest = {
	button: Point;
	id: string;
	page: Rect;
	size: number;
	view: ThreadView;
	width: number;
};

type PreviewValue = {
	id: string;
	style: CSSProperties;
	view: ThreadView;
};

type PreviewMeasurement = {
	height: number;
	id: string;
	noteCount: number;
	quote: string;
	width: number;
};

function previewHeight(
	request: PreviewRequest | undefined,
	measurement: PreviewMeasurement | undefined,
): number | undefined {
	return request
			&& measurement?.id === request.id
			&& measurement.width === request.width
			&& measurement.quote === request.view.quote
			&& measurement.noteCount === request.view.thread.notes.length
		? measurement.height
		: undefined;
}

function placedPreview(
	request: PreviewRequest | undefined,
	measurement: PreviewMeasurement | undefined,
): PreviewValue | undefined {
	let height = previewHeight(request, measurement);
	if (!request || height === undefined) return undefined;
	let point = popoverPoint(
		markerRect(request.button, request.page, request.size),
		request.page,
		request.width,
		height,
	);
	let originX = point.left >= request.button.left ? 0 : request.width;
	let originY = Math.min(
		height,
		Math.max(0, request.button.top + request.size / 2 - point.top),
	);
	return {
		id: request.id,
		style: {
			...point,
			transformOrigin: `${originX}px ${originY}px`,
			width: request.width,
		},
		view: request.view,
	};
}

function PreviewContent({ view }: { view: ThreadView }) {
	let replies = Math.max(0, view.thread.notes.length - 1);
	let opening = view.thread.notes[0];
	return (
		<>
			{opening && (
				<>
					<p className="plan-comment-preview-author">
						<Author handle={opening.handle} />
					</p>
					<p className="plan-comment-preview-note">{opening.text}</p>
				</>
			)}
			{replies > 0 && (
				<span className="plan-comment-preview-replies">
					{replies} {replies === 1 ? "reply" : "replies"}
				</span>
			)}
		</>
	);
}

function PreviewSurface(
	{
		immediately,
		onMeasure,
		request,
		value,
	}: {
		immediately: boolean;
		onMeasure: (request: PreviewRequest, height: number) => void;
		request?: PreviewRequest;
		value?: PreviewValue;
	},
) {
	let measurementElement = useRef<HTMLDivElement>(null);
	let lifecycle = useCommentPresence(value, 150, immediately);
	useLayoutEffect(() => {
		let element = measurementElement.current;
		if (request && element) onMeasure(request, element.offsetHeight);
	}, [onMeasure, request]);

	let measuring = !!request && value === undefined;
	if (!measuring && lifecycle.presence.phase === "closed") return null;
	let preview = lifecycle.presence.phase === "closed" ? undefined : lifecycle.presence.value;
	return (
		<>
			{measuring && request && (
				<div
					aria-hidden="true"
					className="plan-comment-preview"
					inert
					ref={measurementElement}
					style={{ left: 0, top: 0, visibility: "hidden", width: request.width }}
				>
					<PreviewContent view={request.view} />
				</div>
			)}
			{preview && (
				<div
					aria-hidden={lifecycle.ariaHidden}
					className={`plan-comment-preview motion-comment-preview ${lifecycle.presence.className}`}
					data-motion-immediate={immediately || undefined}
					id={preview.id}
					inert={lifecycle.inert}
					key={preview.id}
					role="tooltip"
					style={preview.style}
				>
					<PreviewContent view={preview.view} />
				</div>
			)}
		</>
	);
}

type CommentSurfaceValue = {
	ariaLabel: string;
	children: ReactNode;
	className: string;
	id?: string;
	side?: CardSide;
	onMeasure?: (element: HTMLDivElement | null) => void;
	onMouseEnter?: () => void;
	onMouseLeave?: () => void;
	style?: CSSProperties;
};

function useCommentPresence<T>(value: T | undefined, duration: number, immediately: boolean) {
	let presence = useTransitionPresence(value, duration, immediately);
	let active = presence.phase !== "closed" && presence.phase !== "closing";
	return {
		ariaHidden: active ? undefined : "true" as const,
		inert: !active,
		presence,
	};
}

function CommentSurface(
	{
		compact,
		immediately,
		value,
	}: {
		compact: boolean;
		immediately: boolean;
		value?: CommentSurfaceValue;
	},
) {
	let lifecycle = useCommentPresence(value, compact ? 180 : 150, immediately);
	if (lifecycle.presence.phase === "closed") return null;
	let surface = lifecycle.presence.value;
	return (
		<div
			aria-hidden={lifecycle.ariaHidden}
			aria-label={surface.ariaLabel}
			aria-modal={!lifecycle.inert && compact ? true : undefined}
			className={`${surface.className} motion-comment-surface ${lifecycle.presence.className}`}
			data-motion-presentation={compact ? "sheet" : "popover"}
			data-side={surface.side}
			id={surface.id}
			inert={lifecycle.inert}
			onMouseEnter={surface.onMouseEnter}
			onMouseLeave={surface.onMouseLeave}
			ref={surface.onMeasure}
			role="dialog"
			style={surface.style}
		>
			{surface.children}
		</div>
	);
}

function replyState(view: ThreadView): string {
	return repliesWaiting(Math.max(0, view.thread.notes.length - 1));
}

function repliesWaiting(replies: number): string {
	return replies === 0
		? "No replies waiting."
		: `${replies} ${replies === 1 ? "reply" : "replies"} waiting.`;
}

export function CommentLayer({ store }: { store: ThreadStore }) {
	let [editor] = useLexicalComposerContext();
	let state = useThreads(store);
	let [host, setHost] = useState<HTMLElement>();
	let [placed, setPlaced] = useState<PlacedThread[]>([]);
	let [markers, setMarkers] = useState<PlacedMarker[]>([]);
	let markersRef = useRef<PlacedMarker[]>([]);
	let [preview, setPreview] = useState<string>();
	let [previewMeasurement, setPreviewMeasurement] = useState<PreviewMeasurement>();
	let [pinned, setPinned] = useState<string>();
	let [returnTo, setReturnTo] = useState<string>();
	let pinnedRef = useRef<string | undefined>(undefined);
	pinnedRef.current = pinned;
	let [coarse, setCoarse] = useState(false);
	let [primaryCoarse, setPrimaryCoarse] = useState(false);
	let [cardHeights, setCardHeights] = useState<{ [id: string]: number }>({});
	let root = useRef<HTMLDivElement>(null);
	let placedRef = useRef<PlacedThread[]>([]);
	let hoverOwner = useRef<string | undefined>(undefined);
	let press = useRef<PassagePress | undefined>(undefined);
	let close = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	let failures = useRef(new Set<string>());
	let origin = useRef<HTMLElement | undefined>(undefined);
	let draftOpen = useRef(false);
	let selected = useRef<string | undefined>(undefined);
	let options = useCellValue(widgets$);
	let canEdit = options.canEdit !== false;
	let compact = options.commentPresentation === "sheet"
		&& usesCommentSheet({ coarse: primaryCoarse, width: host?.clientWidth ?? Infinity });
	let previousCompact = useRef(compact);
	let immediately = options.motionImmediately?.() ?? false;
	let draft = canEdit ? state.draft : undefined;
	let measurePreview = useCallback((request: PreviewRequest, height: number) => {
		if (height <= 0) {
			setPreviewMeasurement(undefined);
			if (preview === request.view.thread.id) {
				setPreview(undefined);
				store.focus(undefined);
			}
			return;
		}
		let next = {
			height,
			id: request.id,
			noteCount: request.view.thread.notes.length,
			quote: request.view.quote,
			width: request.width,
		};
		setPreviewMeasurement(current => previewHeight(request, current) === height ? current : next);
	}, [preview, store]);

	useEffect(() => {
		return editor.registerRootListener(element => {
			setHost(element?.closest<HTMLElement>(".plan-document") ?? undefined);
		});
	}, [editor]);

	useEffect(() => {
		let query = matchMedia(COARSE_POINTER_QUERY);
		let primary = matchMedia(PRIMARY_COARSE_POINTER_QUERY);
		let update = () => {
			setCoarse(query.matches);
			setPrimaryCoarse(primary.matches);
		};
		update();
		query.addEventListener("change", update);
		primary.addEventListener("change", update);
		return () => {
			query.removeEventListener("change", update);
			primary.removeEventListener("change", update);
		};
	}, []);

	useLayoutEffect(() => {
		let previous = previousCompact.current;
		previousCompact.current = compact;
		if (!previous || compact || !pinned) return;
		let dialog = document.getElementById(dialogId(pinned));
		dialog?.querySelector<HTMLElement>("[data-plan-comment-close], button")?.focus();
	}, [compact, pinned]);

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
		let blocks = new Map<string, MeasuredBlock>();

		for (let view of state.threads) {
			if (view.thread.status !== "open") continue;
			try {
				let target = editor.getEditorState().read(() => {
					let exact = view.places[0] && $rangeOf(editor, view.places[0]);
					let anchor = view.places[0]?.anchorKey ?? view.targetKey;
					let element = anchor ? blockElement(editor, anchor) : undefined;
					let key = element
						? $getNodeByKey(anchor!)?.getTopLevelElement()?.getKey() ?? anchor!
						: `thread:${view.thread.id}`;
					if (exact) {
						return {
							bounds: exact.getBoundingClientRect(),
							element,
							hits: Array.from(exact.getClientRects(), rect),
							key,
						};
					}
					let fallback = view.targetKey ? blockElement(editor, view.targetKey) : undefined;
					return fallback
						? { bounds: fallback.getBoundingClientRect(), element: fallback, hits: [], key }
						: undefined;
				});
				if (!target || (target.bounds.width === 0 && target.bounds.height === 0)) continue;
				let targetRect = rect(target.bounds);
				let passages = target.hits.length > 0 ? target.hits : [targetRect];
				let block = blocks.get(target.key!);
				if (!block) {
					let box = target.element ? rect(target.element.getBoundingClientRect()) : targetRect;
					block = {
						key: target.key!,
						block: box,
						line: target.element
							? firstLine(target.element, box)
							: { top: box.top, height: Math.min(box.height, CHIP) },
						excerpt: excerptOf(target.element?.textContent ?? view.quote),
						threads: [],
					};
					blocks.set(block.key, block);
				}
				block.threads.push({ view, passages, hits: target.hits });
			} catch (error) {
				// A bad anchor must not break Lexical's update listener.
				if (failures.current.has(view.thread.id)) continue;
				failures.current.add(view.thread.id);
				console.error(`[plan] could not measure comment ${view.thread.id}:`, error);
			}
		}

		let measured = [...blocks.values()].sort((a, b) => a.block.top - b.block.top);
		let focused = document.activeElement?.getAttribute("data-plan-comment-button");
		let points = blockMarkerPoints(
			measured.map(({ block, key, line, threads }) => ({
				block,
				line,
				width: chipWidth(threads.length),
				...(threads.length >= 10 ? { minimum: 18 } : {}),
				held: focused === key
					|| pinnedRef.current === `${LIST}${key}`
					|| threads.some(({ view }) => view.thread.id === pinnedRef.current),
			})),
			page,
			{ size: CHIP },
		);
		let nextMarkers = measured.map<PlacedMarker>((entry, index) => ({
			key: entry.key,
			views: entry.threads.map(({ view }) => view),
			excerpt: entry.excerpt,
			button: points[index]!,
			line: entry.line.height,
		}));
		let next = measured.flatMap(entry =>
			entry.threads.map<PlacedThread>(thread => ({
				view: thread.view,
				marker: entry.key,
				hits: passageHits(page, thread.hits),
				passages: thread.passages,
			}))
		);

		placedRef.current = next;
		markersRef.current = nextMarkers;
		setPlaced(next);
		setMarkers(nextMarkers);
	};

	useLayoutEffect(() => {
		measure();
	}, [host, state.threads, coarse, pinned]);

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
	}, [editor, host, state.threads, coarse]);

	useEffect(() => () => clearTimeout(close.current), []);

	useEffect(() => {
		if (!canEdit && state.draft) store.draft(undefined);
	}, [canEdit, state.draft, store]);

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
			origin.current = root.current?.querySelector<HTMLElement>(
				`[data-plan-comment-button="${entry.marker}"]`,
			) ?? undefined;
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

	let restoreOrigin = useCallback(() => {
		let target = origin.current;
		requestAnimationFrame(() => {
			let fallback = editor.getRootElement();
			(target?.isConnected ? target : fallback)?.focus();
		});
	}, [editor]);
	let dismiss = useCallback(() => {
		setPinned(undefined);
		setReturnTo(undefined);
		setPreview(undefined);
		restoreOrigin();
	}, [restoreOrigin]);
	let cancelDraft = useCallback(() => {
		draftOpen.current = false;
		store.draft(undefined);
		restoreOrigin();
	}, [restoreOrigin, store]);

	useLayoutEffect(() => {
		let open = !!draft;
		if (open && !draftOpen.current) {
			let active = document.activeElement;
			origin.current = active instanceof HTMLElement
				? active
				: editor.getRootElement() ?? undefined;
		} else if (!open && draftOpen.current) restoreOrigin();
		draftOpen.current = open;

		if (!pinned) return;
		let available = pinned === "orphans"
			? state.threads.some(view => view.thread.status === "open" && view.orphaned)
			: pinned.startsWith(LIST)
			? markersRef.current.some(marker => `${LIST}${marker.key}` === pinned)
			: state.threads.some(view =>
				view.thread.id === pinned && view.thread.status === "open" && !view.orphaned
			);
		if (available) return;
		setPinned(undefined);
		setPreview(undefined);
		store.focus(undefined);
		restoreOrigin();
	}, [draft, editor, pinned, restoreOrigin, state.threads, store]);

	// The list item that held focus is replaced by the thread it opened; focus its way back.
	useLayoutEffect(() => {
		let id = selected.current;
		if (!id || id !== pinned) return;
		selected.current = undefined;
		document.querySelector<HTMLElement>(
			`[data-plan-comment-thread="${id}"] [data-plan-comment-back]`,
		)?.focus();
	}, [pinned]);

	let sheetId = compact && pinned !== "orphans" ? pinned : undefined;
	let sheetPassages = useMemo(() => {
		if (!sheetId) return undefined;
		let list = sheetId.startsWith(LIST) ? sheetId.slice(LIST.length) : undefined;
		let entries = placed.filter(entry =>
			list ? entry.marker === list : entry.view.thread.id === sheetId
		);
		return entries.length > 0 ? entries.flatMap(entry => entry.passages) : undefined;
	}, [placed, sheetId]);
	let revealId = compact && draft?.placement ? "draft" : sheetId;
	let revealPassages = useMemo(
		() => compact && draft?.placement ? [draft.placement] : sheetPassages,
		[compact, draft?.placement, sheetPassages],
	);
	useCommentSheetReveal({
		host,
		id: revealId,
		passages: revealPassages,
	});

	useEffect(() => {
		if (!pinned && !preview) return;
		if (compact && pinned) return;
		let outside = (event: PointerEvent) => {
			let dialog = pinned ? document.getElementById(dialogId(pinned)) : undefined;
			if (dialog?.contains(event.target as Node)) return;
			if (pinned) dismiss();
			else setPreview(undefined);
		};
		let escape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			if (pinned) dismiss();
			else setPreview(undefined);
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", escape);
		};
	}, [compact, dismiss, pinned, preview]);

	if (!host) return null;

	let orphaned = state.threads.filter(view => view.thread.status === "open" && view.orphaned);
	let markerOf = (id: string) => {
		let entry = placed.find(candidate => candidate.view.thread.id === id);
		return entry ? markers.find(marker => marker.key === entry.marker) : undefined;
	};
	let selectThread = (id: string) => {
		selected.current = id;
		setPinned(id);
	};
	let card = (view: ThreadView, showClose = true) => {
		let group = markerOf(view.thread.id);
		let back = group && group.views.length > 1 ? group : undefined;
		return (
			<ThreadCard
				backLabel={back ? `All ${back.views.length} comments` : undefined}
				busy={false}
				canEdit={canEdit}
				focused={state.focused === view.thread.id}
				inDocument
				key={view.thread.id}
				onAccept={() => store.accept(view.thread.id)}
				onBack={back
					? () => {
						setReturnTo(view.thread.id);
						setPinned(`${LIST}${back.key}`);
					}
					: undefined}
				onBlur={() => unhover(view.thread.id)}
				onClose={showClose ? dismiss : undefined}
				onDismiss={() => store.dismiss(view.thread.id)}
				onFocus={() => hover(view.thread.id)}
				onReply={text => store.reply(view.thread.id, text)}
				onRetry={() => store.retry(view.thread.id)}
				onTyping={writing => store.announce(view.thread.id, writing)}
				quote={view.quote}
				showClose={showClose}
				view={view}
				writing={state.writing[view.thread.id]}
			/>
		);
	};
	let pinnedList = pinned?.startsWith(LIST)
		? markers.find(marker => `${LIST}${marker.key}` === pinned)
		: undefined;
	let pinnedView = pinned && pinned !== "orphans" && !pinnedList
		? state.threads.find(view => view.thread.id === pinned && view.thread.status === "open")
		: undefined;
	let pinnedMarker = pinnedList ?? (pinnedView ? markerOf(pinnedView.thread.id) : undefined);
	// The full content height, so a card capped to fit beside its passage keeps its true size.
	let rememberHeight = (id: string, element: HTMLDivElement | null) => {
		let height = element?.scrollHeight;
		if (!height) return;
		setCardHeights(current => current[id] === height ? current : { ...current, [id]: height });
	};
	let page = rect(host.getBoundingClientRect());
	let editorRoot = editor.getRootElement();
	let column = editorRoot ? proseColumn(editorRoot) : page;
	let cardWidth = Math.min(320, host.clientWidth - 24);
	let cardPlacement = (passage: Rect, id: string) => {
		let { side, ...style } = commentCardPoint(
			passage,
			column,
			page,
			cardWidth,
			cardHeights[id] ?? 0,
			{ lane: MARKER_LANE },
		);
		return { side, style };
	};
	let previewWidth = Math.min(288, host.clientWidth * 0.8);
	let compactKey: string | undefined;
	let compactId: string | undefined;
	let compactLabel: string | undefined;
	let compactClose: (() => void) | undefined;
	let compactContent: ReactNode = undefined;
	let previewView = preview && pinned !== preview
		? placed.find(entry => entry.view.thread.id === preview)?.view
		: undefined;
	let previewMarker = previewView ? markerOf(previewView.thread.id) : undefined;
	let previewRequest: PreviewRequest | undefined = previewView && previewMarker
			&& !previewMarker.button.offscreen
		? {
			button: previewMarker.button,
			id: `plan-comment-preview-${previewView.thread.id}`,
			page,
			size: CHIP,
			view: previewView,
			width: previewWidth,
		}
		: undefined;
	let previewValue = placedPreview(previewRequest, previewMeasurement);
	let activePreviewId = previewValue?.id;

	if (compact && draft?.placement) {
		compactKey = "draft";
		compactId = "plan-comment-draft";
		compactLabel = "New comment";
		compactClose = cancelDraft;
		compactContent = (
			<DraftCard
				busy={false}
				onCancel={cancelDraft}
				onSend={text => store.start(text)}
				showClose={false}
			/>
		);
	} else if (compact && pinned === "orphans" && orphaned.length > 0) {
		compactKey = "orphans";
		compactId = "plan-comment-thread-orphans";
		compactLabel = "Orphaned comments";
		compactClose = dismiss;
		compactContent = orphaned.map(view => card(view, false));
	} else if (compact && pinned && (pinnedView || pinnedList)) {
		// One sheet serves a block's list and its threads, so moving between them does not reopen it.
		compactKey = pinnedMarker && pinnedMarker.views.length > 1
			? `marker:${pinnedMarker.key}`
			: `thread:${pinned}`;
		compactId = dialogId(pinned);
		compactLabel = pinnedView ? "Comment thread" : "Comments";
		compactClose = dismiss;
		compactContent = pinnedView ? card(pinnedView, false) : (
			<ThreadList
				autoFocus={false}
				onSelect={selectThread}
				returnTo={returnTo}
				showClose={false}
				views={pinnedList!.views}
			/>
		);
	}

	let pinnedCard: CommentSurfaceValue | undefined;
	let pinnedPassage = pinnedMarker && union(
		placed
			.filter(entry =>
				pinnedView
					? entry.view.thread.id === pinnedView.thread.id
					: entry.marker === pinnedMarker.key
			)
			.flatMap(entry => entry.passages),
	);
	if (!compact && pinned && pinnedMarker && pinnedPassage && (pinnedView || pinnedList)) {
		let id = dialogId(pinned);
		let hoverId = pinnedView?.thread.id;
		pinnedCard = {
			ariaLabel: pinnedView ? "Comment thread" : "Comments",
			children: pinnedView
				? card(pinnedView)
				: (
					<ThreadList
						onClose={dismiss}
						onSelect={selectThread}
						returnTo={returnTo}
						views={pinnedMarker.views}
					/>
				),
			className: "plan-comment-card",
			id,
			onMeasure: element => rememberHeight(id, element),
			onMouseEnter: hoverId ? () => hover(hoverId) : undefined,
			onMouseLeave: hoverId ? () => unhover(hoverId) : undefined,
			...cardPlacement(pinnedPassage, id),
		};
	}
	// An open card keeps the reader on it: every other marker steps back.
	let engaged = !!pinned || !!draft?.placement;

	let documentChrome = createPortal(
		<div
			className="plan-comment-layer"
			data-plan-comment-presentation={compact ? "sheet" : "popover"}
			ref={root}
		>
			{placed.flatMap(({ hits, view }) =>
				hits.map((hit, index) => (
					<div
						aria-hidden="true"
						className="plan-comment-hit"
						data-plan-comment-hit={view.thread.id}
						key={`${view.thread.id}:${index}`}
						style={hit}
					/>
				))
			)}

			{markers.map(marker => {
				let { button, views } = marker;
				let single = views.length === 1 ? views[0] : undefined;
				let shown = !!pinned && marker === pinnedMarker;
				let dimmed = engaged && !shown;
				let replies = views.reduce(
					(total, view) => total + Math.max(0, view.thread.notes.length - 1),
					0,
				);
				let previewId = single ? `plan-comment-preview-${single.thread.id}` : undefined;
				let width = coarse ? Math.max(TOUCH_TARGET, button.width) : button.width;
				// Never taller than the first line, so a tap at the end of the second line reaches the text.
				let height = coarse ? Math.min(TOUCH_TARGET, Math.max(CHIP, marker.line)) : CHIP;
				// The touch area stays inside the document, so a chip in the padding keeps a full target.
				let left = Math.max(
					0,
					Math.min(button.left - (width - button.width) / 2, page.width - width),
				);
				return (
					<button
						aria-label={single
							? `Comment on “${single.quote}”. ${replyState(single)}`
							: `${views.length} comments on “${marker.excerpt}”`}
						aria-controls={shown ? dialogId(pinned!) : undefined}
						aria-describedby={single && preview === single.thread.id
								&& activePreviewId === previewId && !shown
							? previewId
							: undefined}
						aria-description={single ? replyState(single) : repliesWaiting(replies)}
						aria-expanded={shown}
						className="plan-comment-button"
						data-dimmed={dimmed || undefined}
						data-plan-comment-button={marker.key}
						data-plan-comment-count={single ? undefined : views.length}
						data-press="small"
						data-replies={replies > 0 || undefined}
						data-slim={button.slim || undefined}
						inert={dimmed || undefined}
						key={marker.key}
						onBlur={() => {
							if (single) unhover(single.thread.id);
							// A focused marker whose passage scrolled away hides once focus leaves it.
							measure();
						}}
						onClick={event => {
							origin.current = event.currentTarget;
							if (shown) dismiss();
							else {
								setReturnTo(undefined);
								setPinned(single ? single.thread.id : `${LIST}${marker.key}`);
							}
						}}
						onFocus={single ? () => hover(single.thread.id) : undefined}
						onMouseEnter={single ? () => hover(single.thread.id) : undefined}
						onMouseLeave={single ? () => unhover(single.thread.id) : undefined}
						style={{
							top: button.top - (height - CHIP) / 2,
							left,
							width,
							height,
							visibility: button.offscreen ? "hidden" : undefined,
						}}
						type="button"
					>
						<span
							className="plan-comment-chip"
							style={{ left: button.left - left, top: (height - CHIP) / 2, width: button.width }}
						>
							{(single || !button.slim) && (
								<MessageIcon aria-hidden="true" size={button.slim ? 10 : 14} />
							)}
							{!single && <span className="plan-comment-count">{views.length}</span>}
						</span>
					</button>
				);
			})}

			<PreviewSurface
				immediately={immediately}
				onMeasure={measurePreview}
				request={previewRequest}
				value={previewValue}
			/>

			<CommentSurface compact={false} immediately={immediately} value={pinnedCard} />

			<CommentSurface
				compact={false}
				immediately={immediately}
				value={draft?.placement && !compact
					? {
						ariaLabel: "New comment",
						children: (
							<DraftCard
								busy={false}
								onCancel={cancelDraft}
								onSend={text => store.start(text)}
							/>
						),
						className: "plan-comment-card",
						onMeasure: element => rememberHeight("draft", element),
						...cardPlacement(draft.placement, "draft"),
					}
					: undefined}
			/>

			{orphaned.length > 0 && (
				<div className="plan-comment-orphans">
					<button
						aria-controls={pinned === "orphans" ? "plan-comment-thread-orphans" : undefined}
						aria-expanded={pinned === "orphans"}
						aria-label={`${orphaned.length} orphaned comments`}
						className="plan-comment-orphan-button"
						onClick={event => {
							origin.current = event.currentTarget;
							setPinned(current => current === "orphans" ? undefined : "orphans");
						}}
						type="button"
					>
						{orphaned.length} comments without prose
					</button>
					<CommentSurface
						compact={false}
						immediately={immediately}
						value={pinned === "orphans" && !compact
							? {
								ariaLabel: "Orphaned comments",
								children: orphaned.map(view => card(view)),
								className: "plan-comment-card plan-comment-orphan-card",
								id: "plan-comment-thread-orphans",
							}
							: undefined}
					/>
				</div>
			)}
		</div>,
		host,
	);

	return (
		<>
			{documentChrome}
			{compactKey && compactId && compactLabel && compactClose && (
				<CommentSheet
					closeVisible={compactKey === "draft"}
					id={compactId}
					key={compactKey}
					label={compactLabel}
					onClose={compactClose}
				>
					{compactContent}
				</CommentSheet>
			)}
		</>
	);
}
