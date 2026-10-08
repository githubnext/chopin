// Sequence diagram: participants across, time down. Message rows are
// laid out by the renderer; Claude only lists participants and messages.
import { el, roundedPath, text } from "../../svg.mjs";
import { ceil4, textWidth } from "../../text.mjs";
import { drawNode, normalizeKind, sizeNode } from "../shared/nodes.mjs";

export const family = "lanes";

const LBL = { size: 9, mono: true };
const ROW = 40;
const SELF_ROW = 56;
const KIND = {
	sync: "default",
	reply: "return",
	async: "link",
	self: "default",
	primary: "primary",
};

function headPath(tip, dir) {
	return `M${tip.x},${tip.y} L${tip.x - dir * 8},${tip.y - 3.2} L${tip.x - dir * 8},${
		tip.y + 3.2
	} Z`;
}

export function render(spec) {
	const problems = [];
	const parts = spec.participants.map((p) => ({ ...p, kind: normalizeKind(p) }));
	const index = new Map(parts.map((p, i) => [p.id, i]));
	if (index.size !== parts.length) {
		problems.push({
			code: "E_DUP_ID",
			at: "participants",
			msg: "duplicate participant id",
			fix: "ids must be unique",
		});
	}
	const msgs = spec.messages.map((m, i) => {
		const o = Array.isArray(m) ? { from: m[0], to: m[1], label: m[2], kind: m[3] } : { ...m };
		for (const end of ["from", "to"]) {
			if (!index.has(o[end])) {
				problems.push({
					code: "E_MSG_PARTICIPANT",
					at: `messages[${i}]`,
					msg: `unknown participant "${o[end]}"`,
					fix: `use one of: ${[...index.keys()].join(", ")}`,
				});
			}
		}
		o.kind = o.from === o.to ? "self" : o.kind || "sync";
		if (o.focal) o.kind = "primary";
		o.i = i;
		return o;
	});
	if (problems.length) return { problems };
	if (msgs.length > 16) {
		problems.push({
			code: "W_BUDGET",
			at: "messages",
			msg: `${msgs.length} messages`,
			fix: "keep sequences ≤ 16 messages; split by phase",
		});
	}

	// Participant x positions.
	parts.forEach((p) => sizeNode(p, { minW: 104, maxW: 180 }));
	const xs = [];
	parts.forEach((p, i) => {
		xs.push(i === 0 ? p.w / 2 : xs[i - 1] + Math.max(132, (parts[i - 1].w + p.w) / 2 + 36));
	});
	for (let pass = 0; pass < 3; pass++) {
		for (const m of msgs) {
			const a = index.get(m.from), b = index.get(m.to);
			const lw = m.label ? textWidth(m.label, LBL) + 32 : 0;
			if (a === b) {
				if (a + 1 < xs.length) {
					const need = lw + 44 - (xs[a + 1] - xs[a]);
					if (need > 0) { for (let k = a + 1; k < xs.length; k++) xs[k] += need; }
				}
				continue;
			}
			const lo = Math.min(a, b), hi = Math.max(a, b);
			const need = lw - (xs[hi] - xs[lo]);
			if (need > 0) { for (let k = hi; k < xs.length; k++) xs[k] += Math.ceil(need); }
		}
	}
	const headH = Math.max(...parts.map((p) => p.h));
	parts.forEach((p, i) => {
		p.x = Math.round(xs[i] - p.w / 2);
		p.y = 0;
		p.cx = xs[i];
	});

	// Row y positions (fragments + notes add space).
	const frags = (spec.fragments || []).filter((f) => f.from <= f.to && f.to < msgs.length);
	const notes = spec.notes || [];
	let y = headH + 36;
	const rowY = [];
	msgs.forEach((m, i) => {
		const opens = frags.filter((f) => f.from === i).length;
		const elseHere = frags.some((f) => f.else === i);
		y += opens * 26 + (elseHere ? 20 : 0);
		for (const n of notes.filter((n) => n.at === i)) {
			n.y = y - 6;
			y += 34;
		}
		rowY.push(y);
		y += m.kind === "self" ? SELF_ROW : ROW;
		const closes = frags.filter((f) => f.to === i).length;
		y += closes * 10;
	});
	for (const n of notes.filter((n) => n.at >= msgs.length)) {
		n.y = y - 6;
		y += 34;
	}
	const bottom = y;

	const out = [];
	// lifelines
	out.push(
		el(
			"g",
			{ class: "sc-lifelines" },
			parts.map((p) => el("line", { class: "q-life", x1: p.cx, y1: headH, x2: p.cx, y2: bottom })),
		),
	);

	// fragments
	const fragSvg = frags.map((f) => {
		const involved = msgs.slice(f.from, f.to + 1).flatMap((
			m,
		) => [index.get(m.from), index.get(m.to)]);
		const lo = Math.min(...involved), hi = Math.max(...involved);
		const selfRight = msgs.slice(f.from, f.to + 1).some((m) =>
				m.kind === "self" && index.get(m.from) === hi
			)
			? 52
			: 0;
		const x0 = xs[lo] - 28, x1 = xs[hi] + 28 + selfRight;
		const y0 = rowY[f.from] - 30, y1 = rowY[f.to] + (msgs[f.to].kind === "self" ? 30 : 14);
		const tag = f.kind.toUpperCase();
		const tw = ceil4(textWidth(tag, { size: 8, mono: true, tracking: 0.1 }) + 12);
		const g = [
			el("rect", { class: "q-frag", x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 4 }),
			el("path", {
				class: "q-frag-tag",
				d: `M${x0},${y0 + 4} Q${x0},${y0} ${x0 + 4},${y0} L${x0 + tw},${y0} L${x0 + tw},${
					y0 + 10
				} L${x0 + tw - 6},${y0 + 16} L${x0},${y0 + 16} Z`,
			}),
			text({ class: "q-frag-text", x: x0 + 6, y: y0 + 11 }, tag),
		];
		if (f.label) {
			g.push(
				text({
					class: "q-frag-text",
					x: x0 + tw + 8,
					y: y0 + 11,
					style: "text-transform:none;letter-spacing:0",
				}, `[${f.label}]`),
			);
		}
		if (f.else !== undefined && f.else > f.from && f.else <= f.to) {
			const ey = rowY[f.else] - 26;
			g.push(
				el("line", { class: "q-frag", x1: x0, y1: ey, x2: x1, y2: ey, "stroke-dasharray": "4 3" }),
			);
			g.push(
				text({
					class: "q-frag-text",
					x: x0 + 8,
					y: ey + 11,
					style: "text-transform:none;letter-spacing:0",
				}, `[${f.elseLabel || "else"}]`),
			);
		}
		return el("g", {
			class: "sc-frag sc-fade",
			"data-sc-step": Math.min(12, f.from + 1),
			style: `--step:${Math.min(12, f.from + 1)}`,
		}, g);
	});
	out.push(el("g", { class: "sc-frags" }, fragSvg));

	// messages
	const stepOf = (i) => Math.min(12, 1 + Math.floor((i * 12) / Math.max(12, msgs.length)));
	const msgSvg = msgs.map((m, i) => {
		const a = index.get(m.from), b = index.get(m.to);
		const y0 = rowY[i];
		const kind = KIND[m.kind] || "default";
		const g = [];
		let lineD, head, lx, ly;
		if (a === b) {
			const x = xs[a];
			const pts = [{ x, y: y0 }, { x: x + 36, y: y0 }, { x: x + 36, y: y0 + 18 }, {
				x: x + 8,
				y: y0 + 18,
			}];
			lineD = roundedPath(pts, 5);
			head = headPath({ x: x + 1, y: y0 + 18 }, -1);
			lx = x + 44;
			ly = y0 + 12;
		} else {
			const dir = b > a ? 1 : -1;
			const x0 = xs[a], x1 = xs[b] - dir * 1;
			lineD = `M${x0},${y0} L${x1 - dir * 7},${y0}`;
			head = headPath({ x: x1, y: y0 }, dir);
			lx = (x0 + x1) / 2;
			ly = y0 - 7;
		}
		const dashed = m.kind === "reply";
		g.push(
			el("path", {
				class: `e-line${dashed ? "" : " sc-draw"}`,
				d: lineD,
				pathLength: dashed ? undefined : 1,
			}),
		);
		g.push(el("path", { class: `e-head m-${dashed ? "default" : kind}`, d: head }));
		if (m.label) {
			g.push(
				el(
					"g",
					{ class: "e-label-g" },
					text({
						class: "e-label q-label",
						x: lx,
						y: ly,
						"text-anchor": a === b ? "start" : "middle",
						style: "text-transform:none;letter-spacing:0;font-size:9px",
					}, m.label),
				),
			);
		}
		if (spec.numbered) {
			g.push(
				text({
					class: "q-num",
					x: a === b ? xs[a] - 6 : xs[a] + (b > a ? 6 : -6),
					y: y0 - 7,
					"text-anchor": a >= b ? "end" : "start",
				}, `${i + 1}`),
			);
		}
		return el("g", {
			class: `sc-edge ek-${kind}`,
			"data-sc-edge": `m${i}`,
			"data-from": m.from,
			"data-to": m.to,
			"data-sc-step": stepOf(i),
			style: `--step:${stepOf(i)}`,
		}, g);
	});
	out.push(el("g", { class: "sc-edges" }, msgSvg));

	// notes
	out.push(el(
		"g",
		{ class: "sc-notes" },
		notes.filter((n) => n.y !== undefined).map((n) => {
			const idx = n.over.map((id) => index.get(id)).filter((v) => v !== undefined);
			if (!idx.length) return "";
			const tw = textWidth(n.text, { size: 10 }) + 20;
			const cx = (xs[Math.min(...idx)] + xs[Math.max(...idx)]) / 2;
			const w = Math.max(tw, idx.length > 1 ? Math.abs(xs[idx[1]] - xs[idx[0]]) + 48 : 0);
			return el("g", {
				class: "sc-enter",
				"data-sc-step": stepOf(Math.min(n.at, msgs.length - 1)),
				style: `--step:${stepOf(Math.min(n.at, msgs.length - 1))}`,
			}, [
				el("rect", { class: "q-note", x: cx - w / 2, y: n.y - 16, width: w, height: 24, rx: 3 }),
				text({ class: "q-note-text", x: cx, y: n.y, "text-anchor": "middle" }, n.text),
			]);
		}),
	));

	// participant heads (top) and feet (bottom)
	out.push(el("g", { class: "sc-nodes" }, parts.map((p) => drawNode(p, { step: 0 }))));

	const maxX = Math.max(...parts.map((p) => p.x + p.w), ...xs.map((x) => x + 90));
	const minX = Math.min(...parts.map((p) => p.x)) - 24;
	return {
		body: out.join(""),
		viewBox: [minX - 8, -24, maxX - minX + 32, bottom + 40],
		steps: Math.max(...msgs.map((_, i) => stepOf(i))),
		problems,
		graph: {
			nodes: parts.map((p) => ({ id: p.id, label: p.label })),
			edges: msgs.map((m, i) => ({ id: `m${i}`, from: m.from, to: m.to })),
		},
	};
}
