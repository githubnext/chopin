// Nested: hierarchy as containment. Children sit in a row (or grid) inside
// their parent; reveal goes outside → in.
import { el, text } from "../../svg.mjs";
import { ceil4, textWidth } from "../../text.mjs";
import { bounds, group, LABEL } from "./common.mjs";
import { compressSteps } from "../../motion.mjs";

export const family = "structure";

const PAD = 16;
const HEAD = 26;
const GAP = 14;

export function render(spec) {
	const problems = [];
	const all = [];
	let auto = 0;
	function build(n, depth) {
		const o = { ...(typeof n === "string" ? { label: n } : n), depth };
		o.id = o.id || `n${auto++}`;
		all.push(o);
		o.kids = (o.children || []).map((c) => build(c, depth + 1));
		return o;
	}
	const root = build(spec.root, 0);
	if (all.length > 24) {
		problems.push({
			code: "W_BUDGET",
			at: "root",
			msg: `${all.length} boxes`,
			fix: "keep ≤ 24 boxes; drop the deepest level",
		});
	}
	if (Math.max(...all.map((n) => n.depth)) > 3) {
		problems.push({
			code: "W_DEPTH",
			at: "root",
			msg: "more than 4 levels",
			fix: "nest at most 4 levels deep",
		});
	}

	function measure(n) {
		const lw = textWidth(
			n.label,
			n.kids.length ? { size: 8, mono: true, tracking: 0.14, upper: true } : LABEL,
		) + 28;
		if (!n.kids.length) {
			n.w = ceil4(Math.max(104, lw));
			n.h = n.sub ? 52 : 40;
			return;
		}
		n.kids.forEach(measure);
		const cols = n.cols
			|| (n.kids.length <= 4 ? n.kids.length : Math.ceil(Math.sqrt(n.kids.length)));
		n.grid = [];
		for (let i = 0; i < n.kids.length; i += cols) n.grid.push(n.kids.slice(i, i + cols));
		const rowW = n.grid.map((r) => r.reduce((s, k) => s + k.w, 0) + GAP * (r.length - 1));
		const rowH = n.grid.map((r) => Math.max(...r.map((k) => k.h)));
		n.rowH = rowH;
		n.w = ceil4(Math.max(lw, Math.max(...rowW) + PAD * 2));
		n.h = ceil4(HEAD + rowH.reduce((s, h) => s + h, 0) + GAP * (rowH.length - 1) + PAD);
	}
	function place(n, x, y) {
		n.x = x;
		n.y = y;
		if (!n.kids.length) return;
		let cy = y + HEAD;
		n.grid.forEach((r, ri) => {
			const rw = r.reduce((s, k) => s + k.w, 0) + GAP * (r.length - 1);
			const extra = (n.w - PAD * 2 - rw) / r.length;
			let cx = x + PAD;
			for (const k of r) {
				k.w += extra; // children stretch to fill the row
				place(k, cx, cy);
				cx += k.w + GAP;
			}
			cy += n.rowH[ri] + GAP;
		});
	}
	measure(root);
	place(root, 0, 0);
	const steps = compressSteps(all.map((n) => n.depth));
	const out = all.map((n, i) => {
		const leaf = !n.kids.length;
		const cls = `sc-node nest ${
			n.focal ? "k-focal" : leaf ? "k-backend" : `nest-d${Math.min(n.depth, 3)}`
		}`;
		const parts = [
			el("rect", {
				class: leaf ? "n-mask" : "nest-mask",
				x: n.x,
				y: n.y,
				width: n.w,
				height: n.h,
				rx: leaf ? 6 : 8,
			}),
			el("rect", {
				class: leaf ? "n-box" : "nest-box",
				x: n.x,
				y: n.y,
				width: n.w,
				height: n.h,
				rx: leaf ? 6 : 8,
			}),
		];
		if (leaf) {
			parts.push(
				text({
					class: "n-label",
					x: n.x + n.w / 2,
					y: n.y + (n.sub ? 22 : 24.5),
					"text-anchor": "middle",
				}, n.label),
			);
			if (n.sub) {
				parts.push(
					text({ class: "n-sub", x: n.x + n.w / 2, y: n.y + 37, "text-anchor": "middle" }, n.sub),
				);
			}
		} else {
			parts.push(text({ class: "nest-label", x: n.x + 12, y: n.y + 17 }, n.label));
			if (n.sub) {
				parts.push(
					text({ class: "n-sub", x: n.x + n.w - 12, y: n.y + 17, "text-anchor": "end" }, n.sub),
				);
			}
		}
		return group(cls, n.id, steps[i], parts, { "aria-label": n.label });
	});
	return {
		body: el("g", { class: "sc-nodes" }, out),
		viewBox: bounds([{ x: 0, y: 0, w: root.w, h: root.h }], 28),
		steps: Math.max(...steps),
		problems,
		graph: { nodes: all.map((n) => ({ id: n.id, label: n.label })), edges: [] },
	};
}
