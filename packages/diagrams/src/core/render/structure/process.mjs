// Process: a numbered linear sequence of steps drawn as chevrons.
import { el, text } from "../../svg.mjs";
import { ceil4, textWidth } from "../../text.mjs";
import { bounds, group, item, LABEL, labelBlock, stepOf } from "./common.mjs";

export const family = "structure";

export function render(spec) {
	const problems = [];
	const steps = spec.steps.map((s, i) => item(s, i, "s"));
	if (steps.length > 7) {
		problems.push({
			code: "W_BUDGET",
			at: "steps",
			msg: `${steps.length} steps`,
			fix: "keep ≤ 7 steps; group the rest into phases",
		});
	}
	const w = ceil4(
		Math.max(132, Math.min(176, Math.max(...steps.map((s) => textWidth(s.label, LABEL))) + 44)),
	);
	const h = 72;
	const notch = 16;
	const gap = 6;
	const out = [];
	const rects = [];
	steps.forEach((s, i) => {
		const x = i * (w + gap);
		const first = i === 0;
		const d = `M${x},0 L${x + w - notch},0 L${x + w},${h / 2} L${x + w - notch},${h} L${x},${h} ${
			first ? "" : `L${x + notch},${h / 2}`
		} Z`;
		const kind = s.focal ? "k-focal" : "k-backend";
		const st = stepOf(i, steps.length);
		out.push(group(`sc-node ${kind}`, s.id, st, [
			el("path", { class: "n-mask", d }),
			el("path", { class: "n-box", d }),
			spec.numbered === false
				? ""
				: text(
					{ class: "n-tag", x: x + (first ? 14 : notch + 12), y: -10 },
					String(i + 1).padStart(2, "0"),
				),
			labelBlock(x + w / 2 + (first ? -4 : notch / 2 - 4), h / 2, s.label, s.sub, {
				maxW: w - notch * 2 - 12,
			}),
		], { "aria-label": `${i + 1}. ${s.label}` }));
		rects.push({ x, y: -24, w, h: h + 24 });
	});
	if (spec.caption) rects.push({ x: 0, y: h + 10, w: 1, h: 1 });
	return {
		body: out.join(""),
		viewBox: bounds(rects, 28),
		steps: stepOf(steps.length - 1, steps.length),
		problems,
		graph: {
			nodes: steps.map((s) => ({ id: s.id, label: s.label })),
			edges: steps.slice(1).map((s, i) => ({ id: `e${i}`, from: steps[i].id, to: s.id })),
		},
	};
}
