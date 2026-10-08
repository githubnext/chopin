// User story map: activities (backbone) → steps → stories sliced by release.
import { el, text } from "../../svg.mjs";
import { wrap } from "../../text.mjs";
import { group } from "./common.mjs";

export const family = "structure";

const W = 148;
const GAP = 10;
const CARD = { size: 10.5, weight: 500 };

function card(cls, id, step, x, y, label, h, extra = {}) {
	const lines = wrap(label, W - 20, CARD).slice(0, 3);
	return group(`sc-node ${cls}`, id, step, [
		el("rect", { class: "n-mask", x, y, width: W, height: h, rx: 4 }),
		el("rect", { class: "n-box", x, y, width: W, height: h, rx: 4 }),
		...lines.map((l, i) => text({ class: "kb-card", x: x + 10, y: y + 17 + i * 13.5 }, l)),
	], { "aria-label": label, ...extra });
}

export function render(spec) {
	const problems = [];
	const releases = spec.releases || ["Release 1"];
	const steps = [];
	const out = [];
	const nodes = [];
	spec.activities.forEach((a, ai) => {
		(a.steps || []).forEach((s, si) =>
			steps.push({
				...(typeof s === "string" ? { label: s } : s),
				activity: ai,
				id: `s${ai}_${si}`,
			})
		);
	});
	if (steps.length > 10) {
		problems.push({
			code: "W_BUDGET",
			at: "activities",
			msg: `${steps.length} steps`,
			fix: "keep ≤ 10 steps across the backbone",
		});
	}
	const colX = (i) => 120 + i * (W + GAP);
	// backbone: activities span their steps
	let col = 0;
	spec.activities.forEach((a, ai) => {
		const n = Math.max(1, (a.steps || []).length);
		const x = colX(col), w = n * (W + GAP) - GAP;
		out.push(group(`sc-node sm-activity ${a.focal ? "k-focal" : ""}`, `a${ai}`, 1, [
			el("rect", { class: "sm-act", x, y: 0, width: w, height: 40, rx: 4 }),
			text({ class: "sm-act-text", x: x + 10, y: 25 }, a.label),
		], { "aria-label": a.label }));
		nodes.push({ id: `a${ai}`, label: a.label });
		col += n;
	});
	steps.forEach((s, i) => {
		out.push(card(s.focal ? "k-focal" : "k-backend", s.id, 2, colX(i), 52, s.label, 44));
		nodes.push({ id: s.id, label: s.label });
	});
	// release slices
	let y = 116;
	releases.forEach((r, ri) => {
		const heights = steps.map((s) => {
			const stories = (s.stories && s.stories[r]) || [];
			return stories.length * 52;
		});
		const h = Math.max(52, ...heights) + 8;
		const st = Math.min(12, 3 + ri * 2);
		out.push(el("g", { class: "sc-fade", "data-sc-step": st, style: `--step:${st}` }, [
			el("line", {
				class: "lane-rule",
				x1: 0,
				y1: y - 6,
				x2: colX(steps.length) - GAP,
				y2: y - 6,
				"stroke-dasharray": "4 3",
			}),
			text({ class: "lane-label", x: 0, y: y + 14 }, r.toUpperCase()),
		]));
		steps.forEach((s, i) => {
			((s.stories && s.stories[r]) || []).forEach((story, k) => {
				const o = typeof story === "string" ? { label: story } : story;
				const id = `${s.id}_${ri}_${k}`;
				out.push(
					card(o.focal ? "k-focal" : "k-muted", id, st + 1, colX(i), y + k * 52, o.label, 44),
				);
				nodes.push({ id, label: o.label });
			});
		});
		y += h + 12;
	});
	return {
		body: out.join(""),
		viewBox: [-24, -24, colX(steps.length) - GAP + 48, y + 24],
		steps: Math.min(12, 3 + releases.length * 2),
		problems,
		graph: { nodes, edges: [] },
	};
}
