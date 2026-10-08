import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from "react";

import { type DiagramResult, renderDiagram } from "./render";
import { namespaceSvgIds } from "./viewer/namespace";

export type DiagramProps = {
	spec: unknown;
	title?: string;
	description?: string;
	/** Supply a distinct prefix when rendering diagrams in separate React roots. */
	idPrefix?: string;
};

type ReadyDiagram = Extract<DiagramResult, { ok: true }>;
type Item = { kind: "node" | "edge"; id: string };

const DiagramBody = memo(function DiagramBody({ body }: { body: string }) {
	return <g dangerouslySetInnerHTML={{ __html: body }} />;
});

function itemAt(svg: SVGSVGElement | null, target: EventTarget | null): Item | null {
	if (!(target instanceof Element) || !svg?.contains(target)) return null;
	let element = target.closest<SVGElement>("[data-sc-node], [data-sc-edge]");
	if (!element || !svg.contains(element)) return null;
	let id = element.getAttribute("data-sc-node");
	if (id !== null) return { kind: "node", id };
	id = element.getAttribute("data-sc-edge");
	return id === null ? null : { kind: "edge", id };
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
	let prefix = `chd-${idPrefix?.replace(/[^a-zA-Z0-9_-]/g, "") || "view"}-${id}`;
	let titleId = `${prefix}-title`;
	let descriptionId = `${prefix}-description`;
	let svgRef = useRef<SVGSVGElement>(null);
	let [preview, setPreview] = useState<Item | null>(null);
	let [selected, setSelected] = useState<Item | null>(null);
	let [step, setStep] = useState<number | null>(null);
	let [live, setLive] = useState(true);
	let [playback, setPlayback] = useState(0);
	let [reduced, setReduced] = useState(false);
	let graph = result.graph;
	let nodes = graph?.nodes ?? [];
	let edges = graph?.edges ?? [];
	let interactive = nodes.length > 0;
	let motion = result.motion && result.motion !== "none" ? result.motion : null;
	let maxStep = motion ? Math.max(0, result.steps ?? 0) : 0;
	let body = useMemo(() => namespaceSvgIds(result.body, prefix), [result.body, prefix]);
	let active = preview ?? selected;

	useEffect(() => {
		let svg = svgRef.current;
		if (!svg) return;
		svg.classList.toggle("sc-still", !live || step !== null);
		svg.classList.toggle("sc-stepping", step !== null);
	}, [live, step]);

	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		let query = window.matchMedia("(prefers-reduced-motion: reduce)");
		let update = () => setReduced(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	useEffect(() => {
		let svg = svgRef.current;
		if (!svg) return;
		for (let element of svg.querySelectorAll<SVGElement>("[data-sc-node]")) {
			let nodeId = element.getAttribute("data-sc-node");
			let node = nodes.find((entry) => entry.id === nodeId);
			element.setAttribute("tabindex", "0");
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
			element.setAttribute("tabindex", "0");
			element.setAttribute("role", "button");
			element.setAttribute("aria-label", `${from} to ${to}`);
		}
	}, [body, playback, edges, nodes]);

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
			element.classList.toggle("is-shown", step !== null && elementStep <= step);
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
		let current = itemAt(svgRef.current, target);
		let next = itemAt(svgRef.current, related);
		if (current && !sameItem(current, next)) setPreview(null);
	};
	let onPointerOver = (event: PointerEvent<SVGSVGElement>) => {
		if (event.pointerType !== "touch") enter(itemAt(svgRef.current, event.target));
	};
	let onPointerOut = (event: PointerEvent<SVGSVGElement>) =>
		leave(event.target, event.relatedTarget);
	let onFocus = (event: FocusEvent<SVGSVGElement>) => enter(itemAt(svgRef.current, event.target));
	let onBlur = (event: FocusEvent<SVGSVGElement>) => leave(event.target, event.relatedTarget);
	let onClick = (event: MouseEvent<SVGSVGElement>) => {
		let item = itemAt(svgRef.current, event.target);
		if (item) select(item);
	};
	let onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		let item = itemAt(svgRef.current, event.target);
		if (!item) return;
		event.preventDefault();
		select(item);
	};
	let showStep = (next: number) => {
		setLive(false);
		setStep(Math.max(0, Math.min(maxStep, next)));
	};
	let reset = () => {
		setPreview(null);
		setSelected(null);
		setStep(null);
		setLive(false);
	};
	let replay = () => {
		setPreview(null);
		setStep(null);
		setLive(true);
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
			<div className="ch-diagram__stage">
				<svg
					ref={svgRef}
					className="sc-svg"
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
