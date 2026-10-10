import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
	AnimationEvent,
	CSSProperties,
	FocusEvent,
	KeyboardEvent,
	MouseEvent,
	PointerEvent,
	ReactNode,
} from "react";

import {
	ActualSizeIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
	FitWidthIcon,
	MinusIcon,
	PauseIcon,
	PlayIcon,
	PlusIcon,
	RestartIcon,
} from "@chopin/icons";

import { diagramTypographyVariables } from "./core/tokens.mjs";
import { type DiagramGraph, type DiagramResult, renderDiagram } from "./render";
import { DIAGRAM_VIEWPORT, fitDiagram } from "./viewport";
import {
	advance,
	currentStep,
	finish,
	initialPlayback,
	pause,
	play,
	type Playback,
	restart as restartPlayback,
	running,
	step as stepPlayback,
} from "./playback";
import { namespaceSvgIds } from "./viewer/namespace";

export type DiagramProps = {
	spec: unknown;
	title?: string;
	description?: string;
	/** Optional label within generated SVG resource IDs. */
	idPrefix?: string;
	/** Keep inspection and viewport state while this graph's live data changes. */
	stateKey?: string;
	/** Reader-owned presentation, separate from the saved diagram specification. */
	nodePresentation?: ReadonlyMap<string, {
		label: string;
		description?: string;
		tone?: "neutral" | "active" | "warning" | "success";
	}>;
	renderNodeDetails?: (id: string) => ReactNode;
	/** A host may offer an equivalent textual view when a diagram cannot render. */
	fallback?: ReactNode;
};

type ReadyDiagram = Extract<DiagramResult, { ok: true }>;
type Item = { kind: "node" | "edge"; id: string };
let diagramInstanceSequence = 0;
/** Reduced motion's discrete playback interval: the drawn stagger (`--sc-stagger`). */
const STILL_STEP_INTERVAL = 420;
/** Long enough for the last step's entrance, edge draw and arrowheads to finish. */
const LAST_STEP_SETTLE = 1000;

function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && typeof window.matchMedia === "function"
		&& window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const DiagramBody = memo(function DiagramBody({ body }: { body: string }) {
	return <g dangerouslySetInnerHTML={{ __html: body }} />;
});

function itemAt(
	svg: SVGSVGElement | null,
	target: EventTarget | null,
	graph: DiagramGraph | undefined,
): Item | null {
	if (!(target instanceof Element) || !svg?.contains(target) || !graph) return null;
	let element = target.closest<SVGElement>("[data-sc-node], [data-sc-edge]");
	if (!element || !svg.contains(element)) return null;
	let id = element.getAttribute("data-sc-node");
	if (id !== null) return graph.nodes.some((node) => node.id === id) ? { kind: "node", id } : null;
	id = element.getAttribute("data-sc-edge");
	return id !== null && graph.edges.some((edge) => edge.id === id) ? { kind: "edge", id } : null;
}

function sameItem(a: Item | null, b: Item | null): boolean {
	return a?.kind === b?.kind && a?.id === b?.id;
}

function DiagramView({
	result,
	title,
	description,
	idPrefix,
	nodePresentation,
	renderNodeDetails,
	onWidth,
}: Omit<DiagramProps, "spec"> & { result: ReadyDiagram; onWidth: (width: number) => void }) {
	let id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	let [instance] = useState(() => ++diagramInstanceSequence);
	let prefix = `chd-${idPrefix?.replace(/[^a-zA-Z0-9_-]/g, "") || "view"}-${id}-${instance}`;
	let titleId = `${prefix}-title`;
	let descriptionId = `${prefix}-description`;
	let stageRef = useRef<HTMLDivElement>(null);
	let svgRef = useRef<SVGSVGElement>(null);
	let sourceLabels = useRef(new WeakMap<SVGElement, string>());
	let [preview, setPreview] = useState<Item | null>(null);
	let [selected, setSelected] = useState<Item | null>(null);
	let [reduced, setReduced] = useState(prefersReducedMotion);
	let motion = result.motion && result.motion !== "none" ? result.motion : null;
	let maxStep = motion ? Math.max(0, result.steps ?? 0) : 0;
	let [mode, setMode] = useState<Playback>(() => initialPlayback(maxStep, reduced));
	let [playback, setPlayback] = useState(0);
	let [overflowing, setOverflowing] = useState(false);
	let [available, setAvailable] = useState(0);
	let [zoom, setZoom] = useState(1);
	let graph = result.graph;
	let nodes = graph?.nodes ?? [];
	let edges = graph?.edges ?? [];
	let interactive = nodes.length > 0;
	let isRunning = running(mode);
	let current = currentStep(mode, maxStep);
	// Animation plays the steps in; otherwise the stepped view shows them.
	let animated = mode.kind === "playing" && !reduced;
	let step = animated || maxStep === 0 ? null : current;
	let body = useMemo(() => namespaceSvgIds(result.body, prefix), [result.body, prefix]);
	let active = preview ?? selected;

	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		let query = window.matchMedia("(prefers-reduced-motion: reduce)");
		let update = () => setReduced(query.matches);
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	// Animated playback counts each step as its animation starts (onAnimationStart).
	// Reduced motion has no animation to follow, so it shows one step per interval.
	let playingFrom = mode.kind === "playing" ? mode.from : null;
	useEffect(() => {
		if (playingFrom === null || !reduced) return;
		let timers: ReturnType<typeof setTimeout>[] = [];
		for (let to = playingFrom + 1; to <= maxStep; to++) {
			timers.push(
				setTimeout(
					() => setMode((current) => advance(current, maxStep, to)),
					(to - Math.max(1, playingFrom)) * STILL_STEP_INTERVAL,
				),
			);
		}
		return () => timers.forEach(clearTimeout);
	}, [playingFrom, playback, maxStep, reduced]);

	let reachedEnd = maxStep > 0 && mode.kind === "playing" && mode.at >= maxStep;
	useEffect(() => {
		if (!reachedEnd) return;
		let timer = setTimeout(
			() => setMode((current) => finish(current, maxStep)),
			reduced ? STILL_STEP_INTERVAL : LAST_STEP_SETTLE,
		);
		return () => clearTimeout(timer);
	}, [reachedEnd, playback, maxStep, reduced]);

	useEffect(() => {
		let stage = stageRef.current;
		let svg = svgRef.current;
		if (!stage || !svg) return;
		let measure = () => {
			setOverflowing(stage.scrollWidth > stage.clientWidth + 1);
			setAvailable(stage.clientWidth);
			onWidth(stage.clientWidth);
		};
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(stage);
		observer.observe(svg);
		return () => observer.disconnect();
	}, [body, playback, onWidth, zoom]);

	useEffect(() => {
		let svg = svgRef.current;
		if (!svg) return;
		let tabIndex = (element: SVGElement) => {
			let value = element.closest("[data-sc-step]")?.getAttribute("data-sc-step");
			return step === null || value === null || value === undefined || Number(value) <= step
				? "0"
				: "-1";
		};
		for (let element of svg.querySelectorAll<SVGElement>("[data-sc-node]")) {
			let nodeId = element.getAttribute("data-sc-node");
			let node = nodes.find((entry) => entry.id === nodeId);
			let presentation = nodeId === null ? undefined : nodePresentation?.get(nodeId);
			let label = sourceLabels.current.get(element)
				?? element.getAttribute("aria-label") ?? node?.label ?? `Node ${nodeId}`;
			sourceLabels.current.set(element, label);
			element.setAttribute("tabindex", tabIndex(element));
			element.setAttribute("role", "button");
			element.setAttribute(
				"aria-label",
				presentation
					? [presentation.label, presentation.description].filter(Boolean).join(", ")
					: label,
			);
			if (presentation?.tone) element.setAttribute("data-sc-tone", presentation.tone);
			else element.removeAttribute("data-sc-tone");
		}
		for (let element of svg.querySelectorAll<SVGElement>("[data-sc-edge]")) {
			let edgeId = element.getAttribute("data-sc-edge");
			let edge = edges.find((entry) => entry.id === edgeId);
			if (!edge) continue;
			let from = nodePresentation?.get(edge.from)?.label
				?? nodes.find((entry) => entry.id === edge.from)?.label ?? edge.from;
			let to = nodePresentation?.get(edge.to)?.label
				?? nodes.find((entry) => entry.id === edge.to)?.label ?? edge.to;
			element.setAttribute("tabindex", tabIndex(element));
			element.setAttribute("role", "button");
			element.setAttribute("aria-label", `${from} to ${to}`);
		}
	}, [body, playback, edges, nodes, step, nodePresentation]);

	useEffect(() => {
		let svg = svgRef.current;
		if (!svg) return;
		let litNodes = new Set<string>();
		let litEdges = new Set<string>();
		if (active?.kind === "node") {
			litNodes.add(active.id);
			for (let edge of edges) {
				if (edge.from !== active.id && edge.to !== active.id) continue;
				litEdges.add(edge.id);
				litNodes.add(edge.from);
				litNodes.add(edge.to);
			}
		} else if (active?.kind === "edge") {
			litEdges.add(active.id);
			let edge = edges.find((entry) => entry.id === active.id);
			if (edge) {
				litNodes.add(edge.from);
				litNodes.add(edge.to);
			}
		}
		svg.classList.toggle("is-dim", active !== null);
		for (let element of svg.querySelectorAll<SVGElement>("[data-sc-node], [data-sc-edge]")) {
			let nodeId = element.getAttribute("data-sc-node");
			let edgeId = element.getAttribute("data-sc-edge");
			element.setAttribute(
				"aria-pressed",
				String(
					nodeId !== null
						? selected?.kind === "node" && selected.id === nodeId
						: selected?.kind === "edge" && selected.id === edgeId,
				),
			);
			element.classList.toggle(
				"is-lit",
				nodeId !== null ? litNodes.has(nodeId) : litEdges.has(edgeId ?? ""),
			);
			element.classList.toggle(
				"is-current",
				nodeId !== null
					? active?.kind === "node" && active.id === nodeId
					: active?.kind === "edge" && active.id === edgeId,
			);
		}
	}, [active, selected, body, playback, edges]);

	// Before paint, so a resumed playback never flashes steps that were already on screen.
	useLayoutEffect(() => {
		let svg = svgRef.current;
		if (!svg) return;
		let done = animated ? playingFrom ?? 0 : 0;
		for (let element of svg.querySelectorAll<SVGElement>("[data-sc-step]")) {
			let elementStep = Number(element.getAttribute("data-sc-step"));
			let hidden = step !== null && elementStep > step;
			element.classList.toggle("is-shown", step !== null && !hidden);
			element.classList.toggle("is-done", elementStep <= done);
			if (hidden) element.setAttribute("aria-hidden", "true");
			else element.removeAttribute("aria-hidden");
		}
	}, [body, step, playback, animated, playingFrom]);

	let select = (item: Item | null) => {
		setSelected((current) => sameItem(current, item) ? null : item);
		setPreview(null);
	};
	let enter = (item: Item | null) => {
		if (item) setPreview(item);
	};
	let leave = (target: EventTarget | null, related: EventTarget | null) => {
		let current = itemAt(svgRef.current, target, graph);
		let next = itemAt(svgRef.current, related, graph);
		if (current && !sameItem(current, next)) setPreview(null);
	};
	let onPointerOver = (event: PointerEvent<SVGSVGElement>) => {
		if (event.pointerType !== "touch") enter(itemAt(svgRef.current, event.target, graph));
	};
	let onPointerOut = (event: PointerEvent<SVGSVGElement>) =>
		leave(event.target, event.relatedTarget);
	let onFocus = (event: FocusEvent<SVGSVGElement>) =>
		enter(itemAt(svgRef.current, event.target, graph));
	let onBlur = (event: FocusEvent<SVGSVGElement>) => leave(event.target, event.relatedTarget);
	let onClick = (event: MouseEvent<SVGSVGElement>) => {
		let item = itemAt(svgRef.current, event.target, graph);
		if (item) select(item);
	};
	let onAnimationStart = (event: AnimationEvent<SVGSVGElement>) => {
		if (!(event.target instanceof Element)) return;
		let value = event.target.closest("[data-sc-step]")?.getAttribute("data-sc-step");
		if (value) setMode((current) => advance(current, maxStep, Number(value)));
	};
	let onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		let item = itemAt(svgRef.current, event.target, graph);
		if (!item) return;
		event.preventDefault();
		select(item);
	};
	let showStep = (delta: number) => {
		if (isRunning || (delta < 0 ? current <= 1 : current >= maxStep)) return;
		setPreview(null);
		setSelected(null);
		setMode(stepPlayback(mode, maxStep, delta));
	};
	// Entering playback remounts the drawing so its entrance animation starts again.
	let startPlayback = (next: Playback) => {
		setPreview(null);
		setSelected(null);
		setMode(next);
		setPlayback((count) => count + 1);
	};
	let togglePlayback = () => {
		if (isRunning) setMode(pause(mode, maxStep));
		else startPlayback(play(mode, maxStep));
	};
	let selectedNode = selected?.kind === "node"
		? nodes.find((node) => node.id === selected.id)
		: null;
	let selectedEdge = selected?.kind === "edge"
		? edges.find((edge) => edge.id === selected.id)
		: null;
	let related = selectedNode
		? edges.filter((edge) => edge.from === selectedNode.id || edge.to === selectedNode.id)
		: [];
	let stepping = maxStep > 0;
	let zoomable = result.viewBox[2] > available || zoom !== 1;
	let labelFor = (nodeId: string) =>
		nodePresentation?.get(nodeId)?.label
			?? nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
	let status = maxStep > 0 && !isRunning && (mode.kind === "paused" || reduced)
		? `Step ${current} of ${maxStep}`
		: selectedNode
		? `${labelFor(selectedNode.id)}: ${related.length} connection${related.length === 1 ? "" : "s"}`
		: selectedEdge
		? `${labelFor(selectedEdge.from)} to ${labelFor(selectedEdge.to)}`
		: "";

	return (
		<figure className="ch-diagram" style={diagramTypographyVariables as CSSProperties}>
			<div
				ref={stageRef}
				className="ch-diagram__stage"
				tabIndex={overflowing ? 0 : undefined}
				aria-label={overflowing ? "Diagram, scroll horizontally" : undefined}
			>
				<svg
					ref={svgRef}
					style={{
						"--sc-display-width": `${result.viewBox[2] * zoom}px`,
						"--sc-from": animated ? playingFrom ?? 0 : 0,
					} as CSSProperties}
					className={`sc-svg${animated ? "" : " sc-still"}${step !== null ? " sc-stepping" : ""}`}
					viewBox={result.viewBox.join(" ")}
					role={interactive ? "group" : "img"}
					aria-labelledby={`${titleId} ${descriptionId}`}
					data-sc-type={result.type}
					data-sc-motion={motion ?? undefined}
					data-sc-steps={maxStep}
					onPointerOver={onPointerOver}
					onPointerOut={onPointerOut}
					onFocusCapture={onFocus}
					onBlurCapture={onBlur}
					onClick={onClick}
					onKeyDown={onKeyDown}
					onAnimationStart={onAnimationStart}
				>
					<title id={titleId}>{title ?? result.title}</title>
					<desc id={descriptionId}>{description ?? result.description}</desc>
					<DiagramBody key={playback} body={body} />
				</svg>
			</div>
			{(stepping || zoomable) && (
				<div className="ch-diagram__controls" role="group" aria-label="Diagram controls">
					{stepping && (
						<div className="ch-diagram__control-group">
							<button
								className="ch-diagram__control"
								type="button"
								onClick={togglePlayback}
								aria-label={isRunning ? "Pause diagram" : "Play diagram"}
							>
								{isRunning ? <PauseIcon /> : <PlayIcon />}
							</button>
							<button
								className="ch-diagram__control"
								type="button"
								onClick={() => showStep(-1)}
								aria-disabled={isRunning || current <= 1}
								aria-label="Previous step"
							>
								<ArrowLeftIcon />
							</button>
							<span className="ch-diagram__step" aria-hidden="true">
								{current} / {maxStep}
							</span>
							<button
								className="ch-diagram__control"
								type="button"
								onClick={() =>
									showStep(1)}
								aria-disabled={isRunning || current >= maxStep}
								aria-label="Next step"
							>
								<ArrowRightIcon />
							</button>
							<button
								className="ch-diagram__control"
								type="button"
								onClick={() =>
									startPlayback(restartPlayback())}
								aria-label="Restart diagram"
							>
								<RestartIcon />
							</button>
						</div>
					)}
					{zoomable && (
						<div className="ch-diagram__control-group">
							<button
								className="ch-diagram__control"
								type="button"
								aria-label="Zoom out diagram"
								aria-disabled={zoom <= DIAGRAM_VIEWPORT.minimumZoom}
								onClick={() =>
									setZoom(current =>
										Math.max(DIAGRAM_VIEWPORT.minimumZoom, current - DIAGRAM_VIEWPORT.zoomStep)
									)}
							>
								<MinusIcon />
							</button>
							<output className="ch-diagram__zoom" aria-label="Diagram zoom">
								{Math.round(zoom * 100)}%
							</output>
							<button
								className="ch-diagram__control"
								type="button"
								aria-label="Zoom in diagram"
								aria-disabled={zoom >= DIAGRAM_VIEWPORT.maximumZoom}
								onClick={() =>
									setZoom(current =>
										Math.min(DIAGRAM_VIEWPORT.maximumZoom, current + DIAGRAM_VIEWPORT.zoomStep)
									)}
							>
								<PlusIcon />
							</button>
							<button
								className="ch-diagram__control"
								type="button"
								aria-label="Fit to width"
								onClick={() => setZoom(fitDiagram(result.viewBox[2], available))}
							>
								<FitWidthIcon />
							</button>
							<button
								className="ch-diagram__control"
								type="button"
								aria-label="Actual size"
								aria-pressed={zoom === 1}
								onClick={() =>
									setZoom(1)}
							>
								<ActualSizeIcon />
							</button>
						</div>
					)}
				</div>
			)}
			{selected && (
				<aside className="ch-diagram__inspector" aria-label="Diagram details">
					<div className="ch-diagram__inspector-head">
						<div>
							<p>{selected.kind === "node" ? "Node" : "Connection"}</p>
							<h3>
								{selectedNode ? labelFor(selectedNode.id) : (selectedEdge
									? `${labelFor(selectedEdge.from)} → ${labelFor(selectedEdge.to)}`
									: selected.id)}
							</h3>
						</div>
						<button
							type="button"
							onClick={() => setSelected(null)}
							aria-label="Close diagram details"
						>
							Close
						</button>
					</div>
					{selectedNode?.group && <p className="ch-diagram__group">{selectedNode.group}</p>}
					{selectedNode && renderNodeDetails?.(selectedNode.id)}
					{related.length > 0 && (
						<ul className="ch-diagram__connections">
							{related.map((edge) => {
								let other = edge.from === selectedNode?.id ? edge.to : edge.from;
								return (
									<li key={edge.id}>
										<button type="button" onClick={() => select({ kind: "node", id: other })}>
											{edge.from === selectedNode?.id ? "To" : "From"} {labelFor(other)}
										</button>
									</li>
								);
							})}
						</ul>
					)}
				</aside>
			)}
			{/* Mounted before it has text, so the first change is announced. */}
			<figcaption
				className="ch-diagram__status"
				data-visually-hidden={step !== null || !status ? "" : undefined}
				role="status"
			>
				{status}
			</figcaption>
		</figure>
	);
}

export function Diagram({ spec, ...props }: DiagramProps) {
	let [availableWidth, setAvailableWidth] = useState<number>();
	let result = useMemo(() => renderDiagram(spec, { availableWidth }), [spec, availableWidth]);
	if (!result.ok) {
		if (props.fallback !== undefined) return <>{props.fallback}</>;
		return (
			<div className="ch-diagram ch-diagram--error" role="alert">
				<p>Unable to render diagram</p>
				<ul>
					{result.problems.map((problem, index) => (
						<li key={`${problem.code}-${index}`}>{problem.msg}</li>
					))}
				</ul>
			</div>
		);
	}
	let fingerprint = JSON.stringify(spec);
	return (
		<DiagramView
			key={props.stateKey ?? fingerprint}
			result={result}
			onWidth={setAvailableWidth}
			title={props.title}
			description={props.description}
			idPrefix={props.idPrefix}
			nodePresentation={props.nodePresentation}
			renderNodeDetails={props.renderNodeDetails}
		/>
	);
}
