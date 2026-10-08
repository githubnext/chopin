// Orthogonal edge routing on a placed grid.
// 1. choose sides per edge (center ports) by scoring candidate polylines,
// 2. spread ports on shared sides (aligned where possible),
// 3. re-route with fixed ports, 4. separate parallel channel segments.

const STUB = 18; // straight run out of a port before the first bend (arrowhead room)
const PAD = 8; // clearance around node boxes
const DIRS = { L: { x: -1, y: 0 }, R: { x: 1, y: 0 }, T: { x: 0, y: -1 }, B: { x: 0, y: 1 } };
const SIDES = ["L", "R", "T", "B"];
const POINT = new Set(["decision", "start", "end"]);

function sidePoint(n, side, t = 0.5) {
	switch (side) {
		case "L":
			return { x: n.x, y: n.y + n.h * t };
		case "R":
			return { x: n.x + n.w, y: n.y + n.h * t };
		case "T":
			return { x: n.x + n.w * t, y: n.y };
		default:
			return { x: n.x + n.w * t, y: n.y + n.h };
	}
}

function allowedSides() {
	return SIDES;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function segHitsBox(a, b, r) {
	// axis-aligned segment vs rect (open interior)
	if (a.x === b.x) {
		const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
		return a.x > r.x && a.x < r.x + r.w && y1 > r.y && y0 < r.y + r.h;
	}
	const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
	return a.y > r.y && a.y < r.y + r.h && x1 > r.x && x0 < r.x + r.w;
}

function simplify(pts) {
	const out = [];
	for (const p of pts) {
		const q = { x: Math.round(p.x * 2) / 2, y: Math.round(p.y * 2) / 2 };
		const last = out[out.length - 1];
		if (last && last.x === q.x && last.y === q.y) continue;
		out.push(q);
	}
	for (let i = out.length - 2; i > 0; i--) {
		const a = out[i - 1], b = out[i], c = out[i + 1];
		if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(i, 1);
	}
	return out;
}

function length(pts) {
	let l = 0;
	for (let i = 1; i < pts.length; i++) {
		l += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
	}
	return l;
}

function isOrthogonal(pts) {
	for (let i = 1; i < pts.length; i++) {
		if (pts[i].x !== pts[i - 1].x && pts[i].y !== pts[i - 1].y) return false;
	}
	return true;
}

// Does the polyline reverse direction onto itself (a segment doubling back)?
function backtracks(pts) {
	for (let i = 2; i < pts.length; i++) {
		const d1 = {
			x: Math.sign(pts[i - 1].x - pts[i - 2].x),
			y: Math.sign(pts[i - 1].y - pts[i - 2].y),
		};
		const d2 = { x: Math.sign(pts[i].x - pts[i - 1].x), y: Math.sign(pts[i].y - pts[i - 1].y) };
		if (d1.x === -d2.x && d1.y === -d2.y && (d1.x || d1.y)) return true;
	}
	return false;
}

function nearest(values, v, k) {
	return [...values].sort((a, b) => Math.abs(a - v) - Math.abs(b - v)).slice(0, k);
}

function candidates(pS, sS, pT, sT, ch) {
	const dS = DIRS[sS], dT = DIRS[sT];
	const a = { x: pS.x + dS.x * STUB, y: pS.y + dS.y * STUB };
	const b = { x: pT.x + dT.x * STUB, y: pT.y + dT.y * STUB };
	const mids = [];
	// direct / L / Z / U shapes between stub ends a and b
	if (a.x === b.x || a.y === b.y) mids.push([]);
	mids.push([{ x: b.x, y: a.y }], [{ x: a.x, y: b.y }]);
	const xs = new Set([...nearest(ch.xs, (a.x + b.x) / 2, 4), (a.x + b.x) / 2]);
	const ys = new Set([...nearest(ch.ys, (a.y + b.y) / 2, 4), (a.y + b.y) / 2]);
	for (const x of xs) mids.push([{ x, y: a.y }, { x, y: b.y }]);
	for (const y of ys) mids.push([{ x: a.x, y }, { x: b.x, y }]);
	const x1s = nearest(ch.xs, a.x, 2), x2s = nearest(ch.xs, b.x, 2);
	const y1s = nearest(ch.ys, a.y, 2), y2s = nearest(ch.ys, b.y, 2);
	for (const y of nearest(ch.ys, (a.y + b.y) / 2, 3)) {
		for (const x1 of x1s) {
			for (const x2 of x2s) {
				mids.push([{ x: x1, y: a.y }, { x: x1, y }, { x: x2, y }, { x: x2, y: b.y }]);
			}
		}
	}
	for (const x of nearest(ch.xs, (a.x + b.x) / 2, 3)) {
		for (const y1 of y1s) {
			for (const y2 of y2s) {
				mids.push([{ x: a.x, y: y1 }, { x, y: y1 }, { x, y: y2 }, { x: b.x, y: y2 }]);
			}
		}
	}
	return mids.map((m) => ({ pts: simplify([pS, a, ...m, b, pT]), raw: [pS, a, ...m, b, pT] }));
}

function clearOf(pts, boxes) {
	// stubs (first and last segment) may touch their own node; everything else must clear all boxes
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1], b = pts[i];
		for (const r of boxes) {
			const own = (i === 1 && r.id === pts.src) || (i === pts.length - 1 && r.id === pts.dst);
			const box = own
				? r
				: { x: r.x - PAD, y: r.y - PAD, w: r.w + 2 * PAD, h: r.h + 2 * PAD, id: r.id };
			if (!own && segHitsBox(a, b, box)) return false;
			if (own && i !== 1 && i !== pts.length - 1 && segHitsBox(a, b, r)) return false;
		}
	}
	return true;
}

function crossings(pts, routes) {
	let n = 0;
	for (const r of routes) {
		for (let i = 1; i < pts.length; i++) {
			for (let j = 1; j < r.length; j++) {
				const a = pts[i - 1], b = pts[i], c = r[j - 1], d = r[j];
				const h1 = a.y === b.y, h2 = c.y === d.y;
				if (h1 === h2) continue;
				const [hA, hB, vA, vB] = h1 ? [a, b, c, d] : [c, d, a, b];
				const x = vA.x, y = hA.y;
				if (
					x > Math.min(hA.x, hB.x) && x < Math.max(hA.x, hB.x) && y > Math.min(vA.y, vB.y)
					&& y < Math.max(vA.y, vB.y)
				) n++;
			}
		}
	}
	return n;
}

function bestRoute(S, T, pS, sS, pT, sT, ctx) {
	let best = null;
	for (const c of candidates(pS, sS, pT, sT, ctx.channels)) {
		const pts = c.pts;
		if (pts.length < 2 || !isOrthogonal(pts) || backtracks(pts)) continue;
		pts.src = S.id;
		pts.dst = T.id;
		if (!clearOf(pts, ctx.boxes)) continue;
		// entry must arrive straight into the target side (last segment along -dT)
		const last = pts[pts.length - 1], prev = pts[pts.length - 2];
		const dT = DIRS[sT];
		const into = { x: Math.sign(last.x - prev.x), y: Math.sign(last.y - prev.y) };
		if (into.x !== -dT.x || into.y !== -dT.y) continue;
		const first = pts[1];
		const out = { x: Math.sign(first.x - pts[0].x), y: Math.sign(first.y - pts[0].y) };
		const dS = DIRS[sS];
		if (out.x !== dS.x || out.y !== dS.y) continue;
		const score = length(pts) + 36 * (pts.length - 2) + 60 * crossings(pts, ctx.routes);
		if (!best || score < best.score) best = { pts, score };
	}
	return best;
}

const AXIS_SIDES = { LR: ["L", "R"], TB: ["T", "B"] };

export function routeEdges(nodes, edges, { dir = "LR", channels }) {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const boxes = nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h, id: n.id }));
	const ctx = { boxes, channels, routes: [] };
	const problems = [];
	const primary = AXIS_SIDES[dir] || AXIS_SIDES.LR;

	// Pass 1: side selection with center ports.
	const order = [...edges].sort((e1, e2) => (e2.kind === "primary") - (e1.kind === "primary"));
	for (const e of order) {
		const S = byId.get(e.from), T = byId.get(e.to);
		let best = null;
		for (const sS of e.fieldYS != null ? ["L", "R"] : allowedSides(S)) {
			for (const sT of e.fieldYT != null ? ["L", "R"] : allowedSides(T)) {
				const r = bestRoute(
					S,
					T,
					endPoint(S, sS, e.fieldYS),
					sS,
					endPoint(T, sT, e.fieldYT),
					sT,
					ctx,
				);
				if (!r) continue;
				const pen = (primary.includes(sS) ? 0 : 14) + (primary.includes(sT) ? 0 : 14);
				if (!best || r.score + pen < best.score) best = { ...r, score: r.score + pen, sS, sT };
			}
		}
		if (!best) {
			problems.push({
				code: "E_ROUTE",
				at: `edges.${e.id}`,
				msg: `no clear path ${e.from}→${e.to}`,
				fix: "move one endpoint to a free row/col so the path does not pass behind other nodes",
			});
			e.route = null;
			continue;
		}
		e.sS = best.sS;
		e.sT = best.sT;
		ctx.routes.push(best.pts);
	}

	// Pass 2: port spreading. Each endpoint prefers the other end's coordinate
	// (so aligned nodes stay straight), then endpoints on a side are pushed apart.
	const ends = new Map();
	for (const e of edges) {
		if (!e.sS) continue;
		if (e.fieldYS != null) e.tS = e.fieldYS;
		if (e.fieldYT != null) e.tT = e.fieldYT;
		for (
			const [nodeId, side, otherId, role] of [[e.from, e.sS, e.to, "S"], [e.to, e.sT, e.from, "T"]]
		) {
			if ((role === "S" ? e.fieldYS : e.fieldYT) != null) continue;
			const key = `${nodeId}:${side}`;
			if (!ends.has(key)) ends.set(key, []);
			const other = byId.get(otherId);
			const pref = side === "L" || side === "R" ? other.y + other.h / 2 : other.x + other.w / 2;
			ends.get(key).push({ e, role, pref });
		}
	}
	for (const [key, list] of ends) {
		const [nodeId, side] = key.split(":");
		const n = byId.get(nodeId);
		const vertical = side === "L" || side === "R";
		const lo = vertical ? n.y : n.x;
		const span = vertical ? n.h : n.w;
		if (POINT.has(n.shape) || list.length === 1) {
			for (const it of list) {
				setPort(it, lo + span / 2);
				if (!POINT.has(n.shape)) it.e[it.role === "S" ? "singleS" : "singleT"] = true;
			}
			continue;
		}
		// shared side: start from each end's preferred coordinate (the other node's
		// center, so aligned pairs stay straight), then push apart to ≥ 12px.
		const min = lo + span * 0.18, max = lo + span * 0.82;
		const gap = Math.min(14, (max - min) / Math.max(1, list.length - 1));
		list.sort((a, b) => a.pref - b.pref);
		const pos = list.map((it) => clamp(it.pref, min, max));
		for (let i = 1; i < pos.length; i++) pos[i] = Math.max(pos[i], pos[i - 1] + gap);
		const over = pos[pos.length - 1] - max;
		if (over > 0) {
			for (let i = pos.length - 1; i >= 0; i--) {
				pos[i] = i === pos.length - 1
					? max
					: Math.min(pos[i], pos[i + 1] - gap);
			}
		}
		list.forEach((it, i) => setPort(it, pos[i]));
	}
	// A single endpoint facing a fixed one: adopt its coordinate when it fits in our span.
	for (const e of edges) {
		if (!e.sS || e.singleS === e.singleT) continue;
		const horiz = "LR".includes(e.sS) && "LR".includes(e.sT);
		const vert = "TB".includes(e.sS) && "TB".includes(e.sT);
		if (!horiz && !vert) continue;
		const single = byId.get(e.singleS ? e.from : e.to);
		const v = e.singleS ? e.tT : e.tS;
		const [a0, a1] = horiz ? [single.y, single.y + single.h] : [single.x, single.x + single.w];
		if (v >= a0 + 8 && v <= a1 - 8) {
			if (e.singleS) e.tS = v;
			else e.tT = v;
		}
	}
	// Two single endpoints on facing sides: share a coordinate inside both spans → straight line.
	for (const e of edges) {
		if (!e.singleS || !e.singleT) continue;
		const S = byId.get(e.from), T = byId.get(e.to);
		const horiz = "LR".includes(e.sS) && "LR".includes(e.sT);
		const vert = "TB".includes(e.sS) && "TB".includes(e.sT);
		if (!horiz && !vert) continue;
		const [a0, a1, b0, b1] = horiz
			? [S.y, S.y + S.h, T.y, T.y + T.h]
			: [S.x, S.x + S.w, T.x, T.x + T.w];
		const lo = Math.max(a0, b0) + 10, hi = Math.min(a1, b1) - 10;
		if (lo > hi) continue;
		const v = clamp(((a0 + a1) / 2 + (b0 + b1) / 2) / 2, lo, hi);
		e.tS = v;
		e.tT = v;
	}
	function setPort(it, v) {
		if (it.role === "S") it.e.tS = v;
		else it.e.tT = v;
	}

	// Pass 3: final routes with fixed ports.
	ctx.routes = [];
	for (const e of order) {
		if (!e.sS) continue;
		const S = byId.get(e.from), T = byId.get(e.to);
		const pS = portAt(S, e.sS, e.tS), pT = portAt(T, e.sT, e.tT);
		let r = bestRoute(S, T, pS, e.sS, pT, e.sT, ctx);
		if (!r) {
			r = bestRoute(
				S,
				T,
				endPoint(S, e.sS, e.fieldYS),
				e.sS,
				endPoint(T, e.sT, e.fieldYT),
				e.sT,
				ctx,
			);
		}
		if (!r) {
			problems.push({
				code: "E_ROUTE",
				at: `edges.${e.id}`,
				msg: `no clear path ${e.from}→${e.to}`,
				fix: "move one endpoint to a free row/col",
			});
			continue;
		}
		e.route = r.pts;
		ctx.routes.push(r.pts);
	}

	separateTracks(edges.filter((e) => e.route));
	return problems;
}

function endPoint(n, side, fieldY) {
	if (fieldY == null) return sidePoint(n, side);
	return { x: side === "L" ? n.x : n.x + n.w, y: fieldY };
}

function portAt(n, side, v) {
	if (side === "L") return { x: n.x, y: v };
	if (side === "R") return { x: n.x + n.w, y: v };
	if (side === "T") return { x: v, y: n.y };
	return { x: v, y: n.y + n.h };
}

// Parallel interior segments that share a channel get spread onto 8px tracks.
function separateTracks(edges) {
	for (const axis of ["x", "y"]) {
		const other = axis === "x" ? "y" : "x";
		const buckets = new Map();
		for (const e of edges) {
			const p = e.route;
			for (let i = 1; i < p.length - 2; i++) {
				const a = p[i], b = p[i + 1];
				if (!b || a[axis] !== b[axis]) continue;
				const key = a[axis];
				if (!buckets.has(key)) buckets.set(key, []);
				buckets.get(key).push({
					e,
					i,
					lo: Math.min(a[other], b[other]),
					hi: Math.max(a[other], b[other]),
				});
			}
		}
		for (const segs of buckets.values()) {
			if (segs.length < 2) continue;
			// edges from the same source sharing a trunk stay merged
			segs.sort((s1, s2) => s1.lo - s2.lo);
			const tracks = [];
			for (const s of segs) {
				let t = tracks.findIndex((tr) =>
					tr.every((o) => o.hi <= s.lo || o.lo >= s.hi || o.e.from === s.e.from)
				);
				if (t < 0) {
					tracks.push([]);
					t = tracks.length - 1;
				}
				tracks[t].push(s);
				s.track = t;
			}
			if (tracks.length < 2) continue;
			for (const s of segs) {
				const off = (s.track - (tracks.length - 1) / 2) * 8;
				s.e.route[s.i] = { ...s.e.route[s.i], [axis]: s.e.route[s.i][axis] + off };
				s.e.route[s.i + 1] = { ...s.e.route[s.i + 1], [axis]: s.e.route[s.i + 1][axis] + off };
			}
		}
	}
}

export { sidePoint };
