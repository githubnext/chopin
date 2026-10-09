// Timeline: events on a horizontal axis (proportional when dated, evenly
// spaced otherwise), labels alternate above/below and stack to avoid overlap.
// Optional periods draw as bands under the axis. Motion: axis draws, events in order.
import { el, text } from "../../svg.mjs";
import { textWidth } from "../../text.mjs";
import { DIAGRAM_TYPE } from "../../tokens.mjs";
import { fmtTime, parseTime, timeTicks } from "./time.mjs";

export const family = "lanes";

const LBL = { size: 11, weight: 600 };

export function render(spec) {
	const problems = [];
	const events = spec.events.map((e, i) => ({ ...e, id: e.id || `e${i}`, i }));
	if (events.length > 14) {
		problems.push({
			code: "W_BUDGET",
			at: "events",
			msg: `${events.length} events`,
			fix: "keep ≤ 14 events; group minor ones into a period",
		});
	}
	const parsed = events.map((e) => (e.date !== undefined ? parseTime(e.date) : null));
	const dated = parsed.every(Boolean);
	if (!dated && parsed.some(Boolean)) {
		problems.push({
			code: "W_DATES",
			at: "events",
			msg: "some events have unparseable dates",
			fix: "use YYYY, YYYY-MM, YYYY-MM-DD or YYYY-Q1 for every event (or none)",
		});
	}
	const W = Math.max(640, events.length * 96);
	let x;
	let ticks = [];
	const periods = (spec.periods || []).map((p) => ({
		...p,
		a: parseTime(p.from),
		b: parseTime(p.to),
	}));
	if (dated) {
		const ts = parsed.map((p) => p.t).concat(
			periods.flatMap((p) => [p.a?.t, p.b?.t]).filter((v) => v !== undefined),
		);
		const numeric = parsed[0].kind === "num";
		let t0 = Math.min(...ts), t1 = Math.max(...ts);
		const pad = (t1 - t0 || 1) * 0.04;
		t0 -= pad;
		t1 += pad;
		x = (t) => ((t - t0) / (t1 - t0)) * W;
		ticks = timeTicks(t0, t1, numeric);
		events.forEach((e, i) => {
			e.x = x(parsed[i].t);
			e.when = e.when || fmtTime(parsed[i].t, parsed[i].kind);
		});
	} else {
		events.forEach((e, i) => {
			e.x = ((i + 0.5) * W) / events.length;
			e.when = e.when || e.date || "";
		});
	}
	// label boxes: alternate above/below, stack levels until no overlap
	const placed = { up: [], down: [] };
	const order = [...events].sort((a, b) => a.x - b.x);
	order.forEach((e, k) => {
		const w = Math.max(
			textWidth(e.label, LBL),
			textWidth(e.when || "", { size: 9, mono: true }),
			e.sub ? textWidth(e.sub, DIAGRAM_TYPE.sub) : 0,
		) + 12;
		const side = spec.layout === "above" ? "up" : k % 2 === 0 ? "up" : "down";
		let level = 0;
		while (
			placed[side].some((p) => p.level === level && Math.abs(p.x - e.x) < (p.w + w) / 2 + 8)
			&& level < 4
		) level++;
		e.side = side;
		e.level = level;
		e.w = w;
		placed[side].push({ x: e.x, w, level });
	});
	const out = [];
	const axisY = 0;
	out.push(
		el("g", {
			class: "sc-edge ek-default",
			"data-sc-edge": "axis",
			"data-sc-step": 1,
			style: "--step:0",
		}, [
			el("path", {
				class: "e-line sc-draw tl-axis",
				d: `M-16,${axisY} L${W + 16},${axisY}`,
				pathLength: 1,
			}),
		]),
	);
	out.push(el(
		"g",
		{ class: "sc-fade", "data-sc-step": 1, style: "--step:1" },
		ticks.map((t) =>
			[
				el("line", { class: "ax-grid", x1: x(t.t), y1: -4, x2: x(t.t), y2: 4 }),
				text({ class: "ax-text", x: x(t.t), y: 18, "text-anchor": "middle" }, t.label),
			].join("")
		),
	));
	periods.forEach((p, k) => {
		if (!p.a || !p.b || !x) return;
		const y = 30 + (k % 2) * 18;
		out.push(el("g", { class: "sc-fade", "data-sc-step": 2, style: "--step:2" }, [
			el("rect", {
				class: `tl-period${p.focal ? " is-focal" : ""}`,
				x: x(p.a.t),
				y,
				width: Math.max(4, x(p.b.t) - x(p.a.t)),
				height: 12,
				rx: 2,
			}),
			text({ class: "tl-period-text", x: x(p.a.t) + 6, y: y + 9 }, p.label),
		]));
	});
	const rows = Math.max(0, ...events.map((e) => e.level));
	const LEVEL = 50;
	const steps = new Map(
		order.map((
			e,
			k,
		) => [e.id, Math.min(12, 2 + Math.floor((k * 10) / Math.max(10, order.length)))]),
	);
	for (const e of events) {
		const up = e.side === "up";
		const off = 34 + e.level * LEVEL + (up ? 0 : periods.length ? 40 : 0);
		const ly = up ? axisY - off : axisY + off + 4;
		const st = steps.get(e.id);
		const g = [
			el("line", { class: "tl-stem", x1: e.x, y1: axisY, x2: e.x, y2: up ? ly + 8 : ly - 14 }),
			el("circle", { class: "tl-dot", cx: e.x, cy: axisY, r: e.focal ? 5 : 3.5 }),
			text(
				{ class: "tl-when", x: e.x, y: up ? ly - 16 : ly - 2, "text-anchor": "middle" },
				e.when || "",
			),
			text(
				{ class: "n-label tl-label", x: e.x, y: up ? ly - 2 : ly + 12, "text-anchor": "middle" },
				e.label,
			),
		];
		if (e.sub) {
			g.push(
				text({ class: "n-sub", x: e.x, y: up ? ly - 30 : ly + 25, "text-anchor": "middle" }, e.sub),
			);
		}
		out.push(
			el("g", {
				class: `sc-node tl-ev${e.focal ? " k-focal" : ""}`,
				"data-sc-node": e.id,
				"data-sc-step": st,
				style: `--step:${st}`,
				tabindex: 0,
				role: "group",
				"aria-label": `${e.when} ${e.label}`,
			}, g),
		);
	}
	const top = 34 + rows * LEVEL + 48;
	const bottom = 34 + rows * LEVEL + 48 + (periods.length ? 40 : 0);
	return {
		body: out.join(""),
		viewBox: [-Math.max(60, ...events.map((e) => e.w / 2 - e.x + 16)), -top, W + 120, top + bottom],
		steps: Math.max(...steps.values()),
		problems,
		graph: { nodes: events.map((e) => ({ id: e.id, label: e.label })), edges: [] },
	};
}
