// Access / security matrix: rows (roles) × columns (data domains); each cell
// is a level glyph. Motion: rows sweep in.
import { el, text } from "../../svg.mjs";
import { textWidth } from "../../text.mjs";
import { group } from "./common.mjs";

export const family = "structure";

const LEVELS = {
	none: "No access",
	read: "Read",
	masked: "Masked / aggregated",
	write: "Write",
	admin: "Admin",
};

function glyph(level, cx, cy) {
	switch (level) {
		case "read":
			return el("path", { class: "mx-g fill", d: `M${cx},${cy - 6} A6,6 0 0 0 ${cx},${cy + 6} Z` })
				+ el("circle", { class: "mx-g ring", cx, cy, r: 6 });
		case "write":
			return el("circle", { class: "mx-g fill", cx, cy, r: 6 });
		case "admin":
			return el("circle", { class: "mx-g admin", cx, cy, r: 6 });
		case "masked":
			return el("circle", { class: "mx-g ring dashed", cx, cy, r: 6 });
		default:
			return el("circle", { class: "mx-g none", cx, cy, r: 1.6 });
	}
}

export function render(spec) {
	const problems = [];
	const rows = spec.rows, cols = spec.cols;
	if (spec.cells.length !== rows.length || spec.cells.some((r) => r.length !== cols.length)) {
		return {
			problems: [{
				code: "E_SPEC",
				at: "cells",
				msg: `cells must be ${rows.length} rows × ${cols.length} cols`,
				fix: "one level per row/col pair",
			}],
		};
	}
	const bad = spec.cells.flat().find((v) => !(v in LEVELS));
	if (bad) {
		return {
			problems: [{
				code: "E_SPEC",
				at: "cells",
				msg: `unknown level "${bad}"`,
				fix: `use ${Object.keys(LEVELS).join(", ")}`,
			}],
		};
	}
	const rowW = Math.max(...rows.map((r) => textWidth(r, { size: 11, weight: 500 }))) + 24;
	const colW = Math.max(
		72,
		...cols.map((c) => textWidth(c, { size: 8, mono: true, tracking: 0.08, upper: true }) + 20),
	);
	const RH = 34;
	const out = [];
	const nodes = [];
	cols.forEach((c, j) =>
		out.push(
			text(
				{ class: "mx-col", x: rowW + j * colW + colW / 2, y: -12, "text-anchor": "middle" },
				c.toUpperCase(),
			),
		)
	);
	rows.forEach((r, i) => {
		const y = i * RH;
		const st = Math.min(12, i + 1);
		const parts = [
			i % 2
				? ""
				: el("rect", { class: "mx-band", x: 0, y, width: rowW + cols.length * colW, height: RH }),
			text({ class: "mx-row", x: 8, y: y + RH / 2 + 4 }, r),
		];
		spec.cells[i].forEach((lv, j) => {
			parts.push(
				el("g", { "data-sc-tip": `${r} · ${cols[j]}: ${LEVELS[lv]}` }, [
					el("rect", { x: rowW + j * colW, y, width: colW, height: RH, fill: "transparent" }),
					glyph(lv, rowW + j * colW + colW / 2, y + RH / 2),
				]),
			);
		});
		const id = `r${i}`;
		nodes.push({ id, label: r });
		out.push(
			group(`sc-node mx-r${spec.focal === r ? " k-focal" : ""}`, id, st, parts, {
				"aria-label": r,
			}),
		);
	});
	const used = new Set(spec.cells.flat());
	let lx = 0;
	const ly = rows.length * RH + 28;
	const legendParts = Object.keys(LEVELS).filter((k) => used.has(k)).map((k) => {
		const g = glyph(k, lx + 6, ly) + text({ class: "lg-text", x: lx + 18, y: ly + 3.5 }, LEVELS[k]);
		lx += textWidth(LEVELS[k], { size: 9 }) + 40;
		return g;
	});
	out.push(el("g", { class: "sc-legend" }, legendParts));
	return {
		body: out.join(""),
		viewBox: [-24, -40, Math.max(rowW + cols.length * colW, lx) + 48, rows.length * RH + 100],
		steps: Math.min(12, rows.length),
		problems,
		graph: { nodes, edges: [] },
	};
}
