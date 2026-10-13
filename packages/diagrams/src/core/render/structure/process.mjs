// Process: a numbered linear sequence of steps drawn as chevrons.
import { el, text } from "../../svg.mjs";
import { ceil4, textWidth, wrap } from "../../text.mjs";
import { DIAGRAM_TYPE, LABEL_BOX } from "../../tokens.mjs";
import { bounds, group, item, itemIdProblems, stepOf } from "./common.mjs";

const LABEL = DIAGRAM_TYPE.label;
const SUB = DIAGRAM_TYPE.sub;

function lines(value, width, role) {
	return wrap(value, width, role).flatMap(line => {
		let parts = [];
		let part = "";
		for (let character of line) {
			if (part && textWidth(part + character, role) > width) {
				parts.push(part);
				part = "";
			}
			part += character;
		}
		return [...parts, part];
	});
}

export const family = "structure";

export function render(spec) {
	const problems = [];
	const steps = spec.steps.map((s, i) => item(s, i, "s"));
	const identityProblems = itemIdProblems(steps, "steps");
	if (identityProblems.length) return { problems: identityProblems };
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
	const notch = 16;
	const gap = 6;
	let innerWidth = w - notch * 2 - LABEL_BOX.paddingInline * 2;
	let labels = steps.map(s => {
		let label = lines(s.label, innerWidth, LABEL);
		let sub = s.sub ? lines(s.sub, innerWidth, SUB) : [];
		let height = label.length * LABEL.lineHeight
			+ (sub.length ? LABEL_BOX.detailGap + sub.length * SUB.lineHeight : 0);
		return { label, sub, height };
	});
	let h = ceil4(Math.max(72, ...labels.map(label => label.height + LABEL_BOX.paddingBlock * 2)));
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
		let label = labels[i];
		let y = (h - label.height) / 2;
		let content = [];
		for (let line of label.label) {
			content.push(
				text({ class: "n-label", x: x + w / 2, y: y + LABEL.size, "text-anchor": "middle" }, line),
			);
			y += LABEL.lineHeight;
		}
		y += LABEL_BOX.detailGap;
		for (let line of label.sub) {
			content.push(
				text({ class: "n-sub", x: x + w / 2, y: y + SUB.size, "text-anchor": "middle" }, line),
			);
			y += SUB.lineHeight;
		}
		out.push(group(`sc-node ${kind}`, s.id, st, [
			el("path", { class: "n-mask", d }),
			el("path", { class: "n-box", d }),
			spec.numbered === false
				? ""
				: text(
					{ class: "n-tag", x: x + (first ? 14 : notch + 12), y: -10 },
					String(i + 1).padStart(2, "0"),
				),
			...content,
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
