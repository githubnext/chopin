import { textWidth, wrap } from "../../text.mjs";
import { fmt, ticks } from "./scale.mjs";
import { bands, FITTED_TEXT } from "./fit.mjs";

// Shared by the drawing and its lightweight loading frame. Keep the geometry
// here so a chart with many horizontal rows does not move the table on load.
export function fittedBarLayout({ spec, cats, series, dom, unit, width }) {
	const S = FITTED_TEXT;
	const mono = { size: S, mono: true, tracking: 0.04 };
	const axisLines = spec.axis
		? wrap(spec.axis, width, { ...mono, tracking: 0.08, upper: true })
		: [];
	const top = axisLines.length ? axisLines.length * (S + 4) + 8 : 0;
	const catW = cats.map((c) => textWidth(c, { size: S }));
	const tickValues = ticks(dom);
	const left = Math.max(...tickValues.map((t) => textWidth(fmt(t, unit), mono))) + 8;
	const { slot, group } = bands(cats.length, width - left);
	const upright = spec.orientation !== "horizontal"
		&& (catW.every((w) => w <= slot - 4) || cats.length > 12);
	if (upright) {
		return {
			S,
			mono,
			axisLines,
			top,
			catW,
			tickValues,
			left,
			slot,
			group,
			upright,
			rows: [],
			barH: 0,
			height: top + S + 8 + 220 + S + 12,
		};
	}
	const barH = series.length > 1 ? 8 : 12;
	let cy = top;
	const rows = cats.map((c, i) => {
		const lines = wrap(c, width, { size: S });
		const row = { i, lines, label: cy, bars: cy + lines.length * (S + 4) + 2 };
		cy = row.bars + series.length * (barH + 2) + 12;
		return row;
	});
	return {
		S,
		mono,
		axisLines,
		top,
		catW,
		tickValues,
		left,
		slot,
		group,
		upright,
		rows,
		barH,
		height: cy - 12 + (series.length > 1 ? S + 12 : 4),
	};
}

export function nativeBarLayout({ cats, dom, unit }) {
	const plotH = 260;
	const slot = Math.max(44, Math.min(150, 640 / cats.length));
	const groupW = slot * 0.62;
	const labelW = Math.max(...cats.map((c) => textWidth(c, { size: 10 })));
	const rotate = labelW > slot - 6;
	const left = Math.max(
		...ticks(dom).map((t) =>
			textWidth(fmt(t, unit), {
				size: 8,
				mono: true,
			})
		),
	) + 16;
	const W = left + slot * cats.length;
	return {
		plotH,
		slot,
		groupW,
		rotate,
		left,
		W,
		width: W + 40,
		height: plotH + (rotate ? labelW * 0.6 + 24 : 34) + 44,
	};
}
