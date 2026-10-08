// Fishbone (Ishikawa): effect at the head, category bones alternate above and
// below the spine, causes hang off each bone. Motion: spine → bones → causes.
import { el, text } from "../../svg.mjs";
import { textWidth } from "../../text.mjs";
import { group } from "./common.mjs";

export const family = "structure";

const CAUSE = { size: 10 };

export function render(spec) {
	const problems = [];
	const cats = spec.categories.map((c, i) => ({
		id: c.id || `c${i}`,
		label: c.label,
		causes: c.causes || [],
		focal: c.focal,
	}));
	if (cats.length > 6) {
		problems.push({
			code: "W_BUDGET",
			at: "categories",
			msg: `${cats.length} categories`,
			fix: "keep ≤ 6 categories (the classic 6 Ms)",
		});
	}
	if (cats.some((c) => c.causes.length > 4)) {
		problems.push({
			code: "W_BUDGET",
			at: "categories",
			msg: "a category has > 4 causes",
			fix: "keep the top 4 causes per bone",
		});
	}
	const perSide = Math.ceil(cats.length / 2);
	const boneH = 150;
	const causeW = Math.max(
		120,
		...cats.flatMap((c) => c.causes.map((x) => textWidth(x, CAUSE) + 16)),
	);
	const spacing = Math.max(200, causeW + 60);
	const spineLen = perSide * spacing + 60;
	const headW = Math.max(150, textWidth(spec.effect, { size: 12, weight: 600 }) + 32);
	const out = [];
	out.push(
		el("g", {
			class: "sc-edge ek-default",
			"data-sc-edge": "spine",
			"data-sc-step": 1,
			style: "--step:1",
		}, [
			el("path", { class: "e-line sc-draw fb-spine", d: `M0,0 L${spineLen},0`, pathLength: 1 }),
			el("path", {
				class: "e-head m-default",
				d: `M${spineLen + 1},0 L${spineLen - 8},-4 L${spineLen - 8},4 Z`,
			}),
		]),
	);
	out.push(group(`sc-node ${spec.focal === false ? "k-backend" : "k-focal"}`, "effect", 1, [
		el("rect", { class: "n-mask", x: spineLen + 2, y: -26, width: headW, height: 52, rx: 6 }),
		el("rect", { class: "n-box", x: spineLen + 2, y: -26, width: headW, height: 52, rx: 6 }),
		text(
			{ class: "n-label", x: spineLen + 2 + headW / 2, y: 4, "text-anchor": "middle" },
			spec.effect,
		),
	], { "aria-label": `Effect: ${spec.effect}` }));
	cats.forEach((c, i) => {
		const up = i % 2 === 0;
		const k = Math.floor(i / 2);
		const x1 = 40 + k * spacing + spacing * 0.75; // where the bone meets the spine
		const x0 = x1 - boneH * 0.55;
		const yEnd = up ? -boneH : boneH;
		const st = 2 + k;
		const parts = [
			el("path", { class: "e-line sc-draw", d: `M${x0},${yEnd} L${x1},0`, pathLength: 1 }),
		];
		parts.push(
			text({
				class: `fb-cat${c.focal ? " is-focal" : ""}`,
				x: x0,
				y: up ? yEnd - 10 : yEnd + 18,
				"text-anchor": "middle",
			}, c.label.toUpperCase()),
		);
		c.causes.forEach((cause, j) => {
			const t = (j + 1) / (c.causes.length + 1);
			const bx = x0 + (x1 - x0) * t, by = yEnd * (1 - t);
			parts.push(el("line", { class: "fb-tick", x1: bx - 16, y1: by, x2: bx, y2: by }));
			parts.push(text({ class: "fb-cause", x: bx - 20, y: by + 3.5, "text-anchor": "end" }, cause));
		});
		out.push(
			el("g", {
				class: `sc-edge sc-fade ek-${c.focal ? "primary" : "default"}`,
				"data-sc-edge": c.id,
				"data-from": c.id,
				"data-to": "effect",
				"data-sc-step": st,
				style: `--step:${st}`,
			}, parts),
		);
	});
	const minX = Math.min(-20, 40 + spacing * 0.75 - boneH * 0.55 - causeW - 24);
	return {
		body: out.join(""),
		viewBox: [minX, -boneH - 40, spineLen + headW + 40 - minX, 2 * boneH + 80],
		steps: 2 + perSide,
		problems,
		graph: { nodes: [{ id: "effect", label: spec.effect }], edges: [] },
	};
}
