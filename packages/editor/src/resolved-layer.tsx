/**
 * A resolved decision, as a marker beside the prose it produced.
 *
 * A resolved comment whose turn edited the document stands in the same lane,
 * in the comment's amber, beside what it wrote. The two share one pin, and
 * markers that land on one block stack down the lane.
 *
 * Reader-local chrome, like the comment layer it is modelled on: it is drawn
 * over the document from measurements and never put in it. Only the marker
 * answers: hovering or focusing it washes the passage and previews the
 * decision, and pressing it pins the same popover open, where the options not
 * chosen and the close button appear. The prose itself stays quiet so reading
 * it never pops anything up. What each of those says and where it sits is
 * `resolved.ts`.
 */

import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	CheckIcon,
	ClockIcon,
	CloseIcon,
	DecisionIcon,
	MessageForwardIcon,
	MessageIcon,
} from "@chopin/icons";
import { InlineCode, ResolvedActions } from "@chopin/question/react";
import { useCellValue } from "@mdxeditor/gurx";

import { currentDecision, releaseDecision, subscribeDecision } from "./decision-pin";
import { useResolvedActions } from "./resolved-actions";
import { decisionHostVisible } from "./decision-placement";
import { when } from "./card";
import { Note, stamp } from "./comments";
import { displayName } from "./display-name";
import { Face } from "./face";
import { $rangeOf, paintShared } from "./marks";
import {
	commentKey,
	COMPACT_GUTTER,
	keyOf,
	markerPoint,
	markerReach,
	ownedPoint,
	point,
	popoverBelow,
	resolvedCommentMeta,
	resolvedKeys,
	shown,
	stack,
	unchosen,
	verticalReach,
} from "./resolved";
import { useQuestionnaires, useRelations } from "./questionnaires";
import { blockElement } from "./scroll";
import { openCommentThread } from "./threads";
import { useTransitionPresence } from "./transition-presence";
import { widgets$ } from "./widget-options";

import type { CSSProperties, ReactNode } from "react";
import type { Rect } from "./comment-geometry";
import type { Question } from "@chopin/protocol";
import type { MarkerPlace, PointerAction } from "./resolved";
import type { QuestionnaireStore } from "./questionnaires";
import type { ResolvedView, ThreadStore } from "./threads";

/** One answered question that has prose to sit beside. */
type Decision = {
	key: string;
	widget: string;
	question: string;
	prompt: string;
	answer: string;
	/** Undefined when the answer cannot be read back against the options. */
	others?: string[];
	by?: string;
	at?: string;
	keys: string[];
	meta?: Question.CardMeta;
};

/** A marker in the lane: a resolved decision, or a resolved comment that led to edits. */
type Item =
	| { kind: "decision"; key: string; keys: string[]; decision: Decision }
	| { kind: "comment"; key: string; keys: string[]; comment: ResolvedView };

/** The amber wash over what a resolved comment's turn wrote, while its marker is pointed at. */
const RESOLVED_COMMENT = "plan-comment-resolved";

const NO_RESOLVED: ResolvedView[] = [];
function noThreads() {
	return () => {};
}
function noResolved() {
	return NO_RESOLVED;
}

function excerpt(text: string): string {
	let flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 60 ? `${flat.slice(0, 59).trimEnd()}…` : flat;
}

type Placed = {
	item: Item;
	marker: MarkerPlace;
	lineHeight: number;
	markerSize: number;
	anchor: Rect;
	/** Where the prose starts, from the host's left edge. */
	prose: number;
};

const POPOVER_WIDTH = 336;
const EMPTY_META: ReadonlyMap<string, Question.CardMeta> = new Map();
function emptyMeta() {
	return EMPTY_META;
}
function noMeta() {
	return () => {};
}

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

function lineHeightOf(element: HTMLElement): number {
	let style = getComputedStyle(element);
	let lineHeight = Number.parseFloat(style.lineHeight);
	return Number.isFinite(lineHeight) ? lineHeight : Number.parseFloat(style.fontSize) * 1.6;
}

/**
 * The marker's drawn box, and how far its invisible reach may extend sideways
 * without leaving the gutter. A slim bar is drawn at its box's left edge.
 */
function markerStyle(
	marker: MarkerPlace,
	lineHeight: number,
	markerSize: number,
	prose: number,
	vertical: { top: number; bottom: number },
): CSSProperties {
	let width = marker.compact ? COMPACT_GUTTER : markerSize;
	let reach = markerReach(marker.left, width, prose);
	return {
		top: marker.top,
		left: marker.left,
		"--plan-decision-reach-start": `${reach.start}px`,
		"--plan-decision-reach-end": `${reach.end}px`,
		"--plan-decision-reach-top": `${vertical.top}px`,
		"--plan-decision-reach-bottom": `${vertical.bottom}px`,
		...(marker.compact && {
			width,
			height: lineHeight,
			"--plan-decision-line": `${lineHeight}px`,
		}),
	} as CSSProperties;
}

type PopoverValue = {
	item: Item;
	pinned: boolean;
	style: CSSProperties;
};

function Popover(
	{ actions, close, onSource, value }: {
		actions?: ReactNode;
		close: () => void;
		onSource?: () => void;
		value: PopoverValue;
	},
) {
	let { item, pinned } = value;
	if (item.kind !== "decision") return null;
	let { decision } = item;
	let others = decision.others ?? [];
	let discussion =
		decision.meta?.involved.filter(handle => handle.toLowerCase() !== decision.by?.toLowerCase())
			?? [];
	return (
		<>
			<div className="plan-decision-head">
				<p className="plan-decision-question">
					<InlineCode text={decision.prompt} />
				</p>
				<span className="plan-decision-tools" inert={!pinned}>
					{onSource && (
						<button
							aria-label="Show source in chat"
							className="btn btn-icon btn-ghost"
							onClick={onSource}
							type="button"
						>
							<MessageForwardIcon aria-hidden="true" />
						</button>
					)}
					<button
						aria-label="Close"
						className="btn btn-icon btn-ghost"
						data-plan-decision-close=""
						onClick={close}
						type="button"
					>
						<CloseIcon aria-hidden="true" />
					</button>
				</span>
			</div>
			<p className="plan-decision-answer">
				<CheckIcon aria-hidden="true" className="icon-first-line" />
				<span>{decision.answer}</span>
			</p>
			{others.length > 0 && (
				<div className="plan-decision-fold" inert={!pinned}>
					<div>
						{others.map(label => (
							<p className="plan-decision-answer" data-rejected="" key={label}>
								<CloseIcon aria-hidden="true" className="icon-first-line" />
								<span>{label}</span>
							</p>
						))}
					</div>
				</div>
			)}
			{(decision.by || decision.at) && (
				<div className="plan-decision-meta">
					{decision.by && (
						<p>
							<Face handle={decision.by} size={18} titled={false} />
							<span>
								<strong>{decision.by}</strong>
								{discussion.length > 0 && `, with ${discussion.join(", ")}`}
							</span>
						</p>
					)}
					{decision.at && when(decision.at) && (
						<p>
							<ClockIcon aria-hidden="true" className="icon-first-line" />
							<span>{when(decision.at)}</span>
						</p>
					)}
				</div>
			)}
			{pinned && actions}
		</>
	);
}

function CommentPopover(
	{ close, error, onReopen, pending, value }: {
		close: () => void;
		error?: string;
		onReopen?: () => void;
		pending: boolean;
		value: PopoverValue;
	},
) {
	let { item, pinned } = value;
	if (item.kind !== "comment") return null;
	let { thread } = item.comment;
	let first = thread.notes[0];
	if (!pinned) {
		return (
			<div className="plan-resolved-comment">
				{first && (
					<ol className="plan-comment-notes">
						<Note note={first} />
					</ol>
				)}
				<p className="plan-resolved-comment-meta">
					{resolvedCommentMeta(
						{ notes: thread.notes.length, resolver: thread.resolver },
						displayName,
					)}
				</p>
			</div>
		);
	}
	let at = thread.at !== undefined ? stamp(thread.at) : "";
	return (
		<div className="plan-resolved-comment" data-pinned="">
			<div className="plan-resolved-comment-head">
				<p className="plan-resolved-comment-status">
					<CheckIcon aria-hidden="true" size={14} />
					<span>
						{thread.resolver ? `Resolved by ${displayName(thread.resolver)}` : "Resolved"}
						{at && ` · ${at}`}
					</span>
				</p>
				{onReopen && (
					<button
						aria-disabled={pending || undefined}
						className="btn btn-sm btn-outline"
						// aria-disabled rather than disabled, so focus stays on the button while it works.
						onClick={() => !pending && onReopen()}
						type="button"
					>
						Reopen
					</button>
				)}
				<button
					aria-label="Close"
					className="btn btn-icon btn-ghost plan-resolved-comment-close"
					data-plan-decision-close=""
					onClick={close}
					type="button"
				>
					<CloseIcon aria-hidden="true" size={14} />
				</button>
			</div>
			<ol className="plan-comment-notes">
				{thread.notes.map(note => <Note key={note.id} note={note} />)}
			</ol>
			{error && <p className="m-0 text-sm text-destructive-ink" role="alert">{error}</p>}
		</div>
	);
}

function Surface(
	{ id, immediately, onMeasure, render, value }: {
		id: string;
		immediately: boolean;
		onMeasure: (height: number) => void;
		render: (value: PopoverValue) => ReactNode;
		value?: PopoverValue;
	},
) {
	let presence = useTransitionPresence(value, 150, immediately);
	let element = useRef<HTMLDivElement>(null);
	let present = presence.phase !== "closed";
	useEffect(() => {
		let node = element.current;
		if (!node || !present) return;
		let observe = new ResizeObserver(() => onMeasure(node.offsetHeight));
		observe.observe(node);
		onMeasure(node.offsetHeight);
		return () => observe.disconnect();
	}, [onMeasure, present]);
	if (presence.phase === "closed") return null;
	let active = presence.phase !== "closing";
	let current = presence.value;
	return (
		<div
			aria-hidden={active ? undefined : "true"}
			aria-label={current.pinned
				? current.item.kind === "comment" ? "Resolved comment" : "Decision"
				: undefined}
			className={`plan-comment-preview plan-decision-pop motion-comment-preview ${presence.className}`}
			data-kind={current.item.kind}
			data-motion-immediate={immediately || undefined}
			data-pinned={current.pinned ? "" : undefined}
			data-plan-decision-pop={current.item.key}
			id={id}
			inert={!active}
			ref={element}
			role={current.pinned ? "dialog" : "tooltip"}
			style={current.style}
		>
			{render(current)}
		</div>
	);
}

export function ResolvedLayer(
	{ store, threads }: { store: QuestionnaireStore; threads?: ThreadStore },
) {
	let [editor] = useLexicalComposerContext();
	let resolvedComments = useSyncExternalStore(
		threads?.subscribe ?? noThreads,
		threads ? () => threads.snapshot().resolved : noResolved,
		noResolved,
	);
	let [reopening, setReopening] = useState<{ key: string; error?: string }>();
	let options = useCellValue(widgets$);
	let entries = useQuestionnaires(store);
	let relations = useRelations(store);
	let [host, setHost] = useState<HTMLElement>();
	let scroller = useMemo(() => host?.querySelector<HTMLElement>("[data-plan-scroll]"), [host]);
	let [placed, setPlaced] = useState<Placed[]>([]);
	let [pointer, dispatch] = useReducer(point, {});
	let pointerRef = useRef(pointer);
	pointerRef.current = pointer;
	let owner = useRef<object>({});
	let intent = useRef(0);
	let meta = useSyncExternalStore(
		options.cardMeta?.subscribe ?? noMeta,
		options.cardMeta?.snapshot ?? emptyMeta,
		emptyMeta,
	);
	let [editable, setEditable] = useState(editor.isEditable());
	let act = useCallback((action: PointerAction) => {
		let next = ownedPoint(owner.current, pointerRef.current, action);
		pointerRef.current = next;
		if (action.type === "toggle" || action.type === "dismiss") {
			intent.current++;
		}
		dispatch(action);
	}, []);
	let [height, setHeight] = useState(0);
	let root = useRef<HTMLDivElement>(null);
	let markers = useRef<HTMLDivElement>(null);
	let markerProbe = useRef<HTMLSpanElement>(null);
	let wasVisible = useRef(false);
	let leaving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	let painted = useRef(false);
	let restoring = useRef(false);
	let pressing = useRef(false);
	let enterPopover = useRef(false);
	let origin = useRef<HTMLElement | undefined>(undefined);

	let decisions = useMemo<Decision[]>(() => {
		let out: Decision[] = [];
		for (let entry of entries) {
			for (let question of entry.value.questions) {
				let card = meta.get(entry.id);
				let keys = resolvedKeys(
					question,
					store.blocks(entry.id, question.id),
					entry.value.questions.length === 1 ? store.proseKey(entry.id) : undefined,
					card,
				);
				if (question.answer === undefined || keys.length === 0) continue;
				out.push({
					key: keyOf({ widget: entry.id, question: question.id }),
					widget: entry.id,
					question: question.id,
					prompt: question.prompt,
					answer: question.answer,
					others: unchosen(question),
					by: card?.owner ?? entry.value.by,
					at: card?.decidedAt !== undefined
						? new Date(card.decidedAt * 1_000).toISOString()
						: entry.value.at,
					keys,
					meta: card,
				});
			}
		}
		return out;
		// `relations` is what says the blocks behind a decision were re-resolved.
	}, [entries, meta, relations, store]);
	let items = useMemo<Item[]>(() => [
		...decisions.map((decision): Item => ({
			kind: "decision",
			key: decision.key,
			keys: decision.keys,
			decision,
		})),
		...resolvedComments.map((comment): Item => ({
			kind: "comment",
			key: commentKey(comment.thread.id),
			keys: comment.keys,
			comment,
		})),
	], [decisions, resolvedComments]);
	let itemsRef = useRef(items);
	itemsRef.current = items;

	useEffect(() => editor.registerEditableListener(setEditable), [editor]);
	useEffect(() => {
		let off = subscribeDecision(() => {
			let current = currentDecision();
			if (current && current.owner !== owner.current) {
				intent.current++;
				pointerRef.current = {};
				dispatch({ type: "dismiss" });
			}
		});
		return () => {
			off();
			releaseDecision(owner.current);
		};
	}, []);
	let closeAfterReply = useCallback(() => {
		releaseDecision(owner.current);
		pointerRef.current = {};
		dispatch({ type: "dismiss" });
	}, []);
	let actions = useResolvedActions({
		canEdit: options.canEdit !== false && options.connected === true
			&& editable,
		dismiss: closeAfterReply,
		editor,
		entries,
		host,
		intent,
		meta,
		owner: owner.current,
		wire: options.wire,
	});

	useEffect(() => {
		return editor.registerRootListener(element => {
			setHost(element?.closest<HTMLElement>(".plan-document") ?? undefined);
		});
	}, [editor]);

	let measure = useCallback(() => {
		if (!host || !decisionHostVisible(host)) {
			if (wasVisible.current) act({ type: "dismiss" });
			wasVisible.current = false;
			setPlaced([]);
			return;
		}
		wasVisible.current = true;
		let probe = markerProbe.current;
		if (!probe) return;
		let markerSize = Number.parseFloat(getComputedStyle(probe).inlineSize);
		if (!Number.isFinite(markerSize) || markerSize <= 0) {
			setPlaced([]);
			return;
		}
		let page = rect(host.getBoundingClientRect());
		let markerHost = scroller ? rect(scroller.getBoundingClientRect()) : page;
		let next: Placed[] = [];
		for (let item of itemsRef.current) {
			try {
				let elements = [
					...new Set(
						item.keys.map(key => blockElement(editor, key)).filter(
							(element): element is HTMLElement => !!element?.isConnected,
						),
					),
				];
				let rects = elements.map(element => rect(element.getBoundingClientRect())).filter(value =>
					value.width > 0 && value.height > 0 && value.bottom >= page.top
					&& value.top <= page.bottom
				);
				if (rects.length === 0) continue;
				let first = rects.reduce((top, value) => value.top < top.top ? value : top);
				let element = elements[rects.indexOf(first)]!;
				let lineHeight = lineHeightOf(element);
				let marker = markerPoint(first, lineHeight, markerHost, markerSize);
				let prose = first.left - markerHost.left;
				// Content coordinates let the browser carry markers with native scrolling.
				if (scroller) {
					marker.top += scroller.scrollTop - scroller.clientTop;
					marker.left += scroller.scrollLeft - scroller.clientLeft;
					prose += scroller.scrollLeft - scroller.clientLeft;
				}
				next.push({ item, marker, markerSize, lineHeight, anchor: first, prose });
			} catch (error) {
				// A bad anchor must not break Lexical's update listener.
				console.error(`[plan] could not place marker ${item.key}:`, error);
			}
		}
		let tops = stack(next.map(({ lineHeight, marker, markerSize }) => ({
			top: marker.top,
			left: marker.left,
			height: marker.compact ? lineHeight : markerSize,
		})));
		next.forEach((entry, index) => {
			entry.marker.top = tops[index]!;
		});
		setPlaced(next);
		act({ type: "prune", live: new Set(next.map(entry => entry.item.key)) });
	}, [act, editor, host, scroller]);

	useLayoutEffect(() => {
		measure();
	}, [measure, items]);

	useEffect(() => {
		if (!host) return;
		let off = editor.registerUpdateListener(measure);
		host.addEventListener("scroll", measure, true);
		let observer = new ResizeObserver(measure);
		observer.observe(host);
		if (markerProbe.current) observer.observe(markerProbe.current);
		// React card collapses move prose without resizing the host or updating Lexical.
		let offRoot = editor.registerRootListener((element, previous) => {
			if (previous) observer.unobserve(previous);
			if (element) observer.observe(element);
		});
		let attributes = new MutationObserver(measure);
		for (let node: HTMLElement | null = host; node; node = node.parentElement) {
			attributes.observe(node, {
				attributes: true,
				attributeFilter: ["hidden", "inert", "aria-hidden", "style", "class"],
			});
		}
		window.addEventListener("resize", measure);
		return () => {
			off();
			offRoot();
			attributes.disconnect();
			window.removeEventListener("resize", measure);
			host.removeEventListener("scroll", measure, true);
			observer.disconnect();
		};
	}, [editor, host, measure]);

	useEffect(() => {
		act({ type: "prune", live: new Set(items.map(item => item.key)) });
	}, [act, items]);

	let enter = useCallback((key: string) => {
		clearTimeout(leaving.current);
		act({ type: "enter", key });
	}, [act]);
	let leave = useCallback((key: string) => {
		clearTimeout(leaving.current);
		leaving.current = setTimeout(() => act({ type: "leave", key }), 100);
	}, [act]);
	useEffect(() => () => clearTimeout(leaving.current), []);

	let restoreFocus = useCallback(() => {
		let target = origin.current;
		if (!target?.isConnected) return;
		if (
			root.current?.contains(document.activeElement) || document.activeElement === document.body
		) {
			// Giving focus back is not a request for the preview.
			restoring.current = true;
			target.focus();
			restoring.current = false;
		}
	}, []);
	let dismiss = useCallback(() => {
		act({ type: "dismiss" });
		restoreFocus();
	}, [act, restoreFocus]);

	useEffect(() => {
		if (!pointer.pinned || !enterPopover.current) return;
		enterPopover.current = false;
		root.current?.querySelector<HTMLElement>("[data-plan-decision-close]")?.focus();
	}, [pointer.pinned]);

	let view = shown(pointer);
	let open = view ? placed.find(entry => entry.item.key === view.key) : undefined;

	// One wash at a time, and only the one this layer put up is taken down.
	let openKey = open?.item.key;
	useEffect(() => {
		if (!host || !decisionHostVisible(host)) return;
		let decision = decisions.find(item => item.key === openKey);
		if (!decision) return;
		store.highlight(decision.widget, decision.question);
		painted.current = true;
		return () => {
			if (!painted.current) return;
			painted.current = false;
			store.clear();
		};
	}, [decisions, host, openKey, store]);

	useEffect(() => {
		if (!pointer.pinned && !pointer.hover) return;
		let outside = (event: PointerEvent) => {
			if (!pointer.pinned) return;
			if (root.current?.contains(event.target as Node)) return;
			if (markers.current?.contains(event.target as Node)) return;
			act({ type: "dismiss" });
		};
		let escape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// A hover preview goes quietly; only a pinned popover owns the key, so
			// Escape still reaches whatever else (a child document) it would close.
			if (pointer.pinned) event.preventDefault();
			dismiss();
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", escape);
		};
	}, [act, dismiss, pointer.hover, pointer.pinned]);

	// A resolved comment washes what its turn wrote, in the comment's amber, while
	// its marker is pointed at. Repainted with every placement, because ranges go
	// stale as the prose moves.
	let openComment = open?.item.kind === "comment" ? open.item.comment : undefined;
	useEffect(() => {
		if (!openComment) return;
		let ranges: Range[] = [];
		try {
			editor.getEditorState().read(() => {
				for (let points of openComment.places) {
					let range = $rangeOf(editor, points);
					if (range) ranges.push(range);
				}
			});
		} catch (error) {
			console.error("[plan] could not wash a resolved comment:", error);
		}
		paintShared(RESOLVED_COMMENT, editor, ranges);
		return () => paintShared(RESOLVED_COMMENT, editor, []);
	}, [editor, openComment, placed]);

	let reopen = useCallback((key: string, id: string) => {
		if (!threads) return;
		setReopening({ key });
		void threads.reopen(id).then(outcome => {
			// Somebody else reopened it first: it is open, which is what was asked.
			if (!outcome.ok && outcome.reason !== "open") {
				setReopening({
					key,
					error: outcome.reason === "full"
						? "Couldn’t reopen: this document has too many open comments"
						: "Couldn’t reopen the comment",
				});
				return;
			}
			setReopening(undefined);
			releaseDecision(owner.current);
			pointerRef.current = {};
			dispatch({ type: "dismiss" });
			// The comment layer opens the card once the thread has its passage back.
			openCommentThread(id, { focus: true });
		});
	}, [threads]);

	if (!host) return null;

	let page = rect(host.getBoundingClientRect());
	let width = Math.min(POPOVER_WIDTH, host.clientWidth - 16);
	let value: PopoverValue | undefined;
	if (open && view) {
		let at = popoverBelow(open.anchor, page, width, height);
		let maxHeight = Math.max(0, page.height - 16);
		if (open.item.kind === "comment" || open.item.decision.meta) {
			at.top = Math.max(0, Math.min(at.top, page.height - Math.min(height, maxHeight) - 8));
		}
		let scrolls = open.item.kind === "comment" || !!open.item.decision.meta;
		value = {
			item: open.item,
			pinned: view.pinned,
			style: { ...at, width, ...(scrolls ? { maxHeight, overflowY: "auto" } : {}) },
		};
	}
	let vertical = verticalReach(
		placed.map(({ lineHeight, marker, markerSize }) => ({
			top: marker.top,
			height: marker.compact ? lineHeight : markerSize,
		})),
	);
	let popoverId = "plan-decision-pop";
	let immediately = options.motionImmediately?.() ?? false;

	return createPortal(
		<div className="plan-decision-layer" ref={root}>
			{createPortal(
				<div className="plan-decision-layer" ref={markers}>
					<span
						aria-hidden="true"
						className="plan-decision-disc plan-decision-size-probe"
						ref={markerProbe}
					/>
					{placed.map(({ item, lineHeight, marker, markerSize, prose }, index) => {
						let key = item.key;
						let isPinned = pointer.pinned === key;
						let previewing = view?.key === key && !view.pinned;
						let opening = item.kind === "comment" ? item.comment.thread.notes[0]?.text : undefined;
						return (
							<button
								aria-controls={view?.key === key && view.pinned ? popoverId : undefined}
								aria-describedby={previewing ? popoverId : undefined}
								aria-expanded={isPinned}
								aria-label={item.kind === "decision"
									? `Decision: ${item.decision.answer}`
									: `Resolved comment${opening ? `: ${excerpt(opening)}` : ""}`}
								className="plan-decision-marker"
								data-kind={item.kind}
								data-plan-decision-marker={key}
								data-press="small"
								key={key}
								onBlur={() => {
									pressing.current = false;
									leave(key);
								}}
								onClick={event => {
									pressing.current = false;
									origin.current = event.currentTarget;
									// Detail 0 is a key press: the popover is not next in tab order,
									// so focus goes to it rather than leaving the reader to find it.
									enterPopover.current = event.detail === 0 && !isPinned;
									act({ type: "toggle", key });
								}}
								onFocus={() => !restoring.current && !pressing.current && enter(key)}
								onPointerDown={() => {
									// A press focuses too; a mouse already showed the preview and touch has none.
									pressing.current = true;
								}}
								onPointerEnter={event => event.pointerType !== "touch" && enter(key)}
								onPointerLeave={() => leave(key)}
								data-compact={marker.compact || undefined}
								style={markerStyle(marker, lineHeight, markerSize, prose, vertical[index]!)}
								type="button"
							>
								<span className="plan-decision-disc">
									{item.kind === "decision"
										? <DecisionIcon aria-hidden="true" />
										: <MessageIcon aria-hidden="true" />}
								</span>
							</button>
						);
					})}
				</div>,
				scroller ?? host,
			)}
			<Surface
				id={popoverId}
				immediately={immediately}
				onMeasure={setHeight}
				render={current => {
					if (current.item.kind === "comment") {
						let { item } = current;
						let canReopen = !!threads && options.canEdit !== false && options.connected === true
							&& editable;
						return (
							<CommentPopover
								close={dismiss}
								error={reopening?.key === item.key ? reopening.error : undefined}
								onReopen={canReopen
									? () => reopen(item.key, item.comment.thread.id)
									: undefined}
								pending={reopening?.key === item.key && !reopening.error}
								value={current}
							/>
						);
					}
					let decision = current.item.decision;
					let error = actions.error?.key === decision.key ? actions.error.message : undefined;
					let pending = actions.pending?.key === decision.key
						? actions.pending.kind
						: undefined;
					return (
						<Popover
							close={dismiss}
							onSource={decision.meta?.thread && options.onCardSource
									&& options.hasCardSource?.(decision.widget)
								? () => options.onCardSource?.(decision.widget)
								: undefined}
							value={current}
							actions={decision.meta && (
								<>
									{error && (
										<p className="mt-2 text-sm text-destructive-ink" role="alert">{error}</p>
									)}
									{pending && (
										<p className="mt-2 text-sm text-text-tertiary" role="status">
											{pending === "discard" ? "Discarding…" : "Reopening…"}
										</p>
									)}
									<ResolvedActions
										className="mt-3 flex flex-wrap items-center justify-end gap-2"
										disabled={options.canEdit === false || options.connected !== true
											|| !editable || !options.wire}
										key={`${decision.key}:${intent.current}`}
										onDiscard={() => actions.request("discard", decision)}
										onReopen={() => actions.request("reopen", decision)}
										submitting={!!pending}
									/>
								</>
							)}
						/>
					);
				}}
				value={value}
			/>
		</div>,
		host,
	);
}
