import type { DiagramSpec } from "./render";

/** Presentation bounds never alter the authored specification. */
export const DIAGRAM_VIEWPORT = Object.freeze({
	preferredWidth: 1100,
	minimumZoom: 0.85,
	maximumZoom: 2,
	zoomStep: 0.15,
});

export function fitDiagram(width: number, available: number): number {
	return Math.max(DIAGRAM_VIEWPORT.minimumZoom, Math.min(1, available / width));
}

/** Preserve lanes and stages; their axes carry meaning beyond graph connectivity. */
export function compactGraphSpecs(spec: DiagramSpec): DiagramSpec[] {
	if (
		!Array.isArray(spec.nodes) || spec.lanes || spec.stages || spec.type === "swimlane"
		|| spec.dir === "TB" || spec.type === "flowchart" || spec.variant === "vertical"
	) return [];
	let nodes = spec.nodes as Array<Record<string, unknown>>;
	let candidates: DiagramSpec[] = [{
		...spec,
		dir: "TB",
		nodes: nodes.map(({ row, col, ...node }) => ({
			...node,
			...(col === undefined ? {} : { row: col }),
			...(row === undefined ? {} : { col: row }),
		})),
	}];
	if (!spec.groups && !nodes.some(node => node.group)) {
		candidates.push({
			...spec,
			dir: "TB",
			nodes: nodes.map(({ row: _row, col: _col, ...node }) => node),
		});
	}
	return candidates;
}
