/**
 * A resolved decision, as a marker beside the prose it produced.
 *
 * Reader-local chrome, like the comment layer it is modelled on: it is drawn
 * over the document from measurements and never put in it. Hovering the marker
 * or the prose washes the passage and previews the decision; pressing either
 * pins the same popover open, where the options not chosen and the close
 * button appear. What each of those says and where it sits is `resolved.ts`.
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
import { CheckIcon, ClockIcon, CloseIcon, DecisionIcon, MessageForwardIcon } from "@chopin/icons";
import { ResolvedActions } from "@chopin/question/react";
import { useCellValue } from "@mdxeditor/gurx";

import { currentDecision, releaseDecision, subscribeDecision } from "./decision-pin";
import { useResolvedActions } from "./resolved-actions";
import { decisionHostVisible } from "./decision-placement";
import { when } from "./card";
import { containsHit, passageHits } from "./comment-hits";
import { Face } from "./face";
import { COARSE_POINTER_QUERY } from "./pointer";
import {
	COMPACT_GUTTER,
	keyOf,
	MARKER_SIZE,
	MARKER_TOUCH_SIZE,
	markerPoint,
	ownedPoint,
	point,
	popoverBelow,
	resolvedKeys,
	shown,
	unchosen,
} from "./resolved";
import { useQuestionnaires, useRelations } from "./questionnaires";
import { blockElement } from "./scroll";
import { useTransitionPresence } from "./transition-presence";
import { widgets$ } from "./widget-options";

import type { CSSProperties, ReactNode } from "react";
import type { Rect } from "./comment-geometry";
import type { Question } from "@chopin/protocol";
import type { MarkerPlace, PointerAction } from "./resolved";
import type { PassageHit } from "./comment-hits";
import type { QuestionnaireStore } from "./questionnaires";

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

type Placed = {
	decision: Decision;
	marker: MarkerPlace;
	lineHeight: number;
	anchor: Rect;
	hits: PassageHit[];
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
 * The marker's box. A disc is padded out to the hit size around its centre; a
 * slim bar keeps its place in the gutter and only grows to a touch target
 * toward the prose side, where the bar is drawn at its left edge.
 */
function markerStyle(
	marker: MarkerPlace,
	lineHeight: number,
	hit: number,
	inset: number,
): CSSProperties {
	if (!marker.compact) return { top: marker.top - inset, left: marker.left - inset };
	let coarse = hit > MARKER_SIZE;
	let height = coarse ? Math.max(hit, lineHeight) : lineHeight;
	return {
		top: marker.top - (height - lineHeight) / 2,
		left: coarse ? 0 : marker.left,
		width: coarse ? hit : COMPACT_GUTTER,
		height,
		"--plan-decision-bar": `${coarse ? marker.left + 4 : 4}px`,
		"--plan-decision-line": `${lineHeight}px`,
	} as CSSProperties;
}

type PopoverValue = {
	decision: Decision;
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
	let { decision, pinned } = value;
	let others = decision.others ?? [];
	let discussion =
		decision.meta?.involved.filter(handle => handle.toLowerCase() !== decision.by?.toLowerCase())
			?? [];
	return (
		<>
			<div className="plan-decision-head">
				<p className="plan-decision-question">{decision.prompt}</p>
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
				<CheckIcon aria-hidden="true" />
				<span>{decision.answer}</span>
			</p>
			{others.length > 0 && (
				<div className="plan-decision-fold" inert={!pinned}>
					<div>
						{others.map(label => (
							<p className="plan-decision-answer" data-rejected="" key={label}>
								<CloseIcon aria-hidden="true" />
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
							<ClockIcon aria-hidden="true" />
							<span>{when(decision.at)}</span>
						</p>
					)}
				</div>
			)}
			{pinned && actions}
		</>
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
			aria-label={current.pinned ? "Decision" : undefined}
			className={`plan-comment-preview plan-decision-pop motion-comment-preview ${presence.className}`}
			data-motion-immediate={immediately || undefined}
			data-pinned={current.pinned ? "" : undefined}
			data-plan-decision-pop={current.decision.key}
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

export function ResolvedLayer({ store }: { store: QuestionnaireStore }) {
	let [editor] = useLexicalComposerContext();
	let options = useCellValue(widgets$);
	let entries = useQuestionnaires(store);
	let relations = useRelations(store);
	let [host, setHost] = useState<HTMLElement>();
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
		if (action.type === "pin" || action.type === "toggle" || action.type === "dismiss") {
			intent.current++;
		}
		dispatch(action);
	}, []);
	let [coarse, setCoarse] = useState(false);
	let [height, setHeight] = useState(0);
	let root = useRef<HTMLDivElement>(null);
	let placedRef = useRef<Placed[]>([]);
	let wasVisible = useRef(false);
	let leaving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	let press = useRef<{ left: number; top: number; moved: boolean } | undefined>(undefined);
	let painted = useRef(false);
	let restoring = useRef(false);
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
	let decisionsRef = useRef(decisions);
	decisionsRef.current = decisions;

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

	useEffect(() => {
		let query = matchMedia(COARSE_POINTER_QUERY);
		let update = () => setCoarse(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	let measure = useCallback(() => {
		if (!host || !decisionHostVisible(host)) {
			if (wasVisible.current) act({ type: "dismiss" });
			wasVisible.current = false;
			placedRef.current = [];
			setPlaced([]);
			return;
		}
		wasVisible.current = true;
		let page = rect(host.getBoundingClientRect());
		let next: Placed[] = [];
		for (let decision of decisionsRef.current) {
			try {
				let elements = [
					...new Set(
						decision.keys.map(key => blockElement(editor, key)).filter(
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
				let marker = markerPoint(first, lineHeight, page);
				next.push({ decision, marker, lineHeight, anchor: first, hits: passageHits(page, rects) });
			} catch (error) {
				// A bad anchor must not break Lexical's update listener.
				console.error(`[plan] could not place decision ${decision.key}:`, error);
			}
		}
		placedRef.current = next;
		setPlaced(next);
		act({ type: "prune", live: new Set(next.map(item => item.decision.key)) });
	}, [act, editor, host]);

	useLayoutEffect(() => {
		measure();
	}, [measure, decisions, coarse]);

	useEffect(() => {
		if (!host) return;
		let off = editor.registerUpdateListener(measure);
		host.addEventListener("scroll", measure, true);
		let observer = new ResizeObserver(measure);
		observer.observe(host);
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
		act({ type: "prune", live: new Set(decisions.map(decision => decision.key)) });
	}, [act, decisions]);

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
		if (!host) return;
		let over = (event: MouseEvent): Placed | undefined => {
			let page = host.getBoundingClientRect();
			let at = { top: event.clientY - page.top, left: event.clientX - page.left };
			return placedRef.current.find(entry => containsHit(entry.hits, at));
		};
		let inProse = (target: EventTarget | null) =>
			!!target && !!editor.getRootElement()?.contains(target as Node);
		let down = (event: PointerEvent) => {
			press.current = { left: event.clientX, top: event.clientY, moved: false };
		};
		let move = (event: PointerEvent) => {
			let pending = press.current;
			if (pending && Math.hypot(event.clientX - pending.left, event.clientY - pending.top) > 3) {
				pending.moved = true;
			}
			if (root.current?.contains(event.target as Node)) return;
			let entry = inProse(event.target) ? over(event) : undefined;
			if (entry) enter(entry.decision.key);
			else for (let item of placedRef.current) leave(item.decision.key);
		};
		let click = (event: MouseEvent) => {
			let pending = press.current;
			press.current = undefined;
			if (!pending || pending.moved || !inProse(event.target)) return;
			let entry = over(event);
			let selection = getSelection();
			if (!entry || (selection && !selection.isCollapsed)) return;
			origin.current = root.current?.querySelector<HTMLElement>(
				`[data-plan-decision-marker="${entry.decision.key}"]`,
			) ?? undefined;
			act({ type: "pin", key: entry.decision.key });
		};
		let out = () => {
			for (let item of placedRef.current) leave(item.decision.key);
		};
		host.addEventListener("pointerdown", down);
		host.addEventListener("pointermove", move);
		host.addEventListener("click", click);
		host.addEventListener("pointerleave", out);
		return () => {
			host.removeEventListener("pointerdown", down);
			host.removeEventListener("pointermove", move);
			host.removeEventListener("click", click);
			host.removeEventListener("pointerleave", out);
		};
	}, [act, editor, enter, host, leave]);

	useEffect(() => {
		if (!pointer.pinned || !enterPopover.current) return;
		enterPopover.current = false;
		root.current?.querySelector<HTMLElement>("[data-plan-decision-close]")?.focus();
	}, [pointer.pinned]);

	let view = shown(pointer);
	let open = view ? placed.find(entry => entry.decision.key === view.key) : undefined;

	// One wash at a time, and only the one this layer put up is taken down.
	let openKey = open?.decision.key;
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
			let target = event.target as Node;
			if (root.current?.contains(target)) return;
			// A press on the pinned prose is the click that pins it, not a dismissal.
			let page = host?.getBoundingClientRect();
			let entry = placedRef.current.find(item => item.decision.key === pointer.pinned);
			if (
				page && entry
				&& containsHit(entry.hits, {
					top: event.clientY - page.top,
					left: event.clientX - page.left,
				})
			) return;
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
	}, [act, dismiss, host, pointer.hover, pointer.pinned]);

	if (!host) return null;

	let page = rect(host.getBoundingClientRect());
	let hit = coarse ? MARKER_TOUCH_SIZE : MARKER_SIZE;
	let inset = (hit - MARKER_SIZE) / 2;
	let width = Math.min(POPOVER_WIDTH, host.clientWidth - 16);
	let value: PopoverValue | undefined;
	if (open && view) {
		let at = popoverBelow(open.anchor, page, width, height);
		let maxHeight = Math.max(0, page.height - 16);
		if (open.decision.meta) {
			at.top = Math.max(0, Math.min(at.top, page.height - Math.min(height, maxHeight) - 8));
		}
		value = {
			decision: open.decision,
			pinned: view.pinned,
			style: { ...at, width, ...(open.decision.meta ? { maxHeight, overflowY: "auto" } : {}) },
		};
	}
	let popoverId = "plan-decision-pop";
	let immediately = options.motionImmediately?.() ?? false;

	return createPortal(
		<div className="plan-decision-layer" ref={root}>
			{placed.map(({ decision, lineHeight, marker }) => {
				let isPinned = pointer.pinned === decision.key;
				let previewing = view?.key === decision.key && !view.pinned;
				return (
					<button
						aria-controls={view?.key === decision.key && view.pinned ? popoverId : undefined}
						aria-describedby={previewing ? popoverId : undefined}
						aria-expanded={isPinned}
						aria-label={`Decision: ${decision.answer}`}
						className="plan-decision-marker"
						data-plan-decision-marker={decision.key}
						data-press="small"
						key={decision.key}
						onBlur={() => leave(decision.key)}
						onClick={event => {
							origin.current = event.currentTarget;
							// Detail 0 is a key press: the popover is not next in tab order,
							// so focus goes to it rather than leaving the reader to find it.
							enterPopover.current = event.detail === 0 && !isPinned;
							act({ type: "toggle", key: decision.key });
						}}
						onFocus={() => !restoring.current && enter(decision.key)}
						onMouseEnter={() => enter(decision.key)}
						onMouseLeave={() => leave(decision.key)}
						data-compact={marker.compact || undefined}
						style={markerStyle(marker, lineHeight, hit, inset)}
						type="button"
					>
						<span className="plan-decision-disc">
							<DecisionIcon aria-hidden="true" />
						</span>
					</button>
				);
			})}
			<Surface
				id={popoverId}
				immediately={immediately}
				onMeasure={setHeight}
				render={current => {
					let decision = current.decision;
					let error = actions.error?.key === decision.key ? actions.error.message : undefined;
					let pending = actions.pending?.key === decision.key ? actions.pending.kind : undefined;
					return (
						<Popover
							close={dismiss}
							onSource={decision.meta?.thread && options.onCardSource
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
