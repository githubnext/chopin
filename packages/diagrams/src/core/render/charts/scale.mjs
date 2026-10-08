// Nice linear scales + number formatting for chart renderers.

export function niceStep(range, target = 5) {
	const raw = range / target;
	const mag = 10 ** Math.floor(Math.log10(raw || 1));
	const n = raw / mag;
	const step = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
	return step * mag;
}

export function niceDomain(min, max, target = 5) {
	const lo = Math.min(0, min), hi = Math.max(0, max);
	const step = niceStep(hi - lo || 1, target);
	return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

export function ticks({ lo, hi, step }) {
	const out = [];
	for (let v = lo; v <= hi + step / 1e6; v += step) out.push(Math.round(v * 1e6) / 1e6);
	return out;
}

export function fmt(v, unit = "") {
	const a = Math.abs(v);
	let s;
	if (a >= 1e9) s = `${trim(v / 1e9)}B`;
	else if (a >= 1e6) s = `${trim(v / 1e6)}M`;
	else if (a >= 1e4) s = `${trim(v / 1e3)}k`;
	else s = trim(v);
	if (!unit) return s;
	if (/^[$€£¥₹]$/.test(unit)) return v < 0 ? `-${unit}${s.slice(1)}` : `${unit}${s}`;
	return unit === "%" || unit.length <= 2 ? `${s}${unit}` : `${s} ${unit}`;
}

function trim(v) {
	return String(Math.round(v * 100) / 100);
}
