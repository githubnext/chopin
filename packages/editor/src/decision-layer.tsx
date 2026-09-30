/** Reader-local chrome for a decision whose answer has become ordinary prose. */

import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useCellValue } from "@mdxeditor/gurx";
import { $nodesOfType } from "lexical";
import { DecisionIcon } from "@chopin/icons";
import { QuestionnaireNode } from "@chopin/dialect";

import { decisionPanelPoint } from "./comment-geometry";
import type { CardMetaStore } from "./card-meta";
import {
	claimDecision,
	currentDecision,
	decisionReplyCurrent,
	releaseDecision,
	subscribeDecision,
} from "./decision-pin";
import { DecisionDialogContent, DecisionSummary } from "./decision-surface";
import { decisionHostVisible, useDecisionPlacement } from "./decision-placement";
import { paint } from "./marks";
import { $blockPoints } from "./passage";
import { useQuestionnaires } from "./questionnaires";
import { scrollToKey } from "./scroll";
import { useTransitionPresence } from "./transition-presence";
import { widgets$ } from "./widget-options";

import type { CSSProperties } from "react";
import type { Questionnaire } from "@chopin/dialect";
import type { Question } from "@chopin/protocol";
import type { PlacedDecision } from "./decision-placement";
import type { QuestionnaireStore } from "./questionnaires";

type Panel = {
	id: string;
	mode: "preview" | "dialog";
	item: PlacedDecision;
	value: Questionnaire;
	meta: Question.CardMeta;
};
type Size = { id: string; mode: Panel["mode"]; height: number };

const EMPTY_META: ReadonlyMap<string, Question.CardMeta> = new Map();

export function DecisionLayer({ store }: { store: QuestionnaireStore }) {
	let [editor] = useLexicalComposerContext();
	let options = useCellValue(widgets$);
	let entries = useQuestionnaires(store);
	let targets = useSyncProse(store);
	let meta = useSyncMeta(options.cardMeta);
	let pin = useSyncDecision();
	let owner = useRef<object>({});
	let pinId = pin?.owner === owner.current ? pin.id : undefined;
	let [host, setHost] = useState<HTMLElement>();
	let [hoverId, setHoverId] = useState<string>();
	let [previewId, setPreviewId] = useState<string>();
	let [size, setSize] = useState<Size>();
	let [confirming, setConfirming] = useState(false);
	let [pending, setPending] = useState<{ id: string; kind: "discard" | "reopen" }>();
	let [error, setError] = useState<string>();
	let [awaitingReopen, setAwaitingReopen] = useState<{ id: string; intent: number }>();
	let [editable, setEditable] = useState(editor.isEditable());
	let hoverRef = useRef<string | undefined>(undefined);
	let suppressedHover = useRef<string | undefined>(undefined);
	let openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	let closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	let pendingRef = useRef(false);
	let panelRef = useRef<HTMLDivElement>(null);
	let closeRef = useRef<HTMLButtonElement>(null);
	let markers = useRef(new Map<string, HTMLButtonElement>());
	let alive = useRef(true);
	let intent = useRef(0);
	let immediate = options.motionImmediately?.() ?? false;
	let canMutate = options.canEdit !== false && options.connected === true && editable
		&& !!options.wire;
	let values = useMemo(() => new Map(entries.map(entry => [entry.id, entry.value])), [entries]);

	useEffect(() =>
		editor.registerRootListener(element => {
			setHost(element?.closest<HTMLElement>(".plan-document") ?? undefined);
		}), [editor]);
	useLayoutEffect(() => {
		if (!host) return;
		host.toggleAttribute("data-plan-decision-lane", targets.length > 0);
		return () => host.removeAttribute("data-plan-decision-lane");
	}, [host, targets.length]);
	useEffect(() => editor.registerEditableListener(setEditable), [editor]);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			clearTimeout(openTimer.current);
			clearTimeout(closeTimer.current);
			releaseDecision(owner.current);
			paint(editor, "decisions", []);
		};
	}, [editor]);
	useEffect(() =>
		subscribeDecision(() => {
			let current = currentDecision();
			if (current && current.owner !== owner.current) intent.current++;
		}), []);

	let enter = useCallback((id: string) => {
		if (suppressedHover.current === id) return;
		suppressedHover.current = undefined;
		clearTimeout(closeTimer.current);
		if (hoverRef.current === id) return;
		hoverRef.current = id;
		clearTimeout(openTimer.current);
		setHoverId(id);
		setPreviewId(undefined);
		openTimer.current = setTimeout(() => setPreviewId(id), 150);
	}, []);
	let leave = useCallback((id: string) => {
		if (suppressedHover.current === id) {
			suppressedHover.current = undefined;
			return;
		}
		if (hoverRef.current !== id) return;
		clearTimeout(openTimer.current);
		clearTimeout(closeTimer.current);
		closeTimer.current = setTimeout(() => {
			if (hoverRef.current !== id) return;
			hoverRef.current = undefined;
			setHoverId(undefined);
			setPreviewId(undefined);
		}, 120);
	}, []);
	let resetHover = useCallback(() => {
		clearTimeout(openTimer.current);
		clearTimeout(closeTimer.current);
		hoverRef.current = undefined;
		setHoverId(undefined);
		setPreviewId(undefined);
	}, []);
	let leaveActive = useCallback(() => {
		if (hoverRef.current) leave(hoverRef.current);
		else suppressedHover.current = undefined;
	}, [leave]);
	let hidden = useCallback(() => {
		intent.current++;
		suppressedHover.current = undefined;
		resetHover();
		releaseDecision(owner.current);
	}, [resetHover]);
	let layout = useDecisionPlacement({
		editor,
		enter,
		host,
		leave: leaveActive,
		meta,
		onHidden: hidden,
		targets,
		values,
	});

	let placed = layout?.placed ?? [];
	useEffect(() => {
		if (hoverRef.current && !placed.some(item => item.id === hoverRef.current)) resetHover();
	}, [placed, resetHover]);
	let active = pinId ?? hoverId;
	useEffect(() => {
		let key = placed.find(item => item.id === active)?.key;
		if (!key) {
			paint(editor, "decisions", []);
			return;
		}
		let points = editor.getEditorState().read(() => $blockPoints(key));
		paint(editor, "decisions", points ? [points] : []);
		return () => paint(editor, "decisions", []);
	}, [active, editor, placed]);
	useEffect(() => {
		if (pinId && !placed.some(item => item.id === pinId)) releaseDecision(owner.current, pinId);
	}, [pinId, placed]);
	useEffect(() => {
		if (!previewId || pinId) return;
		let keyboard = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			resetHover();
			suppressedHover.current = previewId;
		};
		document.addEventListener("keydown", keyboard, true);
		return () => document.removeEventListener("keydown", keyboard, true);
	}, [pinId, previewId, resetHover]);
	useEffect(() => {
		if (pending?.kind !== "discard" || meta.get(pending.id)?.status !== "discarded") return;
		setPending(undefined);
		releaseDecision(owner.current, pending.id);
	}, [meta, pending]);

	let dismiss = useCallback((restore: boolean, manual = true) => {
		if (manual) intent.current++;
		let id = currentDecision()?.owner === owner.current ? currentDecision()?.id : undefined;
		releaseDecision(owner.current);
		setConfirming(false);
		setError(undefined);
		if (restore && id) requestAnimationFrame(() => markers.current.get(id)?.focus());
	}, []);
	useEffect(() => {
		if (!pinId) return;
		closeRef.current?.focus();
		let keyboard = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			dismiss(true);
		};
		let outside = (event: PointerEvent) => {
			let target = event.target;
			if (
				target instanceof Node && (panelRef.current?.contains(target)
					|| markers.current.get(pinId)?.contains(target))
			) return;
			dismiss(false);
			requestAnimationFrame(() => {
				if (
					document.activeElement === document.body || document.activeElement === closeRef.current
				) {
					markers.current.get(pinId)?.focus();
				}
			});
		};
		document.addEventListener("keydown", keyboard, true);
		document.addEventListener("pointerdown", outside, true);
		return () => {
			document.removeEventListener("keydown", keyboard, true);
			document.removeEventListener("pointerdown", outside, true);
		};
	}, [dismiss, pinId]);

	useEffect(() => {
		if (
			!awaitingReopen
			|| !decisionReplyCurrent(
				owner.current,
				awaitingReopen.id,
				awaitingReopen.intent,
				intent.current,
			)
		) {
			if (awaitingReopen) setAwaitingReopen(undefined);
			return;
		}
		if (
			meta.get(awaitingReopen.id)?.status !== "reopened"
			|| values.get(awaitingReopen.id)?.status !== "reopened"
		) return;
		let key = editor.getEditorState().read(() =>
			$nodesOfType(QuestionnaireNode)
				.find(node =>
					node.getId() === awaitingReopen.id
					&& node.getQuestionnaire().status === "reopened"
				)?.getKey()
		);
		if (!key) return;
		let frame = requestAnimationFrame(() => {
			if (
				decisionReplyCurrent(
					owner.current,
					awaitingReopen.id,
					awaitingReopen.intent,
					intent.current,
				) && host && decisionHostVisible(host)
			) {
				scrollToKey(editor, key);
			}
			setAwaitingReopen(undefined);
		});
		return () => cancelAnimationFrame(frame);
	}, [awaitingReopen, editor, host, meta, pin, values]);

	let request = (kind: "discard" | "reopen", id: string) => {
		let wire = options.wire;
		if (!canMutate || !wire || pendingRef.current || pinId !== id) return;
		let started = intent.current;
		pendingRef.current = true;
		setPending({ id, kind });
		setError(undefined);
		let failure = kind === "reopen"
			? "Could not reopen this decision. Try again."
			: "Could not discard this decision. Try again.";
		void wire.ask<Question.Reopen.Reply | Question.Discard.Reply>(
			kind === "reopen" ? "question:reopen" : "question:discard",
			{ id },
		).then(reply => {
			if (!alive.current) return;
			let current = decisionReplyCurrent(owner.current, id, started, intent.current);
			if (!reply.ok) {
				if (current) setError(failure);
				setPending(undefined);
				return;
			}
			if (kind === "reopen") {
				if (current) {
					setAwaitingReopen({ id, intent: started });
					dismiss(false, false);
				}
				setPending(undefined);
			}
			// Discard waits for the authoritative meta update to remove its marker.
		}).catch(() => {
			if (!alive.current) return;
			if (decisionReplyCurrent(owner.current, id, started, intent.current)) setError(failure);
			setPending(undefined);
		}).finally(() => {
			pendingRef.current = false;
		});
	};

	let shownId = pinId ?? (previewId && previewId === hoverId ? previewId : undefined);
	let shown = placed.find(item => item.id === shownId);
	let value = shown ? values.get(shown.id) : undefined;
	let card = shown ? meta.get(shown.id) : undefined;
	let panel: Panel | undefined = useMemo(() =>
		shown && value && card
			? { id: shown.id, mode: pinId ? "dialog" : "preview", item: shown, value, meta: card }
			: undefined, [shown, value, card, pinId]);
	let presence = useTransitionPresence(panel, 150, immediate);
	let presented = presence.value;
	let width = layout ? Math.max(0, Math.min(352, layout.host.width - 24)) : 0;
	let point = presented && layout
		? decisionPanelPoint(
			presented.item.target,
			layout.host,
			width,
			size?.id === presented.id && size.mode === presented.mode ? size.height : 0,
		)
		: undefined;
	let panelStyle: CSSProperties | undefined = point ? { ...point, width } : undefined;
	useLayoutEffect(() => {
		let element = panelRef.current;
		if (!element || !presented) return;
		let update = () => {
			let height = element.offsetHeight;
			setSize(current =>
				current?.id === presented.id && current.mode === presented.mode
					&& current.height === height
					? current
					: { id: presented.id, mode: presented.mode, height }
			);
		};
		update();
		let resize = new ResizeObserver(update);
		resize.observe(element);
		return () => resize.disconnect();
	}, [presented?.id, presented?.mode, presented?.meta, presented?.value]);

	if (!host || !layout) return null;
	return createPortal(
		<div className="plan-decision-layer">
			{placed.map(item => {
				let question = values.get(item.id)?.questions[0]?.prompt;
				if (!question) return null;
				let previewing = previewId === item.id && !pinId;
				return (
					<button
						aria-describedby={previewing ? `plan-decision-preview-${item.id}` : undefined}
						aria-expanded={pinId === item.id}
						aria-label={`Decision: ${question}`}
						className="plan-decision-marker"
						key={item.id}
						onBlur={() => leave(item.id)}
						onClick={() => {
							intent.current++;
							setConfirming(false);
							setError(undefined);
							if (pinId === item.id) dismiss(true, false);
							else claimDecision(owner.current, item.id);
						}}
						onFocus={() => enter(item.id)}
						onPointerEnter={() => enter(item.id)}
						onPointerLeave={() => leave(item.id)}
						ref={element => {
							if (element) markers.current.set(item.id, element);
							else markers.current.delete(item.id);
						}}
						style={item.marker}
						type="button"
					>
						<DecisionIcon aria-hidden="true" size={14} />
					</button>
				);
			})}
			{presented && point && (
				<div
					aria-hidden={presence.phase === "closing" ? "true" : undefined}
					aria-label={presented.mode === "dialog"
						? `Decision: ${presented.value.questions[0]?.prompt ?? ""}`
						: undefined}
					className={`plan-decision-panel motion-decision-panel ${presence.className}`}
					data-motion-immediate={immediate || undefined}
					id={presented.mode === "preview" ? `plan-decision-preview-${presented.id}` : undefined}
					inert={presence.phase === "closing"}
					ref={panelRef}
					role={presented.mode === "dialog" ? "dialog" : "tooltip"}
					style={panelStyle}
				>
					{presented.mode === "dialog"
						? (
							<DecisionDialogContent
								closeRef={closeRef}
								confirming={confirming}
								editable={canMutate && !pending}
								error={error}
								meta={presented.meta}
								onClose={() => dismiss(true)}
								onDiscard={() => {
									if (!confirming) setConfirming(true);
									else request("discard", presented.id);
								}}
								onKeep={() => setConfirming(false)}
								onReopen={() => request("reopen", presented.id)}
								onSource={options.onCardSource
									? () => options.onCardSource?.(presented.id)
									: undefined}
								pending={pending?.id === presented.id ? pending.kind : undefined}
								value={presented.value}
							/>
						)
						: <DecisionSummary meta={presented.meta} value={presented.value} />}
				</div>
			)}
		</div>,
		host,
	);
}

function useSyncProse(store: QuestionnaireStore) {
	return useSyncExternalStore(
		store.subscribe,
		() => store.proseTargets(),
		() => store.proseTargets(),
	);
}

function useSyncMeta(store: CardMetaStore | undefined) {
	return useSyncExternalStore(
		store?.subscribe ?? (() => () => {}),
		store?.snapshot ?? (() => EMPTY_META),
		() => EMPTY_META,
	);
}

function useSyncDecision() {
	return useSyncExternalStore(subscribeDecision, currentDecision, currentDecision);
}
