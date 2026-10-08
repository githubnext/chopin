// Bar chart: single series (data) or grouped series (categories + series).
// Accent goes to the focal bar/series only; everything else is muted.
import { el, text } from "../../svg.mjs";
import { textWidth } from "../../text.mjs";
import { fmt, niceDomain, ticks } from "./scale.mjs";
import { legend } from "../shared/legend.mjs";

export const family = "chart";

// Dumbbell: two values per category joined by a line (before → after).
function renderDumbbell(spec) {
	const problems = [];
	const rows = spec.data.map((d) => (Array.isArray(d) ? { label: d[0], a: d[1], b: d[2] } : d));
	const vals = rows.flatMap((r) => [r.a, r.b]);
	const dom = niceDomain(Math.min(...vals), Math.max(...vals));
	if (spec.zero === false) dom.lo = Math.floor(Math.min(...vals) / dom.step) * dom.step;
	const catW = Math.max(...rows.map((r) => textWidth(r.label, { size: 10 }))) + 16;
	const PW = 480, RH = 30;
	const x = (v) => catW + ((v - dom.lo) / (dom.hi - dom.lo)) * PW;
	const unit = spec.unit || "";
	const focalSet = new Set([].concat(spec.focal || []));
	const out = [];
	for (const t of ticks(dom)) {
		if (t < dom.lo) continue;
		out.push(el("line", { class: "ax-grid", x1: x(t), y1: -6, x2: x(t), y2: rows.length * RH }));
		out.push(
			text(
				{ class: "ax-text", x: x(t), y: rows.length * RH + 14, "text-anchor": "middle" },
				fmt(t, unit),
			),
		);
	}
	rows.forEach((r, i) => {
		const cy = i * RH + RH / 2;
		const focal = r.focal || focalSet.has(r.label);
		const st = Math.min(12, 1 + i);
		out.push(
			el("g", {
				class: `sc-fade${focal ? " k-focal" : ""}`,
				"data-sc-step": st,
				style: `--step:${st}`,
				"data-sc-tip": `${r.label}: ${fmt(r.a, unit)} → ${fmt(r.b, unit)}`,
			}, [
				text({
					class: `c-cat${focal ? " is-focal-t" : ""}`,
					x: catW - 10,
					y: cy + 3.5,
					"text-anchor": "end",
				}, r.label),
				el("line", {
					class: `db-line${focal ? " is-focal" : ""}`,
					x1: x(r.a),
					y1: cy,
					x2: x(r.b),
					y2: cy,
				}),
				el("circle", { class: "db-a", cx: x(r.a), cy, r: 4.5 }),
				el("circle", { class: `db-b${focal ? " is-focal" : ""}`, cx: x(r.b), cy, r: 4.5 }),
			]),
		);
	});
	const ly = rows.length * RH + 34;
	out.push(
		el("circle", { class: "db-a", cx: catW, cy: ly, r: 4 }),
		text({ class: "lg-text", x: catW + 10, y: ly + 3 }, spec.from || "before"),
	);
	out.push(
		el("circle", { class: "db-b", cx: catW + 90, cy: ly, r: 4 }),
		text({ class: "lg-text", x: catW + 100, y: ly + 3 }, spec.to || "after"),
	);
	return {
		body: out.join(""),
		viewBox: [-16, -24, catW + PW + 48, rows.length * RH + 72],
		steps: Math.min(12, rows.length),
		problems,
	};
}

// Marimekko: column width = column total, segments stacked by share.
function renderMarimekko(spec) {
	const problems = [];
	const cols = spec.columns.map((c) => ({
		...c,
		segments: c.segments.map((s) => (Array.isArray(s) ? { name: s[0], value: s[1] } : s)),
	}));
	cols.forEach((c) => (c.total = c.segments.reduce((s, g) => s + g.value, 0)));
	const grand = cols.reduce((s, c) => s + c.total, 0);
	const W = 600, H = 300;
	const names = [...new Set(cols.flatMap((c) => c.segments.map((s) => s.name)))];
	const out = [];
	let x = 0;
	cols.forEach((c, i) => {
		const w = (c.total / grand) * W;
		let y = H;
		const st = Math.min(12, 1 + i);
		const parts = [];
		for (const s of c.segments) {
			const h = (s.value / c.total) * H;
			y -= h;
			const k = names.indexOf(s.name);
			parts.push(el("rect", {
				class: `mk-seg ${s.focal ? "c-bar is-focal" : `s-${(k % 5) + 1}`}`,
				x: x + 1,
				y: y + 1,
				width: Math.max(0, w - 2),
				height: Math.max(0, h - 2),
				"data-sc-tip": `${c.label} · ${s.name}: ${fmt(s.value, spec.unit || "")} (${
					Math.round((s.value / c.total) * 100)
				}%)`,
			}));
			if (w > 44 && h > 16) {
				parts.push(
					text(
						{ class: "mk-pct", x: x + 6, y: y + 13 },
						`${Math.round((s.value / c.total) * 100)}%`,
					),
				);
			}
		}
		parts.push(text({ class: "c-cat", x: x + w / 2, y: H + 16, "text-anchor": "middle" }, c.label));
		parts.push(
			text(
				{ class: "ax-text", x: x + w / 2, y: H + 29, "text-anchor": "middle" },
				`${Math.round((c.total / grand) * 100)}%`,
			),
		);
		out.push(el("g", { class: "sc-wipe-down", "data-sc-step": st, style: `--step:${st}` }, parts));
		x += w;
	});
	const lg = legend({
		x: 0,
		y: H + 44,
		w: W,
		extra: names.map((n, k) => ({ type: "swatch", swatch: `s-${(k % 5) + 1}`, label: n })),
	});
	out.push(lg.svg);
	return {
		body: out.join(""),
		viewBox: [-16, -16, W + 32, H + 60 + lg.h],
		steps: Math.min(12, cols.length),
		problems,
	};
}

export function render(spec) {
	if (spec.variant === "dumbbell") return renderDumbbell(spec);
	if (spec.variant === "marimekko") return renderMarimekko(spec);
	const problems = [];
	let cats, series;
	if (spec.data) {
		const rows = spec.data.map((d) => (Array.isArray(d) ? { label: d[0], value: d[1] } : d));
		if (spec.sort === "desc") rows.sort((a, b) => b.value - a.value);
		if (spec.sort === "asc") rows.sort((a, b) => a.value - b.value);
		cats = rows.map((r) => r.label);
		const focalSet = new Set([].concat(spec.focal || []));
		series = [{
			name: spec.axis || "value",
			values: rows.map((r) => r.value),
			focalIdx: rows.map((r) => r.focal || focalSet.has(r.label)),
		}];
	} else if (spec.categories && spec.series) {
		cats = spec.categories;
		series = spec.series.map((s) => ({ ...s }));
		series.forEach((s, i) => {
			if (s.values.length !== cats.length) {
				problems.push({
					code: "E_SERIES_LEN",
					at: `series[${i}]`,
					msg: `${s.values.length} values for ${cats.length} categories`,
					fix: "give one value per category",
				});
			}
		});
	} else {
		return {
			problems: [{
				code: "E_SPEC",
				at: "data",
				msg: "needs data, or categories + series",
				fix: 'add resolved "data":[["label",value],…] or "categories" and "series"',
			}],
		};
	}
	if (problems.length) return { problems };
	if (cats.length > 16) {
		problems.push({
			code: "W_BUDGET",
			at: "data",
			msg: `${cats.length} bars`,
			fix: 'show the top 12 and fold the rest into "Other"',
		});
	}
	const focusMarked = series.some((s) => s.focal || (s.focalIdx || []).some(Boolean));
	if (!focusMarked && series.length === 1) {
		problems.push({
			code: "I_NO_FOCAL",
			msg: "no focal bar",
			fix: 'set "focal":"<label>" to put the accent on the bar that carries the point',
		});
	}

	const all = series.flatMap((s) => s.values);
	const dom = niceDomain(Math.min(...all), Math.max(...all));
	const horiz = spec.orientation === "horizontal";
	const multi = series.length > 1;
	const unit = spec.unit || "";
	const out = [];
	const step = (i) => Math.min(12, 1 + Math.floor((i * 12) / Math.max(12, cats.length)));
	const barCls = (s, si, ci) => {
		const focal = s.focal || (s.focalIdx && s.focalIdx[ci]);
		if (multi && !focal) return `c-bar s-${(si % 5) + 1}`;
		return `c-bar${focal ? " is-focal" : ""}`;
	};
	const tip = (s, i) => `${cats[i]}${multi ? ` · ${s.name}` : ""}: ${fmt(s.values[i], unit)}`;

	if (!horiz) {
		const plotH = 260;
		const slot = Math.max(44, Math.min(150, 640 / cats.length));
		const groupW = slot * 0.62;
		const bw = groupW / series.length;
		const labelW = Math.max(...cats.map((c) => textWidth(c, { size: 10 })));
		const rotate = labelW > slot - 6;
		const left = Math.max(
			...ticks(dom).map((t) => textWidth(fmt(t, unit), { size: 8, mono: true })),
		) + 16;
		const W = left + slot * cats.length;
		const y = (v) => plotH - ((v - dom.lo) / (dom.hi - dom.lo)) * plotH;
		for (const t of ticks(dom)) {
			out.push(
				el("line", {
					class: t === 0 ? "ax-line" : "ax-grid",
					x1: left - 4,
					y1: y(t),
					x2: W,
					y2: y(t),
				}),
			);
			out.push(
				text({ class: "ax-text", x: left - 8, y: y(t) + 3, "text-anchor": "end" }, fmt(t, unit)),
			);
		}
		cats.forEach((c, i) => {
			const gx = left + slot * i + (slot - groupW) / 2;
			series.forEach((s, si) => {
				const v = s.values[i];
				const y0 = y(Math.max(0, v)), y1 = y(Math.min(0, v));
				out.push(el("rect", {
					class: `${barCls(s, si, i)} sc-grow-y`,
					x: gx + bw * si + 1,
					y: y0,
					width: Math.max(2, bw - 2),
					height: Math.max(0.5, y1 - y0),
					rx: 1.5,
					"data-sc-step": step(i),
					style: `--step:${step(i)}${v < 0 ? ";transform-origin:50% 0" : ""}`,
					"data-sc-tip": tip(s, i),
				}));
				if (!multi) {
					const focal = s.focalIdx && s.focalIdx[i];
					out.push(
						text({
							class: `c-val sc-fade${focal ? " is-focal" : ""}`,
							x: gx + groupW / 2,
							y: v >= 0 ? y0 - 6 : y1 + 12,
							"text-anchor": "middle",
							"data-sc-step": step(i),
							style: `--step:${step(i)}`,
						}, fmt(v, unit)),
					);
				}
			});
			const cx = left + slot * i + slot / 2;
			out.push(
				rotate
					? text({
						class: "c-cat",
						x: cx,
						y: plotH + 14,
						"text-anchor": "end",
						transform: `rotate(-35 ${cx} ${plotH + 14})`,
					}, c)
					: text({ class: "c-cat", x: cx, y: plotH + 18, "text-anchor": "middle" }, c),
			);
		});
		let h = plotH + (rotate ? labelW * 0.6 + 24 : 34);
		if (multi) {
			const lg = legend({
				x: left,
				y: h + 4,
				w: W - left,
				extra: series.map((s, i) => ({
					type: "swatch",
					swatch: s.focal ? "c-bar is-focal" : `c-bar s-${(i % 5) + 1}`,
					label: s.name,
				})),
			});
			out.push(lg.svg);
			h += lg.h + 12;
		}
		if (spec.axis) out.push(text({ class: "ax-label", x: 0, y: -16 }, spec.axis));
		return {
			body: out.join(""),
			viewBox: [-16, -36, W + 40, h + 44],
			steps: step(cats.length - 1),
			problems,
		};
	}

	// horizontal
	const rowH = Math.max(22, 26 * Math.max(1, series.length * 0.7));
	const catW = Math.max(...cats.map((c) => textWidth(c, { size: 10 }))) + 14;
	const plotW = 520;
	const x = (v) => catW + ((v - dom.lo) / (dom.hi - dom.lo)) * plotW;
	const H = rowH * cats.length;
	for (const t of ticks(dom)) {
		out.push(
			el("line", { class: t === 0 ? "ax-line" : "ax-grid", x1: x(t), y1: -4, x2: x(t), y2: H }),
		);
		out.push(text({ class: "ax-text", x: x(t), y: H + 14, "text-anchor": "middle" }, fmt(t, unit)));
	}
	const bh = (rowH * 0.62) / series.length;
	cats.forEach((c, i) => {
		const gy = rowH * i + rowH * 0.19;
		out.push(
			text({ class: "c-cat", x: catW - 10, y: rowH * i + rowH / 2 + 3.5, "text-anchor": "end" }, c),
		);
		series.forEach((s, si) => {
			const v = s.values[i];
			const x0 = x(Math.min(0, v)), x1 = x(Math.max(0, v));
			out.push(
				el("rect", {
					class: `${barCls(s, si, i)} sc-grow-x`,
					x: x0,
					y: gy + bh * si,
					width: Math.max(0.5, x1 - x0),
					height: Math.max(2, bh - 1.5),
					rx: 1.5,
					"data-sc-step": step(i),
					style: `--step:${step(i)}`,
					"data-sc-tip": tip(s, i),
				}),
			);
			if (!multi) {
				const focal = s.focalIdx && s.focalIdx[i];
				out.push(
					text({
						class: `c-val sc-fade${focal ? " is-focal" : ""}`,
						x: x1 + 6,
						y: gy + bh / 2 + 3,
						"data-sc-step": step(i),
						style: `--step:${step(i)}`,
					}, fmt(v, unit)),
				);
			}
		});
	});
	let h = H + 28;
	if (multi) {
		const lg = legend({
			x: catW,
			y: h,
			w: plotW,
			extra: series.map((s, i) => ({
				type: "swatch",
				swatch: s.focal ? "c-bar is-focal" : `c-bar s-${(i % 5) + 1}`,
				label: s.name,
			})),
		});
		out.push(lg.svg);
		h += lg.h + 8;
	}
	if (spec.axis) out.push(text({ class: "ax-label", x: catW, y: -16 }, spec.axis));
	return {
		body: out.join(""),
		viewBox: [-16, -36, catW + plotW + 72, h + 52],
		steps: step(cats.length - 1),
		problems,
	};
}
