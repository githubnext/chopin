import { el, text } from "../../svg.mjs";
import { textWidth } from "../../text.mjs";

const NODE_NAMES = {
	focal: "Focal",
	backend: "Service",
	store: "Store",
	external: "External",
	input: "Input",
	optional: "Optional",
	security: "Security",
	muted: "Context",
};
const EDGE_NAMES = {
	default: "Call / flow",
	primary: "Primary path",
	link: "HTTP / API",
	async: "Async",
	return: "Return",
	muted: "Secondary",
};

// Returns { svg, h } for a legend strip starting at (x, y) spanning width w.
// A `size` other than the default 9 is a fitted chart's: no title, taller rows.
export function legend(
	{ nodeKinds = [], edgeKinds = [], x, y, w, extra = [], size = 9, minimum = 2 },
) {
	const items = [];
	for (const k of nodeKinds) items.push({ type: "node", k, label: NODE_NAMES[k] || k });
	for (const k of edgeKinds) items.push({ type: "edge", k, label: EDGE_NAMES[k] || k });
	items.push(...extra);
	if (items.length < minimum) return { svg: "", h: 0 };
	const fitted = size !== 9;
	const parts = [el("line", { class: "lg-rule", x1: x, y1: y, x2: x + w, y2: y })];
	if (!fitted) parts.push(text({ class: "lg-title", x, y: y + 16 }, "LEGEND"));
	let cx = x;
	let cy = y + (fitted ? 24 : 34);
	for (const it of items) {
		const tw = textWidth(it.label, { size }) + (it.type === "text" ? 24 : fitted ? 32 : 44);
		if (cx + tw > x + w && cx > x) {
			cx = x;
			cy += fitted ? size + 10 : 18;
		}
		const hit = it.type === "node"
			? { "data-sc-kind": it.k }
			: it.type === "edge"
			? { "data-sc-ekind": it.k }
			: {};
		const start = parts.length;
		if (it.type === "node") {
			parts.push(
				el(
					"g",
					{ class: `k-${it.k}` },
					el("rect", { class: "n-box", x: cx, y: cy - 8, width: 14, height: 10, rx: 2 }),
				),
			);
		} else if (it.type === "edge") {
			const dashed = it.k === "async" || it.k === "return";
			parts.push(el("g", { class: `ek-${it.k}` }, [
				el("path", {
					class: `e-line${dashed ? " dashed" : ""}`,
					d: `M${cx},${cy - 3} L${cx + 20},${cy - 3}`,
				}),
				el("path", {
					class: `e-head m-${dashed ? "default" : it.k}`,
					d: `M${cx + 26},${cy - 3} L${cx + 19},${cy - 6} L${cx + 19},${cy} Z`,
				}),
			]));
		} else if (it.swatch) {
			parts.push(el("rect", { class: it.swatch, x: cx, y: cy - 8, width: 14, height: 10, rx: 2 }));
		}
		parts.push(
			text({
				class: "lg-text",
				x: cx + (it.type === "edge" ? 32 : it.type === "text" ? 0 : 20),
				y: cy,
			}, it.label),
		);
		if (hit["data-sc-kind"] || hit["data-sc-ekind"]) {
			parts.splice(
				start,
				parts.length - start,
				el("g", hit, [
					el("rect", { x: cx - 2, y: cy - 11, width: tw - 6, height: 15, fill: "transparent" }),
					...parts.slice(start),
				]),
			);
		}
		cx += tw;
	}
	return { svg: el("g", { class: "sc-legend" }, parts), h: cy - y + 10 };
}
