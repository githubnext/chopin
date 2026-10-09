// Node box sizing + drawing shared by graph, tree and lane renderers.
// Shapes: box (default), decision, terminal, io, store, state, start, end,
// entity (ER / db-schema table), class (UML compartments).
import { el, text } from "../../svg.mjs";
import { ceil4, textWidth, wrap } from "../../text.mjs";
import { DIAGRAM_TYPE, LABEL_BOX } from "../../tokens.mjs";

const LABEL = DIAGRAM_TYPE.label;
const SUB = DIAGRAM_TYPE.sub;
const TAG = DIAGRAM_TYPE.tag;
const FIELD = { ...SUB, mono: false, fontFamily: LABEL.fontFamily };
const FTYPE = SUB;
const ROW_H = SUB.lineHeight + LABEL_BOX.tableRowPaddingBlock * 2;
const HEAD_H = LABEL.lineHeight + LABEL_BOX.tablePaddingBlock * 2;

export const MIN_W = 112;
export const MAX_W = 220;
export const POINT_SHAPES = new Set(["decision", "start", "end"]);

export function normalizeKind(n) {
	if (n.focal) return "focal";
	return n.kind || "backend";
}

// "user_id FK uuid" | "email: text UQ" | ["id","uuid","PK"] → {name,type,key}
export function parseField(f) {
	if (Array.isArray(f)) {
		return {
			name: String(f[0]),
			type: f[1] ? String(f[1]) : "",
			key: f[2] ? String(f[2]).toUpperCase() : "",
		};
	}
	const toks = String(f).replace(":", " ").split(/\s+/).filter(Boolean);
	const keys = toks.filter((t) => /^(PK|FK|UQ|NN|IDX)$/i.test(t)).map((t) => t.toUpperCase());
	const rest = toks.filter((t) => !/^(PK|FK|UQ|NN|IDX)$/i.test(t));
	return { name: rest[0] || "", type: rest.slice(1).join(" "), key: keys.join(" ") };
}

function tableRows(n) {
	if (n.shape === "class") {
		const attrs = (n.attrs || []).map((a) => ({ text: String(a) }));
		const methods = (n.methods || []).map((m) => ({ text: String(m) }));
		return { sections: [attrs, methods] };
	}
	return { sections: [(n.fields || []).map(parseField)] };
}

// Measure a node: sets n.w, n.h, n.lines (wrapped label lines).
export function sizeNode(n, { minW = MIN_W, maxW = MAX_W } = {}) {
	const shape = n.shape || "box";
	if (shape === "start" || shape === "end") {
		n.w = n.h = shape === "start" ? 20 : 24;
		n.lines = [];
		return n;
	}
	if (shape === "entity" || shape === "class") {
		const { sections } = tableRows(n);
		n.sections = sections;
		let inner = shape === "class"
			? Math.max(textWidth(n.label, LABEL), n.tag ? textWidth(n.tag, TAG) : 0)
			: textWidth(n.label, LABEL) + (n.tag ? textWidth(n.tag, TAG) + 24 : 0);
		for (const s of sections) {
			for (const r of s) {
				const w = r.text !== undefined
					? textWidth(r.text, FTYPE)
					: (r.key ? 24 : 0) + textWidth(r.name, FIELD)
						+ (r.type ? textWidth(r.type, FTYPE) + 18 : 0);
				inner = Math.max(inner, w);
			}
		}
		n.headH = shape === "class" && n.tag ? HEAD_H + TAG.lineHeight : HEAD_H;

		n.w = ceil4(Math.max(minW + 16, inner + 28));
		const rows = sections.reduce(
			(s, sec) => s + Math.max(sec.length, shape === "class" ? 1 : 0),
			0,
		);
		n.h = n.headH + rows * ROW_H + (sections.length - 1) * 6 + (rows ? 8 : 0);
		n.lines = [n.label];
		return n;
	}
	const lw = textWidth(n.label, LABEL);
	let lines = [n.label];
	let inner = lw;
	if (lw > maxW - LABEL_BOX.paddingInline * 2) {
		lines = wrap(n.label, maxW - LABEL_BOX.paddingInline * 2, LABEL).slice(0, 2);
		inner = Math.max(...lines.map((l) => textWidth(l, LABEL)));
	}
	const sw = n.sub ? textWidth(n.sub, SUB) : 0;
	const tw = n.tag ? textWidth(n.tag, TAG) + LABEL_BOX.badgePaddingInline * 2 : 0;
	inner = Math.max(inner, sw, tw ? tw + LABEL_BOX.tagInset * 2 - LABEL_BOX.paddingInline * 2 : 0);
	let w = ceil4(Math.max(minW, inner + LABEL_BOX.paddingInline * 2));
	const contentHeight = lines.length * LABEL.lineHeight
		+ (n.sub ? LABEL_BOX.detailGap + SUB.lineHeight : 0);
	const tagHeight = n.tag ? TAG.lineHeight + LABEL_BOX.badgePaddingBlock * 2 + LABEL_BOX.tagGap : 0;
	let h = contentHeight + tagHeight + LABEL_BOX.paddingBlock * 2;
	if (shape === "decision") {
		w = ceil4(Math.max(128, inner * 1.5 + 40));
		h = ceil4(Math.max(72, w * 0.5, h));
	} else if (shape === "terminal") {
		w = ceil4(Math.max(96, inner + 40));
	} else if (shape === "io") {
		w = ceil4(Math.max(minW, inner + 48));
	} else if (shape === "state") {
		w = ceil4(Math.max(96, inner + 36));
	}
	n.w = w;
	n.h = h;
	n.lines = lines;
	return n;
}

// y (absolute) of a named field row in an entity/class node, or null.
export function fieldY(n, name) {
	if (!n.sections) return null;
	let y = n.y + n.headH + 4;
	for (const sec of n.sections) {
		for (const r of sec) {
			if ((r.name || r.text) === name || (r.text && r.text.split(/[\s:(]/)[0] === name)) {
				return y + ROW_H / 2;
			}
			y += ROW_H;
		}
		y += 6;
	}
	return null;
}

function outline(n, cls) {
	const { x, y, w, h } = n;
	switch (n.shape) {
		case "decision":
			return el("path", {
				class: cls,
				d: `M${x + w / 2},${y} L${x + w},${y + h / 2} L${x + w / 2},${y + h} L${x},${y + h / 2} Z`,
			});
		case "terminal":
			return el("rect", { class: cls, x, y, width: w, height: h, rx: h / 2 });
		case "io":
			return el("path", {
				class: cls,
				d: `M${x + 10},${y} L${x + w},${y} L${x + w - 10},${y + h} L${x},${y + h} Z`,
			});
		case "state":
			return el("rect", { class: cls, x, y, width: w, height: h, rx: 14 });
		case "start":
		case "end":
			return el("circle", { class: cls, cx: x + w / 2, cy: y + h / 2, r: w / 2 });
		default:
			return el("rect", { class: cls, x, y, width: w, height: h, rx: 6 });
	}
}

function drawTable(n, parts) {
	const { x, y, w } = n;
	const H = n.headH;
	parts.push(
		el("rect", { class: "n-head", x: x + 0.5, y: y + 0.5, width: w - 1, height: H - 0.5, rx: 5.5 }),
	);
	parts.push(el("line", { class: "n-rule", x1: x, y1: y + H, x2: x + w, y2: y + H }));
	if (n.shape === "class") {
		if (n.tag) {
			parts.push(
				text({
					class: "n-tag",
					x: x + w / 2,
					y: y + LABEL_BOX.tablePaddingBlock + TAG.lineHeight / 2,
					"dominant-baseline": "central",
					"text-anchor": "middle",
					style: "text-transform:none",
				}, n.tag),
			);
		}
		parts.push(
			text({
				class: "n-label",
				x: x + w / 2,
				y: y + H - LABEL_BOX.tablePaddingBlock - LABEL.lineHeight / 2,
				"text-anchor": "middle",
				"dominant-baseline": "central",
			}, n.label),
		);
	} else {
		if (n.tag) {
			parts.push(
				text({
					class: "n-tag",
					x: x + LABEL_BOX.tablePaddingInline,
					y: y + H / 2,
					"dominant-baseline": "central",
				}, n.tag),
			);
		}
		const tagW = n.tag ? textWidth(n.tag, TAG) + LABEL_BOX.tagGap : 0;
		parts.push(
			text({
				class: "n-label",
				x: x + LABEL_BOX.tablePaddingInline + tagW,
				y: y + H / 2,
				"dominant-baseline": "central",
			}, n.label),
		);
	}
	let ry = y + H + 4;
	n.sections.forEach((sec, si) => {
		if (si > 0) {
			parts.push(el("line", { class: "n-rule", x1: x, y1: ry + 2, x2: x + w, y2: ry + 2 }));
			ry += 6;
		}
		if (!sec.length && n.shape === "class") ry += ROW_H;
		for (const r of sec) {
			const base = ry + ROW_H / 2;
			if (r.text !== undefined) {
				parts.push(
					text({
						class: "n-field-t",
						x: x + LABEL_BOX.tablePaddingInline,
						y: base,
						"dominant-baseline": "central",
					}, r.text),
				);
			} else {
				let fx = x + LABEL_BOX.tablePaddingInline;
				if (r.key) {
					const k = r.key.split(" ")[0];
					parts.push(
						text({
							class: `n-key n-key-${k.toLowerCase()}`,
							x: fx,
							y: base,
							"dominant-baseline": "central",
						}, k),
					);
					fx += 24;
				}
				parts.push(
					text({ class: "n-field", x: fx, y: base, "dominant-baseline": "central" }, r.name),
				);
				if (r.type) {
					parts.push(
						text({
							class: "n-field-t",
							x: x + w - LABEL_BOX.tablePaddingInline,
							y: base,
							"text-anchor": "end",
							"dominant-baseline": "central",
						}, r.type),
					);
				}
			}
			ry += ROW_H;
		}
	});
}

export function drawNode(n, { step, extraClass = "", attrs = {} } = {}) {
	const kind = normalizeKind(n);
	const parts = [];
	if (n.shape !== "start" && n.shape !== "end") parts.push(outline(n, "n-mask"));
	parts.push(outline(n, "n-box"));
	const cx = n.x + n.w / 2;
	if (n.shape === "end") parts.push(el("circle", { class: "n-dot", cx, cy: n.y + n.h / 2, r: 6 }));
	else if (n.shape === "start") {
		/* filled via .sh-start */
	} else if (n.shape === "entity" || n.shape === "class") {
		drawTable(n, parts);
	} else {
		let top = n.y + LABEL_BOX.paddingBlock;
		if (n.tag) {
			const tw = textWidth(n.tag, TAG) + LABEL_BOX.badgePaddingInline * 2;
			const tagHeight = TAG.lineHeight + LABEL_BOX.badgePaddingBlock * 2;
			parts.push(el("rect", {
				class: "n-tag-box",
				x: n.x + LABEL_BOX.tagInset,
				y: n.y + LABEL_BOX.tagInset,
				width: tw,
				height: tagHeight,
				rx: 2,
			}));
			parts.push(text({
				class: "n-tag",
				x: n.x + LABEL_BOX.tagInset + tw / 2,
				y: n.y + LABEL_BOX.tagInset + tagHeight / 2,
				"text-anchor": "middle",
				"dominant-baseline": "central",
			}, n.tag));
			top += tagHeight + LABEL_BOX.tagGap;
		}
		const lines = n.lines || [n.label];
		const block = lines.length * LABEL.lineHeight
			+ (n.sub ? LABEL_BOX.detailGap + SUB.lineHeight : 0);
		let y = top + (n.y + n.h - LABEL_BOX.paddingBlock - top - block) / 2;
		for (const line of lines) {
			parts.push(text({
				class: "n-label",
				x: cx,
				y: y + LABEL.lineHeight / 2,
				"text-anchor": "middle",
				"dominant-baseline": "central",
			}, line));
			y += LABEL.lineHeight;
		}
		if (n.sub) {
			parts.push(text({
				class: "n-sub",
				x: cx,
				y: y + LABEL_BOX.detailGap + SUB.lineHeight / 2,
				"text-anchor": "middle",
				"dominant-baseline": "central",
			}, n.sub));
		}
	}
	if (n.status) {
		parts.push(
			el("circle", { class: `n-status st-${n.status}`, cx: n.x + n.w - 9, cy: n.y + 9, r: 3.5 }),
		);
	}
	if (n.change === "added") {
		parts.push(
			text({ class: "n-change", x: n.x + n.w - 8, y: n.y - 5, "text-anchor": "end" }, "+ NEW"),
		);
	}
	if (n.change === "removed") {
		parts.push(
			text({ class: "n-change", x: n.x + n.w - 8, y: n.y - 5, "text-anchor": "end" }, "− REMOVED"),
		);
	}
	if (n.change === "changed") {
		parts.push(
			text({ class: "n-change", x: n.x + n.w - 8, y: n.y - 5, "text-anchor": "end" }, "~ CHANGED"),
		);
	}
	const cls = [
		"sc-node",
		`k-${kind}`,
		`sh-${n.shape || "box"}`,
		n.change ? `k-change ch-${n.change}` : "",
		extraClass,
	].filter(Boolean).join(" ");
	return el("g", {
		class: cls,
		"data-sc-node": n.id,
		"data-sc-step": step,
		style: step !== undefined ? `--step:${step}` : undefined,
		tabindex: 0,
		role: "group",
		"aria-label": [n.label || n.shape, n.sub].filter(Boolean).join(", "),
		...attrs,
	}, parts);
}
