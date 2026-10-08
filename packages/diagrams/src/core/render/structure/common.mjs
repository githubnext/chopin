// Small helpers shared by structure renderers.
import { el, text } from "../../svg.mjs";
import { textWidth, wrap } from "../../text.mjs";

export const LABEL = { size: 12, weight: 600 };
export const SUB = { size: 9, mono: true };

export function item(v, i, prefix = "i") {
	const o = typeof v === "string" ? { label: v } : { ...v };
	o.id = o.id || `${prefix}${i}`;
	return o;
}

export function itemIdProblems(items, field) {
	const seen = new Set();
	const problems = [];
	items.forEach((entry, index) => {
		if (seen.has(entry.id)) {
			problems.push({
				code: "E_DUP_ID",
				at: `${field}[${index}].id`,
				msg: `duplicate id "${entry.id}"`,
				fix: "use a unique item id",
			});
		}
		seen.add(entry.id);
	});
	return problems;
}

// Centered multi-line label block (label lines + optional sub) at cx, cy.
export function labelBlock(
	cx,
	cy,
	label,
	sub,
	{ maxW = 160, cls = "n-label", subCls = "n-sub", anchor = "middle" } = {},
) {
	const lines = textWidth(label, LABEL) > maxW ? wrap(label, maxW, LABEL).slice(0, 3) : [label];
	const h = lines.length * 15 + (sub ? 13 : 0) - 3;
	let y = cy - h / 2 + 10;
	const out = lines.map((l) => {
		const t = text({ class: cls, x: cx, y, "text-anchor": anchor }, l);
		y += 15;
		return t;
	});
	if (sub) out.push(text({ class: subCls, x: cx, y: y - 1, "text-anchor": anchor }, sub));
	return out.join("");
}

export function group(cls, id, step, parts, extra = {}) {
	return el("g", {
		class: cls,
		"data-sc-node": id,
		"data-sc-step": step,
		style: step !== undefined ? `--step:${step}` : undefined,
		tabindex: id ? 0 : undefined,
		role: id ? "group" : undefined,
		...extra,
	}, parts);
}

export function bounds(rects, pad = 32) {
	const x0 = Math.min(...rects.map((r) => r.x)) - pad;
	const y0 = Math.min(...rects.map((r) => r.y)) - pad;
	const x1 = Math.max(...rects.map((r) => r.x + (r.w || 0))) + pad;
	const y1 = Math.max(...rects.map((r) => r.y + (r.h || 0))) + pad;
	return [x0, y0, x1 - x0, y1 - y0];
}

export const stepOf = (i, n) => Math.min(12, 1 + Math.floor((i * 12) / Math.max(12, n)));
