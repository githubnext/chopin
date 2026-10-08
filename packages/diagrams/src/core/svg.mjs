// Minimal SVG string builder.

export function esc(v) {
	return String(v)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const r2 = (n) => (Number.isInteger(n) ? n : Math.round(n * 100) / 100);

function attrs(a) {
	let out = "";
	for (const [k, v] of Object.entries(a)) {
		if (v === undefined || v === null || v === false) continue;
		out += ` ${k}="${esc(typeof v === "number" ? r2(v) : v)}"`;
	}
	return out;
}

export function el(tag, a = {}, children) {
	if (children === undefined || children === null) return `<${tag}${attrs(a)}/>`;
	const body = Array.isArray(children) ? children.join("") : children;
	return `<${tag}${attrs(a)}>${body}</${tag}>`;
}

export const text = (a, content) => el("text", a, esc(content));

export function pathD(points) {
	return points.map((p, i) => `${i ? "L" : "M"}${r2(p.x)},${r2(p.y)}`).join(" ");
}

// Orthogonal polyline with rounded corners of radius r.
export function roundedPath(points, r = 6) {
	if (points.length < 3) return pathD(points);
	let d = `M${r2(points[0].x)},${r2(points[0].y)}`;
	for (let i = 1; i < points.length - 1; i++) {
		const p0 = points[i - 1];
		const p = points[i];
		const p1 = points[i + 1];
		const l0 = Math.hypot(p.x - p0.x, p.y - p0.y);
		const l1 = Math.hypot(p1.x - p.x, p1.y - p.y);
		const rr = Math.min(r, l0 / 2, l1 / 2);
		if (rr < 0.5) {
			d += ` L${r2(p.x)},${r2(p.y)}`;
			continue;
		}
		const a = { x: p.x - ((p.x - p0.x) / l0) * rr, y: p.y - ((p.y - p0.y) / l0) * rr };
		const b = { x: p.x + ((p1.x - p.x) / l1) * rr, y: p.y + ((p1.y - p.y) / l1) * rr };
		d += ` L${r2(a.x)},${r2(a.y)} Q${r2(p.x)},${r2(p.y)} ${r2(b.x)},${r2(b.y)}`;
	}
	const last = points[points.length - 1];
	return `${d} L${r2(last.x)},${r2(last.y)}`;
}

export function markers() {
	const m = (id, cls) =>
		el("marker", {
			id,
			viewBox: "0 0 8 6",
			markerWidth: 8,
			markerHeight: 6,
			refX: 7,
			refY: 3,
			orient: "auto-start-reverse",
			markerUnits: "userSpaceOnUse",
		}, el("path", { d: "M0,0 L8,3 L0,6 Z", class: cls }));
	return el("defs", {}, [
		m("sc-arrow", "m-default"),
		m("sc-arrow-primary", "m-primary"),
		m("sc-arrow-link", "m-link"),
		m("sc-arrow-muted", "m-muted"),
	]);
}

export const MARKER_FOR = {
	default: "sc-arrow",
	primary: "sc-arrow-primary",
	link: "sc-arrow-link",
	async: "sc-arrow",
	return: "sc-arrow",
	muted: "sc-arrow-muted",
};

export function rectsOverlap(a, b, pad = 0) {
	return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad
		&& a.y + a.h + pad > b.y;
}
