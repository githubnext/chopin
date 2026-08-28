/** Reader-local comment chrome overlays rather than mutates collaborative prose. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ChatCircleIcon } from "@phosphor-icons/react";
import { useCellValue } from "@mdxeditor/gurx";

import { DraftCard, ThreadCard } from "./comments";
import { edgePanelPoint, markerPoints, markerRect, popoverPoint } from "./comment-geometry";
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
import type { Point, Rect } from "./comment-geometry";
import type { PassageHit } from "./comment-hits";
import type { ThreadStore, ThreadView } from "./threads";

type PlacedThread = {
	view: ThreadView;
	button: Point;
	hits: PassageHit[];
	passages: Rect[];
};
type MeasuredThread = { view: ThreadView; target: Rect; passages: Rect[]; hits: Rect[] };
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
					<p className="plan-comment-preview-author">@{opening.handle}</p>
					<p className="plan-comment-preview-note">{opening.text}</p>
				</>
			)}
			{replies > 0 && <span>{replies} {replies === 1 ? "reply" : "replies"}</span>}
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
	let [previewMeasurement, setPreviewMeasurement] = useState<PreviewMeasurement>();
	let [pinned, setPinned] = useState<string>();
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
		let id = pinned === "orphans"
			? "plan-comment-thread-orphans"
			: `plan-comment-thread-${pinned}`;
		let dialog = document.getElementById(id);
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
		let measured: MeasuredThread[] = [];
		let size = coarse ? 44 : 24;

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
				let passages = target.hits.length > 0 ? target.hits : [targetRect];
				measured.push({
					view,
					target: targetRect,
					passages,
					hits: target.hits,
				});
			} catch (error) {
				// A bad anchor must not break Lexical's update listener.
				if (failures.current.has(view.thread.id)) continue;
				failures.current.add(view.thread.id);
				console.error(`[plan] could not measure comment ${view.thread.id}:`, error);
			}
		}
		let buttons = markerPoints(measured, page, size);
		let next = measured.map<PlacedThread>((entry, index) => ({
			view: entry.view,
			button: buttons[index]!,
			hits: passageHits(page, entry.hits),
			passages: entry.passages,
		}));

		placedRef.current = next;
		setPlaced(next);
	};

	useLayoutEffect(() => {
		measure();
	}, [host, state.threads, coarse]);

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
				`[data-plan-comment-button="${pending.id}"]`,
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
			: state.threads.some(view =>
				view.thread.id === pinned && view.thread.status === "open" && !view.orphaned
			);
		if (available) return;
		setPinned(undefined);
		setPreview(undefined);
		store.focus(undefined);
		restoreOrigin();
	}, [draft, editor, pinned, restoreOrigin, state.threads, store]);

	let sheetId = compact && pinned !== "orphans" ? pinned : undefined;
	let sheet = placed.find(entry => entry.view.thread.id === sheetId);
	let revealId = compact && draft?.placement ? "draft" : sheetId;
	let revealPassages = useMemo(
		() => compact && draft?.placement ? [draft.placement] : sheet?.passages,
		[compact, draft?.placement, sheet?.passages],
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
			let dialog = pinned
				? document.getElementById(`plan-comment-thread-${pinned}`)
				: undefined;
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
	let card = (view: ThreadView, showClose = true) => (
		<ThreadCard
			busy={false}
			canEdit={canEdit}
			focused={state.focused === view.thread.id}
			inDocument
			key={view.thread.id}
			onAccept={() => store.accept(view.thread.id)}
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
	let rememberHeight = (id: string, element: HTMLDivElement | null) => {
		let height = element?.offsetHeight;
		if (!height) return;
		setCardHeights(current => current[id] === height ? current : { ...current, [id]: height });
	};
	let page = host.getBoundingClientRect();
	let cardWidth = Math.min(320, host.clientWidth - 24);
	let previewWidth = Math.min(288, host.clientWidth * 0.8);
	let compactKey: string | undefined;
	let compactId: string | undefined;
	let compactLabel: string | undefined;
	let compactClose: (() => void) | undefined;
	let compactContent: ReactNode = undefined;
	let previewEntry = preview && pinned !== preview
		? placed.find(entry => entry.view.thread.id === preview)
		: undefined;
	let previewRequest: PreviewRequest | undefined = previewEntry
		? {
			button: previewEntry.button,
			id: `plan-comment-preview-${previewEntry.view.thread.id}`,
			page: rect(page),
			size: coarse ? 44 : 24,
			view: previewEntry.view,
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
	} else if (compact && pinned) {
		let pinnedView = state.threads.find(view =>
			view.thread.id === pinned && view.thread.status === "open"
		);
		if (pinnedView) {
			compactKey = `thread:${pinned}`;
			compactId = `plan-comment-thread-${pinned}`;
			compactLabel = "Comment thread";
			compactClose = dismiss;
			compactContent = card(pinnedView, false);
		}
	}

	let documentChrome = createPortal(
		<div
			className="plan-comment-layer"
			data-plan-comment-presentation={compact ? "sheet" : "popover"}
			ref={root}
		>
			{placed.map(({ button, hits, view }) => {
				let shown = pinned === view.thread.id;
				let previewId = `plan-comment-preview-${view.thread.id}`;
				let anchor = markerRect(button, page, coarse ? 44 : 24);
				let cardPoint = edgePanelPoint(
					anchor,
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
							aria-describedby={preview === view.thread.id && activePreviewId === previewId
									&& !shown
								? previewId
								: undefined}
							aria-description={replyState(view)}
							aria-expanded={shown}
							className="plan-comment-button"
							data-plan-comment-button={view.thread.id}
							onBlur={() => unhover(view.thread.id)}
							onClick={event => {
								origin.current = event.currentTarget;
								if (shown) dismiss();
								else setPinned(view.thread.id);
							}}
							onFocus={() => hover(view.thread.id)}
							onMouseEnter={() => hover(view.thread.id)}
							onMouseLeave={() => unhover(view.thread.id)}
							style={button}
							type="button"
						>
							<ChatCircleIcon aria-hidden="true" size={14} />
						</button>
						<CommentSurface
							compact={false}
							immediately={immediately}
							value={shown && !compact
								? {
									ariaLabel: "Comment thread",
									children: card(view),
									className: "plan-comment-card",
									id: `plan-comment-thread-${view.thread.id}`,
									onMeasure: element => rememberHeight(view.thread.id, element),
									onMouseEnter: () => hover(view.thread.id),
									onMouseLeave: () => unhover(view.thread.id),
									style: cardPoint,
								}
								: undefined}
						/>
					</div>
				);
			})}

			<PreviewSurface
				immediately={immediately}
				onMeasure={measurePreview}
				request={previewRequest}
				value={previewValue}
			/>

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
						style: edgePanelPoint(
							draft.placement,
							page,
							cardWidth,
							cardHeights.draft ?? 0,
						),
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
