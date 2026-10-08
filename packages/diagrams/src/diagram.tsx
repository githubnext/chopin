import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from "react";

import { type DiagramGraph, type DiagramResult, renderDiagram } from "./render";
import { namespaceSvgIds } from "./viewer/namespace";

export type DiagramProps = {
	spec: unknown;
	title?: string;
	description?: string;
	/** Optional label within generated SVG resource IDs. */
	idPrefix?: string;
};

type ReadyDiagram = Extract<DiagramResult, { ok: true }>;
type Item = { kind: "node" | "edge"; id: string };
type Playback = { kind: "playing" | "still" } | { kind: "step"; index: number };
let diagramInstanceSequence = 0;

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
}: Omit<DiagramProps, "spec"> & { result: ReadyDiagram }) {
	let id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	let [instance] = useState(() => ++diagramInstanceSequence);
	let prefix = `chd-${idPrefix?.replace(/[^a-zA-Z0-9_-]/g, "") || "view"}-${id}-${instance}`;
	let titleId = `${prefix}-title`;
	let descriptionId = `${prefix}-description`;
	let scrollHintId = `${prefix}-scroll-hint`;
	let stageRef = useRef<HTMLDivElement>(null);
	let svgRef = useRef<SVGSVGElement>(null);
	let [preview, setPreview] = useState<Item | null>(null);
	let [selected, setSelected] = useState<Item | null>(null);
	let [mode, setMode] = useState<Playback>({ kind: "playing" });
	let [playback, setPlayback] = useState(0);
	let [reduced, setReduced] = useState(false);
	let [overflowing, setOverflowing] = useState(false);
	let graph = result.graph;
	let nodes = graph?.nodes ?? [];
	let edges = graph?.edges ?? [];
	let interactive = nodes.length > 0;
	let motion = result.motion && result.motion !== "none" ? result.motion : null;
	let maxStep = motion ? Math.max(0, result.steps ?? 0) : 0;
	let step = mode.kind === "step" ? mode.index : null;
	let body = useMemo(() => namespaceSvgIds(result.body, prefix), [result.body, prefix]);
	let active = preview ?? selected;

	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		let query = window.matchMedia("(prefers-reduced-motion: reduce)");
		let update = () => setReduced(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	useEffect(() => {
		let stage = stageRef.current;
		let svg = svgRef.current;
		if (!stage || !svg) return;
		let measure = () => setOverflowing(stage.scrollWidth > stage.clientWidth + 1);
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(stage);
		observer.observe(svg);
		return () => observer.disconnect();
	}, [body, playback]);

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
			element.setAttribute("tabindex", tabIndex(element));
			element.setAttribute("role", "button");
			if (!element.hasAttribute("aria-label")) {
				element.setAttribute("aria-label", node?.label ?? `Node ${nodeId}`);
			}
		}
		for (let element of svg.querySelectorAll<SVGElement>("[data-sc-edge]")) {
			let edgeId = element.getAttribute("data-sc-edge");
			let edge = edges.find((entry) => entry.id === edgeId);
			if (!edge) continue;
			let from = nodes.find((entry) => entry.id === edge.from)?.label ?? edge.from;
			let to = nodes.find((entry) => entry.id === edge.to)?.label ?? edge.to;
			element.setAttribute("tabindex", tabIndex(element));
			element.setAttribute("role", "button");
			element.setAttribute("aria-label", `${from} to ${to}`);
		}
	}, [body, playback, edges, nodes, step]);

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
	}, [active, playback, edges]);

	useEffect(() => {
		let svg = svgRef.current;
		if (!svg) return;
		for (let element of svg.querySelectorAll<SVGElement>("[data-sc-step]")) {
			let elementStep = Number(element.getAttribute("data-sc-step"));
			let hidden = step !== null && elementStep > step;
			element.classList.toggle("is-shown", step !== null && !hidden);
			if (hidden) element.setAttribute("aria-hidden", "true");
			else element.removeAttribute("aria-hidden");
		}
	}, [step, playback]);

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
	let onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		let item = itemAt(svgRef.current, event.target, graph);
		if (!item) return;
		event.preventDefault();
		select(item);
	};
	let showStep = (next: number) => {
		setPreview(null);
		setSelected(null);
		setMode({ kind: "step", index: Math.max(0, Math.min(maxStep, next)) });
	};
	let reset = () => {
		setPreview(null);
		setSelected(null);
		setMode({ kind: "still" });
	};
	let replay = () => {
		setPreview(null);
		setMode({ kind: "playing" });
		setPlayback((current) => current + 1);
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
	let labelFor = (nodeId: string) => nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
	let status = step !== null
		? `Step ${step} of ${maxStep}`
		: selectedNode
		? `${selectedNode.label}: ${related.length} connection${related.length === 1 ? "" : "s"}`
		: selectedEdge
		? `${labelFor(selectedEdge.from)} to ${labelFor(selectedEdge.to)}`
		: "";

	return (
		<figure className="ch-diagram">
			{(maxStep > 0 || selected) && (
				<div className="ch-diagram__controls" role="group" aria-label="Diagram controls">
					{maxStep > 0 && (
						<>
							<button
								type="button"
								onClick={() => showStep((step ?? maxStep) - 1)}
								disabled={step === 0}
								aria-label="Previous step"
							>
								Previous
							</button>
							<button
								type="button"
								onClick={() =>
									showStep((step ?? 0) + 1)}
								disabled={step === maxStep}
								aria-label="Next step"
							>
								Next
							</button>
							{!reduced && (
								<button type="button" onClick={replay} aria-label="Replay diagram">Replay</button>
							)}
						</>
					)}
					<button type="button" onClick={reset} aria-label="Reset diagram">Reset</button>
				</div>
			)}
			<div
				ref={stageRef}
				className="ch-diagram__stage"
				tabIndex={overflowing ? 0 : undefined}
				aria-label={overflowing ? "Diagram, scroll horizontally" : undefined}
				aria-describedby={overflowing ? scrollHintId : undefined}
			>
				<svg
					ref={svgRef}
					className={`sc-svg${mode.kind === "playing" ? "" : " sc-still"}${
						mode.kind === "step" ? " sc-stepping" : ""
					}`}
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
				>
					<title id={titleId}>{title ?? result.title}</title>
					<desc id={descriptionId}>{description ?? result.description}</desc>
					<DiagramBody key={playback} body={body} />
				</svg>
			</div>
			{overflowing && (
				<p className="ch-diagram__scroll-hint" id={scrollHintId}>
					Scroll sideways to see the full diagram. Use the left and right arrow keys when focused.
				</p>
			)}
			{selected && (
				<aside className="ch-diagram__inspector" aria-label="Diagram details">
					<div className="ch-diagram__inspector-head">
						<div>
							<p>{selected.kind === "node" ? "Node" : "Connection"}</p>
							<h3>
								{selectedNode?.label ?? (selectedEdge
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
					{related.length > 0 && (
						<ul>
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
			{status && <figcaption className="ch-diagram__status" role="status">{status}</figcaption>}
		</figure>
	);
}

export function Diagram({ spec, ...props }: DiagramProps) {
	let result = useMemo(() => renderDiagram(spec), [spec]);
	if (!result.ok) {
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
			key={fingerprint}
			result={result}
			title={props.title}
			description={props.description}
			idPrefix={props.idPrefix}
		/>
	);
}
