// Loop / flywheel: steps on a ring joined by arcs; one token circulates.
import { el, text } from "../../svg.mjs";
import { textWidth } from "../../text.mjs";
import { group, item, itemIdProblems, LABEL, labelBlock, stepOf } from "./common.mjs";

export const family = "structure";

export function render(spec) {
	const problems = [];
	const steps = spec.steps.map((s, i) => item(s, i, "s"));
	const identityProblems = itemIdProblems(steps, "steps");
	if (identityProblems.length) return { problems: identityProblems };
	const n = steps.length;
	if (n < 3 || n > 8) {
		problems.push({
			code: "W_BUDGET",
			at: "steps",
			msg: `${n} steps`,
			fix: "a loop reads best with 3–8 steps",
		});
	}
	const boxW = Math.max(
		104,
		Math.min(160, Math.max(...steps.map((s) => textWidth(s.label, LABEL))) + 28),
	);
	const boxH = 52;
	const R = Math.max(160, (n * (boxW + 64)) / (2 * Math.PI));
	const pos = steps.map((_, i) => {
		const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
		return { a, x: R * Math.cos(a), y: R * Math.sin(a) };
	});
	// arcs between consecutive boxes, trimmed to where the ring leaves each box (+10px)
	const exitAngle = (p, dir) => {
		for (let t = 0; t < Math.PI; t += 0.004) {
			const a = p.a + dir * t;
			const x = R * Math.cos(a), y = R * Math.sin(a);
			if (Math.abs(x - p.x) > boxW / 2 + 10 || Math.abs(y - p.y) > boxH / 2 + 10) return t;
		}
		return 0.3;
	};
	const arcs = [];
	pos.forEach((p, i) => {
		const q = pos[(i + 1) % n];
		const a0 = p.a + exitAngle(p, 1),
			a1 = (i + 1 === n ? q.a + 2 * Math.PI : q.a) - exitAngle(q, -1);
		const s = { x: R * Math.cos(a0), y: R * Math.sin(a0) };
		const e = { x: R * Math.cos(a1), y: R * Math.sin(a1) };
		const d = `M${s.x.toFixed(1)},${s.y.toFixed(1)} A${R},${R} 0 0 1 ${e.x.toFixed(1)},${
			e.y.toFixed(1)
		}`;
		const tang = { x: -Math.sin(a1), y: Math.cos(a1) };
		const px = -tang.y, py = tang.x;
		const head = `M${e.x},${e.y} L${e.x - tang.x * 8 + px * 3.2},${e.y - tang.y * 8 + py * 3.2} L${
			e.x - tang.x * 8 - px * 3.2
		},${e.y - tang.y * 8 - py * 3.2} Z`;
		const st = stepOf(i, n) + 1;
		arcs.push(
			el("g", {
				class: `sc-edge ek-${steps[i].focal || steps[(i + 1) % n].focal ? "primary" : "default"}`,
				"data-sc-edge": `a${i}`,
				"data-from": steps[i].id,
				"data-to": steps[(i + 1) % n].id,
				"data-sc-step": st,
				style: `--step:${st}`,
			}, [
				el("path", { class: "e-line sc-draw", d, pathLength: 1 }),
				el("path", { class: "e-head m-default", d: head }),
			]),
		);
	});
	const boxes = steps.map((s, i) => {
		const p = pos[i];
		const x = p.x - boxW / 2, y = p.y - boxH / 2;
		return group(`sc-node ${s.focal ? "k-focal" : "k-backend"}`, s.id, stepOf(i, n), [
			el("rect", { class: "n-mask", x, y, width: boxW, height: boxH, rx: 8 }),
			el("rect", { class: "n-box", x, y, width: boxW, height: boxH, rx: 8 }),
			labelBlock(p.x, p.y, s.label, s.sub, { maxW: boxW - 20 }),
		], { "aria-label": s.label });
	});
	const center = spec.center
		? el("g", { class: "sc-fade", "data-sc-step": 1, style: "--step:0" }, [
			text({ class: "loop-center", x: 0, y: 4, "text-anchor": "middle" }, spec.center),
			spec.centerSub
				? text({ class: "n-sub", x: 0, y: 22, "text-anchor": "middle" }, spec.centerSub)
				: "",
		])
		: "";
	const full = `M0,${-R} A${R},${R} 0 1 1 0,${R} A${R},${R} 0 1 1 0,${-R}`;
	const token = el("circle", {
		class: "e-token",
		r: 3.4,
		"data-sc-step": 12,
		style: `--step:${stepOf(n - 1, n) + 1};offset-path:path('${full}');--tok-dur:${
			Math.round(n * 1100)
		}ms`,
	});
	const pad = boxW / 2 + 32;
	return {
		body: el("g", { class: "sc-edges" }, arcs) + token + center
			+ el("g", { class: "sc-nodes" }, boxes),
		viewBox: [-R - pad, -R - boxH / 2 - 32, 2 * (R + pad), 2 * R + boxH + 64],
		steps: stepOf(n - 1, n) + 1,
		problems,
		graph: {
			nodes: steps.map((s) => ({ id: s.id, label: s.label })),
			edges: steps.map((s, i) => ({ id: `a${i}`, from: s.id, to: steps[(i + 1) % n].id })),
		},
	};
}
