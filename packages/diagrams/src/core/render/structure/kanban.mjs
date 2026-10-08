// Kanban: columns of cards. Column headers show count / WIP limit; a column
// over its WIP limit is flagged. Motion: columns, then cards top-down.
import { el, text } from "../../svg.mjs";
import { ceil4, textWidth, wrap } from "../../text.mjs";
import { group } from "./common.mjs";

export const family = "structure";

const CARD = { size: 11, weight: 500 };

export function render(spec) {
	const problems = [];
	const explicitIds = new Set(
		spec.columns.flatMap((c) =>
			(c.cards || []).filter((card) => typeof card === "object" && card.id).map((card) => card.id)
		),
	);
	const cardIds = new Set();
	const cols = spec.columns.map((c, i) => ({
		...c,
		id: c.id || `col${i}`,
		cards: (c.cards || []).map((k, j) => {
			const explicit = typeof k === "object" && !!k.id;
			const base = explicit ? k.id : `c${i}_${j}`;
			let id = base;
			let suffix = 2;
			if (explicit && cardIds.has(id)) {
				problems.push({
					code: "E_DUP_ID",
					at: `columns[${i}].cards[${j}].id`,
					msg: `duplicate card id "${id}"`,
					fix: "use a unique card id",
				});
			}
			if (!explicit) {
				while (cardIds.has(id) || explicitIds.has(id)) id = `${base}-${suffix++}`;
			}
			cardIds.add(id);
			return typeof k === "string" ? { label: k, id } : { ...k, id };
		}),
	}));
	if (problems.length) return { problems };
	const maxCards = Math.max(...cols.map((c) => c.cards.length));
	if (maxCards > 6) {
		problems.push({
			code: "W_BUDGET",
			at: "columns",
			msg: `${maxCards} cards in one column`,
			fix: 'show ≤ 6 cards per column; add "+N more" as the last card',
		});
	}
	const longest = Math.max(0, ...cols.flatMap((c) => c.cards.map((k) => textWidth(k.label, CARD))));
	const W = ceil4(Math.max(168, Math.min(220, longest * 0.6 + 32)));
	const gap = 16;
	const out = [];
	const nodes = [];
	let maxH = 0;
	cols.forEach((c, i) => {
		const x = i * (W + gap);
		let y = 40;
		const cards = c.cards.map((k, j) => {
			const lines = wrap(k.label, W - 28, CARD).slice(0, 3);
			const h = 18 + lines.length * 15 + (k.sub || k.tag ? 14 : 0);
			const st = Math.min(12, 2 + j);
			const parts = [
				el("rect", { class: "n-mask", x: x + 8, y, width: W - 16, height: h, rx: 5 }),
				el("rect", { class: "n-box", x: x + 8, y, width: W - 16, height: h, rx: 5 }),
				...lines.map((l, li) => text({ class: "kb-card", x: x + 20, y: y + 21 + li * 15 }, l)),
			];
			if (k.tag) parts.push(text({ class: "n-tag", x: x + 20, y: y + h - 9 }, k.tag));
			if (k.sub) {
				parts.push(
					text({ class: "n-sub", x: x + W - 20, y: y + h - 9, "text-anchor": "end" }, k.sub),
				);
			}
			nodes.push({ id: k.id, label: k.label });
			const g = group(
				`sc-node ${k.focal ? "k-focal" : k.kind ? `k-${k.kind}` : "k-backend"}`,
				k.id,
				st,
				parts,
				{ "aria-label": `${c.label}: ${k.label}` },
			);
			y += h + 8;
			return g;
		});
		const over = c.wip && c.cards.length > c.wip;
		if (over) {
			problems.push({
				code: "I_WIP",
				at: `columns.${c.id}`,
				msg: `${c.label} is over its WIP limit`,
				fix: "intended? the column is flagged in accent",
			});
		}
		maxH = Math.max(maxH, y);
		out.push(el("g", { class: "sc-enter", "data-sc-step": 1, style: "--step:1" }, [
			el("rect", {
				class: `kb-col${over ? " is-over" : ""}`,
				x,
				y: 0,
				width: W,
				height: 0,
				"data-h": 1,
			}),
			text({ class: "kb-head", x: x + 10, y: 22 }, c.label.toUpperCase()),
			text({
				class: `kb-count${over ? " is-over" : ""}`,
				x: x + W - 10,
				y: 22,
				"text-anchor": "end",
			}, c.wip ? `${c.cards.length}/${c.wip}` : String(c.cards.length)),
		]));
		out.push(...cards);
	});
	const H = maxH + 4;
	const body = out.join("").replace(/height="0" data-h="1"/g, `height="${H}"`);
	return {
		body,
		viewBox: [-24, -24, cols.length * (W + gap) - gap + 48, H + 48],
		steps: Math.min(12, 1 + maxCards),
		problems,
		graph: { nodes, edges: [] },
	};
}
