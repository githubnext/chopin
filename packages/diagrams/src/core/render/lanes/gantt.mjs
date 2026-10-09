// Gantt: one row per task on a time axis, grouped by section. Tasks take
// start+end, start+days, or after:<id>+days. Milestones are diamonds; an
// optional "today" line. Motion: bars grow left→right in start order.
import { el, text } from "../../svg.mjs";
import { textWidth } from "../../text.mjs";
import { DIAGRAM_TYPE } from "../../tokens.mjs";
import { addDays, DAY, parseTime, timeTicks } from "./time.mjs";

export const family = "lanes";

export function render(spec) {
	const problems = [];
	const byId = new Map();
	const tasks = spec.tasks.map((t, i) => ({ ...t, id: t.id || `t${i}`, i }));
	tasks.forEach((t) => byId.set(t.id, t));
	let numeric = false;
	// resolve start/end (after: dependencies resolve in order)
	for (let pass = 0; pass < 3; pass++) {
		for (const t of tasks) {
			if (t.s !== undefined && t.e !== undefined) continue;
			if (t.after) {
				const dep = byId.get(t.after);
				if (!dep) {
					if (pass === 0) {
						problems.push({
							code: "E_SPEC",
							at: `tasks.${t.id}`,
							msg: `after: unknown task "${t.after}"`,
							fix: "use another task id",
						});
					}
					continue;
				}
				if (dep.e === undefined) continue;
				t.s = dep.e;
			} else if (t.start !== undefined) {
				const p = parseTime(t.start);
				if (!p) {
					if (pass === 0) {
						problems.push({
							code: "E_SPEC",
							at: `tasks.${t.id}.start`,
							msg: `bad date "${t.start}"`,
							fix: "use YYYY-MM-DD or a number",
						});
					}
					continue;
				}
				numeric = p.kind === "num";
				t.s = p.t;
			}
			if (t.s === undefined) continue;
			if (t.end !== undefined) t.e = parseTime(t.end)?.t;
			else if (t.days !== undefined) t.e = numeric ? t.s + t.days : addDays(t.s, t.days);
			else t.e = t.s;
		}
	}
	const bad = tasks.filter((t) => t.s === undefined || t.e === undefined);
	if (bad.length) {
		problems.push({
			code: "E_SPEC",
			at: `tasks.${bad[0].id}`,
			msg: "task has no resolvable start/end",
			fix: "give start + (end | days), or after + days",
		});
	}
	if (problems.some((p) => p.code.startsWith("E_"))) return { problems };
	if (tasks.length > 18) {
		problems.push({
			code: "W_BUDGET",
			at: "tasks",
			msg: `${tasks.length} tasks`,
			fix: "roll small tasks up into their section (≤ 18 rows)",
		});
	}
	const miles = (spec.milestones || []).map((m, i) => ({
		...m,
		id: m.id || `m${i}`,
		t: parseTime(m.date)?.t,
	}));
	const today = spec.today ? parseTime(spec.today)?.t : undefined;
	const all = tasks.flatMap((t) => [t.s, t.e]).concat(
		miles.map((m) => m.t).filter((v) => v !== undefined),
	);
	let t0 = Math.min(...all), t1 = Math.max(...all);
	const pad = (t1 - t0 || (numeric ? 1 : DAY)) * 0.03;
	t0 -= pad;
	t1 += pad;
	const W = 640;
	const x = (t) => ((t - t0) / (t1 - t0)) * W;
	const ROW = 26;
	const labelW = Math.max(
		...tasks.map((t) => textWidth(t.label, { size: 11 })),
		...tasks.filter((t) => t.section).map((t) =>
			textWidth(t.section.toUpperCase(), DIAGRAM_TYPE.tag)
		),
	) + 28;
	const out = [];
	// sections
	const sections = [];
	let y = 8;
	const rows = [];
	for (const t of tasks) {
		if (t.section && (!sections.length || sections[sections.length - 1].label !== t.section)) {
			sections.push({ label: t.section, y });
			y += 22;
		}
		rows.push({ t, y });
		y += ROW;
	}
	const H = y;
	const ticks = timeTicks(t0, t1, numeric);
	out.push(el("g", { class: "sc-fade", "data-sc-step": 1, style: "--step:0" }, [
		...ticks.map((tk) =>
			el("line", { class: "ax-grid", x1: labelW + x(tk.t), y1: 0, x2: labelW + x(tk.t), y2: H })
		),
		...ticks.map((tk) =>
			text({ class: "ax-text", x: labelW + x(tk.t), y: -8, "text-anchor": "middle" }, tk.label)
		),
		...sections.map((s) => text({ class: "lane-label", x: 0, y: s.y + 14 }, s.label.toUpperCase())),
	]));
	const order = [...tasks].sort((a, b) => a.s - b.s);
	const stepOf = new Map(
		order.map((
			t,
			k,
		) => [t.id, Math.min(12, 2 + Math.floor((k * 10) / Math.max(10, order.length)))]),
	);
	for (const { t, y: ry } of rows) {
		const bx = labelW + x(t.s), bw = Math.max(3, x(t.e) - x(t.s));
		const st = stepOf.get(t.id);
		const parts = [
			text({ class: "g-task", x: 0, y: ry + 16 }, t.label),
			el("rect", {
				class: `g-bar${t.focal ? " is-focal" : ""}${t.done ? " is-done" : ""} sc-grow-x`,
				x: bx,
				y: ry + 6,
				width: bw,
				height: 14,
				rx: 3,
				"data-sc-step": st,
				style: `--step:${st}`,
				"data-sc-tip": `${t.label}: ${Math.round(numeric ? t.e - t.s : (t.e - t.s) / DAY)}${
					numeric ? "" : " days"
				}`,
			}),
		];
		if (t.done) parts.push(text({ class: "g-done", x: bx + bw + 6, y: ry + 17 }, "✓"));
		out.push(
			el("g", {
				class: `sc-node${t.focal ? " k-focal" : ""}`,
				"data-sc-node": t.id,
				tabindex: 0,
				role: "group",
				"aria-label": t.label,
			}, parts),
		);
	}
	// dependency arrows
	for (const { t, y: ry } of rows) {
		if (!t.after) continue;
		const dep = rows.find((r) => r.t.id === t.after);
		const xa = labelW + x(dep.t.e), ya = dep.y + 13, xb = labelW + x(t.s), yb = ry + 13;
		const mx = Math.max(xa + 8, xb + 4);
		const st = stepOf.get(t.id);
		out.push(
			el("g", {
				class: "sc-edge ek-muted",
				"data-sc-edge": `${dep.t.id}-${t.id}`,
				"data-from": dep.t.id,
				"data-to": t.id,
				"data-sc-step": st,
				style: `--step:${st}`,
			}, [
				el("path", { class: "e-line", d: `M${xa},${ya} L${mx},${ya} L${mx},${yb - 13}` }),
				el("path", {
					class: "e-head m-muted",
					d: `M${mx},${yb - 6} L${mx - 3},${yb - 12} L${mx + 3},${yb - 12} Z`,
				}),
			]),
		);
	}
	for (const m of miles) {
		if (m.t === undefined) continue;
		const mx = labelW + x(m.t);
		out.push(
			el("g", {
				class: `sc-pop${m.focal ? " k-focal" : ""}`,
				"data-sc-step": 12,
				style: "--step:12",
			}, [
				el("path", { class: "g-mile", d: `M${mx},${H + 4} l7,7 l-7,7 l-7,-7 Z` }),
				text({ class: "tl-when", x: mx, y: H + 32, "text-anchor": "middle" }, m.label),
			]),
		);
	}
	if (today !== undefined) {
		const tx = labelW + x(today);
		out.push(el("g", { class: "sc-fade", "data-sc-step": 1, style: "--step:1" }, [
			el("line", { class: "g-today", x1: tx, y1: -2, x2: tx, y2: H }),
			text({ class: "g-today-text", x: tx + 4, y: H - 4 }, "TODAY"),
		]));
	}
	return {
		body: out.join(""),
		viewBox: [-20, -32, labelW + W + 60, H + (miles.length ? 64 : 40)],
		steps: 12,
		problems,
		graph: {
			nodes: tasks.map((t) => ({ id: t.id, label: t.label })),
			edges: tasks.filter((t) => t.after).map((t) => ({
				id: `${t.after}-${t.id}`,
				from: t.after,
				to: t.id,
			})),
		},
	};
}
