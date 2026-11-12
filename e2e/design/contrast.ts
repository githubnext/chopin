import type { Page } from "@playwright/test";

/**
 * A WCAG 2.2 contrast walk over what a page draws. Every visible text node (and generated
 * `::before`/`::after` text, and a field's placeholder) is measured against the colour actually
 * composited behind it: the element's ancestors' backgrounds, each group's opacity, on the canvas.
 * Non-text parts people need to see are measured at 3:1 against what is around them: icons in
 * controls, field and composer boundaries, checkbox and switch outlines, status dots and the
 * focus ring of every focusable control. Disabled controls are exempt, as WCAG exempts them.
 *
 * The walk reads backgrounds through the DOM's ancestry, which is how Chopin draws every surface:
 * an element painted over a sibling's background, or text over a gradient or image, is listed with
 * `uncertain` set rather than guessed.
 */
export type Measured = {
	where: string;
	text: string;
	role: Role;
	fg: string;
	bg: string;
	ratio: number;
	threshold: number;
	exempt: string | null;
	uncertain: boolean;
	tokens: string[];
	classes: string;
	path: string;
	opacity?: number;
};

export type Role =
	| "text"
	| "large text"
	| "placeholder"
	| "icon in control"
	| "status icon"
	| "field boundary"
	| "checkbox or switch"
	| "status dot"
	| "focus ring";

export async function contrastWalk(
	page: Page,
	root: string,
	options: { focus?: boolean } = {},
): Promise<Measured[]> {
	return page.evaluate(walk, { root, focus: options.focus ?? true });
}

function walk({ root, focus }: { root: string; focus: boolean }): Measured[] {
	type RGBA = [number, number, number, number];

	// Colours are read once everything has arrived: a card fading in would report where it starts.
	for (let animation of document.getAnimations()) {
		if (animation.effect?.getComputedTiming().endTime === Infinity) continue;
		animation.finish();
	}

	function linear(value: number) {
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	}
	function gamma(value: number) {
		let v = Math.max(0, Math.min(1, value));
		return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
	}
	function oklabToSrgb(l: number, a: number, b: number): [number, number, number] {
		let l_ = l + 0.3963377774 * a + 0.2158037573 * b;
		let m_ = l - 0.1055613458 * a - 0.0638541728 * b;
		let s_ = l - 0.0894841775 * a - 1.291485548 * b;
		let L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
		return [
			gamma(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
			gamma(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
			gamma(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
		];
	}
	function p3ToSrgb(r: number, g: number, b: number): [number, number, number] {
		let [R, G, B] = [linear(r), linear(g), linear(b)];
		let x = 0.4865709486 * R + 0.2656676932 * G + 0.1982172852 * B;
		let y = 0.2289745641 * R + 0.6917385218 * G + 0.0792869141 * B;
		let z = 0.0451133819 * G + 1.0439443689 * B;
		return [
			gamma(3.2409699419 * x - 1.5373831776 * y - 0.4986107603 * z),
			gamma(-0.9692436363 * x + 1.8759675015 * y + 0.0415550574 * z),
			gamma(0.0556300797 * x - 0.2039769589 * y + 1.0569715142 * z),
		];
	}
	function labToSrgb(L: number, a: number, b: number): [number, number, number] {
		let fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
		let f = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (116 * t - 16) / 903.3);
		// D50 white, then Bradford to D65.
		let X = f(fx) * 0.96422, Y = f(fy), Z = f(fz) * 0.82521;
		let x = 0.9554734527 * X - 0.0230985368 * Y + 0.0632593086 * Z;
		let y = -0.0283697093 * X + 1.0099954580 * Y + 0.0210413990 * Z;
		let z = 0.0123140016 * X - 0.0205076964 * Y + 1.3303659366 * Z;
		return [
			gamma(3.2409699419 * x - 1.5373831776 * y - 0.4986107603 * z),
			gamma(-0.9692436363 * x + 1.8759675015 * y + 0.0415550574 * z),
			gamma(0.0556300797 * x - 0.2039769589 * y + 1.0569715142 * z),
		];
	}
	function parse(value: string): RGBA | null {
		let text = value.trim();
		if (text === "transparent") return [0, 0, 0, 0];
		let match = /^([a-z-]+)\((.*)\)$/.exec(text);
		if (!match) return null;
		let [, fn, body] = match;
		let [main, alphaPart] = body!.split("/").map(part => part.trim());
		let parts = main!.replace(/,/g, " ").split(/\s+/).filter(Boolean);
		let alpha = 1;
		let number = (part: string, scale = 1) =>
			part === "none"
				? 0
				: part.endsWith("%")
				? (parseFloat(part) / 100) * scale
				: parseFloat(part);
		if (fn === "rgb" || fn === "rgba") {
			if (parts.length === 4) alpha = number(parts[3]!);
			if (alphaPart) alpha = number(alphaPart);
			return [
				number(parts[0]!, 255) / 255,
				number(parts[1]!, 255) / 255,
				number(parts[2]!, 255) / 255,
				alpha,
			];
		}
		if (alphaPart) alpha = number(alphaPart);
		if (fn === "oklch") {
			let l = number(parts[0]!),
				c = number(parts[1]!, 0.4),
				h = (number(parts[2]!) * Math.PI) / 180;
			return [...oklabToSrgb(l, c * Math.cos(h), c * Math.sin(h)), alpha];
		}
		if (fn === "oklab") {
			return [
				...oklabToSrgb(number(parts[0]!), number(parts[1]!, 0.4), number(parts[2]!, 0.4)),
				alpha,
			];
		}
		if (fn === "lab") {
			return [
				...labToSrgb(number(parts[0]!, 100), number(parts[1]!, 125), number(parts[2]!, 125)),
				alpha,
			];
		}
		if (fn === "lch") {
			let c = number(parts[1]!, 150), h = (number(parts[2]!) * Math.PI) / 180;
			return [...labToSrgb(number(parts[0]!, 100), c * Math.cos(h), c * Math.sin(h)), alpha];
		}
		if (fn === "color") {
			let [space, ...rest] = parts;
			let [r, g, b] = rest.map(part => number(part));
			if (space === "srgb") return [r!, g!, b!, alpha];
			if (space === "srgb-linear") return [gamma(r!), gamma(g!), gamma(b!), alpha];
			if (space === "display-p3") return [...p3ToSrgb(r!, g!, b!), alpha];
		}
		return null;
	}
	function over(top: RGBA, under: RGBA): RGBA {
		let a = top[3] + under[3] * (1 - top[3]);
		if (a === 0) return [0, 0, 0, 0];
		let mix = (i: number) => (top[i]! * top[3] + under[i]! * under[3] * (1 - top[3])) / a;
		return [mix(0), mix(1), mix(2), a];
	}
	function luminance([r, g, b]: RGBA) {
		return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
	}
	function ratio(a: RGBA, b: RGBA) {
		let [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
		return (x! + 0.05) / (y! + 0.05);
	}
	function hex([r, g, b]: RGBA) {
		return "#"
			+ [r, g, b].map(v =>
				Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")
			).join("");
	}
	function describe(color: RGBA) {
		return color[3] < 0.999 ? `${hex(color)}/${Math.round(color[3] * 100)}%` : hex(color);
	}

	// Which tokens draw a colour: every `--color-*` on the root, by its sRGB value and alpha.
	let tokens = new Map<string, string[]>();
	let rootStyle = getComputedStyle(document.documentElement);
	let probe = document.createElement("i");
	document.body.append(probe);
	for (let sheet of document.styleSheets) {
		let rules: CSSRule[] = [];
		try {
			rules = [...sheet.cssRules];
		} catch {
			continue;
		}
		let queue = rules;
		while (queue.length) {
			let rule = queue.shift()!;
			if ("cssRules" in rule) queue.push(...(rule as CSSGroupingRule).cssRules);
			if (!(rule instanceof CSSStyleRule)) continue;
			for (let name of rule.style) {
				if (!name.startsWith("--color-") && name !== "--focus-ring-color") continue;
				if (tokens.has(name)) continue;
				tokens.set(name, []);
			}
		}
	}
	let byColour = new Map<string, string[]>();
	for (let name of tokens.keys()) {
		let value = rootStyle.getPropertyValue(name).trim();
		if (!value) continue;
		probe.style.color = value;
		let parsed = parse(getComputedStyle(probe).color);
		if (!parsed) continue;
		let key = describe(parsed);
		byColour.set(key, [...(byColour.get(key) ?? []), name]);
	}
	probe.remove();

	function parentOf(element: Element): Element | null {
		if (element.parentElement) return element.parentElement;
		let host = (element.parentNode as ShadowRoot | null)?.host;
		return host ?? null;
	}
	function chain(element: Element) {
		let list: Element[] = [];
		for (let at: Element | null = element; at; at = parentOf(at)) list.unshift(at);
		return list;
	}
	let uncertain = false;
	// Paints one pixel through the chain, root first: each element's background over what is behind
	// it, its content inside it, and the whole group faded by its opacity over that backdrop.
	function paint(list: Element[], top: RGBA | null, skipOwnBackground = false): RGBA {
		let backdrop: RGBA = [1, 1, 1, 1];
		let group = (index: number, under: RGBA): RGBA => {
			let element = list[index]!;
			let style = getComputedStyle(element);
			let inner = under;
			let last = index === list.length - 1;
			if (!(last && skipOwnBackground)) {
				let fill = parse(style.backgroundColor);
				if (fill && fill[3] > 0) inner = over(fill, inner);
				if (style.backgroundImage !== "none" && !style.backgroundImage.startsWith("url(")) {
					uncertain = true;
				}
				if (style.backgroundImage.startsWith("url(")) uncertain = true;
			}
			inner = last ? (top ? over(top, inner) : inner) : group(index + 1, inner);
			let opacity = parseFloat(style.opacity);
			if (opacity >= 1) return inner;
			return [0, 1, 2].map(i => inner[i]! * opacity + under[i]! * (1 - opacity)).concat(1) as RGBA;
		};
		return group(0, backdrop);
	}
	function measurePair(list: Element[], fg: RGBA, skipOwnBackground = false) {
		uncertain = false;
		let front = paint(list, fg, skipOwnBackground);
		let back = paint(list, null, skipOwnBackground);
		return { front, back, ratio: ratio(front, back), uncertain };
	}

	function visible(element: Element) {
		if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
		let box = element.getBoundingClientRect();
		if (box.width < 2 || box.height < 2) return false;
		// Visually hidden text: clipped to nothing by itself or an ancestor.
		for (let at: Element | null = element; at; at = parentOf(at)) {
			let style = getComputedStyle(at);
			if (style.clip === "rect(0px, 0px, 0px, 0px)" || style.clipPath === "inset(50%)") {
				return false;
			}
			let rect = at.getBoundingClientRect();
			if (style.overflow !== "visible" && (rect.width < 2 || rect.height < 2)) return false;
		}
		return true;
	}
	function disabled(element: Element) {
		return !!element.closest(
			'[disabled], [aria-disabled="true"], [data-disabled], [data-audit-state="disabled"], [inert]',
		) || (element instanceof HTMLElement && element.matches(":disabled"));
	}
	function path(element: Element) {
		let parts: string[] = [];
		for (let at: Element | null = element; at && parts.length < 5; at = parentOf(at)) {
			let name = at.localName;
			let slot = at.getAttribute("data-slot");
			let id = at.getAttribute("data-audit-item") ?? at.getAttribute("data-audit-sample");
			let cls = typeof at.className === "string"
				? at.className.split(/\s+/).filter(Boolean)[0]
				: "";
			parts.unshift(
				name + (slot ? `[data-slot=${slot}]` : "") + (id ? `[${id}]` : "")
					+ (cls && !slot ? `.${cls}` : ""),
			);
			if (id) break;
		}
		return parts.join(" > ");
	}
	function where(element: Element) {
		let item = element.closest("[data-audit-item]")?.getAttribute("data-audit-item")
			?? (parentOf(element)
				? (element.getRootNode() as ShadowRoot).host?.closest?.("[data-audit-item]")?.getAttribute(
					"data-audit-item",
				)
				: null);
		let state = element.closest("[data-audit-state]")?.getAttribute("data-audit-state");
		return (item ?? "page") + (state ? `:${state}` : "");
	}
	function classesOf(element: Element) {
		let list: string[] = [];
		for (let at: Element | null = element; at && list.length < 3; at = parentOf(at)) {
			if (typeof at.className === "string" && at.className.trim()) list.push(at.className.trim());
		}
		return list.join(" | ").slice(0, 240);
	}

	let results: Measured[] = [];
	function record(
		element: Element,
		text: string,
		role: Role,
		fg: RGBA,
		threshold: number,
		options: { skipOwnBackground?: boolean; list?: Element[] } = {},
	) {
		let list = options.list ?? chain(element);
		let pair = measurePair(list, fg, options.skipOwnBackground);
		// Punctuation hidden from assistive technology (a breadcrumb's slash) is decoration.
		let decoration = /text/.test(role) && !/[\p{L}\p{N}]/u.test(text)
			&& !!element.closest('[aria-hidden="true"]');
		results.push({
			where: where(element),
			text: text.replace(/\s+/g, " ").trim().slice(0, 60),
			role,
			fg: describe(fg),
			bg: describe(pair.back),
			ratio: Math.round(pair.ratio * 100) / 100,
			threshold,
			exempt: disabled(element) ? "disabled" : decoration ? "decoration" : null,
			uncertain: pair.uncertain,
			tokens: byColour.get(describe(fg)) ?? [],
			classes: classesOf(element),
			path: path(element),
			opacity: Math.round(
				list.reduce((product, at) => product * parseFloat(getComputedStyle(at).opacity), 1) * 100,
			) / 100,
		});
	}
	function large(style: CSSStyleDeclaration) {
		let size = parseFloat(style.fontSize);
		let weight = parseInt(style.fontWeight, 10);
		return size >= 24 || (size >= 18.66 && weight >= 700);
	}

	let roots: ParentNode[] = [...document.querySelectorAll(root)];
	let elements: Element[] = [];
	while (roots.length) {
		let next = roots.shift()!;
		for (let element of next.querySelectorAll("*")) {
			elements.push(element);
			if (element.shadowRoot) roots.push(element.shadowRoot);
		}
		if (next instanceof Element) elements.unshift(next);
	}

	for (let element of elements) {
		if (element.closest("svg") && element.localName !== "svg") continue;
		let style = getComputedStyle(element);
		// Text: each element's own direct text, so a node is measured once in its own colour.
		let own = [...element.childNodes]
			.filter(node => node.nodeType === Node.TEXT_NODE)
			.map(node => node.textContent ?? "")
			.join("");
		if (/[\p{L}\p{N}\p{P}\p{S}]/u.test(own) && visible(element)) {
			// A run of emoji alone is a picture, not text: a picked reaction or a picker cell.
			if (
				!/^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\s)+$/u.test(own.trim())
			) {
				let fg = parse(style.color);
				if (fg) {
					let isLarge = large(style);
					record(element, own, isLarge ? "large text" : "text", fg, isLarge ? 3 : 4.5);
				}
			}
		}
		for (let pseudo of ["::before", "::after"] as const) {
			let generated = getComputedStyle(element, pseudo);
			let content = generated.content;
			if (!content || content === "none" || content === "normal") continue;
			let text = content.replace(/^"|"$/g, "");
			if (content.startsWith("attr(")) text = element.getAttribute(content.slice(5, -1)) ?? "";
			if (!/[\p{L}\p{N}]/u.test(text) || !visible(element)) continue;
			if (generated.display === "none" || generated.visibility === "hidden") continue;
			let fg = parse(generated.color);
			if (!fg) continue;
			let opacity = parseFloat(generated.opacity);
			if (opacity < 1) fg = [fg[0], fg[1], fg[2], fg[3] * opacity];
			let placeholder = /placeholder/i.test(content + (element.className ?? ""))
				|| element.matches("[data-placeholder], .is-empty, .is-editor-empty");
			record(
				element,
				text,
				placeholder ? "placeholder" : large(generated) ? "large text" : "text",
				fg,
				placeholder ? 4.5 : large(generated) ? 3 : 4.5,
			);
		}
		if (
			(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
			&& element.placeholder && !element.value && visible(element)
		) {
			let fg = parse(getComputedStyle(element, "::placeholder").color);
			if (fg) record(element, element.placeholder, "placeholder", fg, 4.5);
		}
	}

	// Non-text: icons in controls and status icons.
	let control =
		'button, a[href], [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"], [role="option"], [role="switch"], [role="checkbox"], summary, label';
	for (let svg of elements.filter(element => element.localName === "svg")) {
		if (svg.parentElement?.closest("svg")) continue;
		if (!visible(svg)) continue;
		let box = svg.getBoundingClientRect();
		if (box.width < 6 || box.height < 6) continue;
		// Drawings in authored content (diagrams, charts) and pictures are not interface icons.
		if (
			svg.closest(
				".plan-diagram, [data-plan-diagram], .katex, figure, img, [data-audit-item='diagram'], [data-audit-item='sparkline'], [data-audit-item='mini-bars'], [data-audit-item='icons']",
			)
		) continue;
		// An icon is seen by its strongest mark: a progress ring's arc, not its track.
		let list = chain(svg);
		let fg: RGBA | null = null;
		let best = 0;
		for (
			let shape of svg.querySelectorAll(
				"path, circle, rect, line, polyline, polygon, ellipse, use, text",
			)
		) {
			let shapeStyle = getComputedStyle(shape);
			if (shapeStyle.display === "none" || shapeStyle.visibility === "hidden") continue;
			let opacity = parseFloat(shapeStyle.opacity || "1");
			for (
				let [paintValue, paintOpacity] of [[shapeStyle.stroke, shapeStyle.strokeOpacity], [
					shapeStyle.fill,
					shapeStyle.fillOpacity,
				]]
			) {
				if (!paintValue || paintValue === "none") continue;
				let colour = parse(paintValue);
				if (!colour || colour[3] === 0) continue;
				let candidate: RGBA = [
					colour[0],
					colour[1],
					colour[2],
					colour[3] * opacity * parseFloat(paintOpacity || "1"),
				];
				let measured = measurePair(list, candidate).ratio;
				if (measured > best) [best, fg] = [measured, candidate];
			}
		}
		if (!fg) continue;
		let host = svg.closest(control);
		if (host) {
			record(
				svg,
				host.getAttribute("aria-label") ?? host.textContent ?? "",
				"icon in control",
				fg,
				3,
				{ list },
			);
		} else {record(
				svg,
				svg.getAttribute("aria-label") ?? (svg.parentElement?.textContent ?? ""),
				"status icon",
				fg,
				3,
				{ list },
			);}
	}

	// Edges: the colour of a box drawn around an element, by a border on all four sides, an outline
	// or a ring drawn as a shadow. A single rule (a divider under a row) is no box.
	function edge(element: Element, pseudo?: "::before"): RGBA | null {
		let style = getComputedStyle(element, pseudo);
		if (pseudo && (style.content === "none" || style.content === "normal")) return null;
		let sides = ["top", "bottom", "left", "right"].map(side => ({
			width: parseFloat(style.getPropertyValue(`border-${side}-width`)),
			kind: style.getPropertyValue(`border-${side}-style`),
			colour: parse(style.getPropertyValue(`border-${side}-color`)),
		}));
		if (
			sides.every(side => side.width > 0 && side.kind !== "none" && (side.colour?.[3] ?? 0) > 0)
		) {
			return sides[0]!.colour;
		}
		if (!pseudo && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) {
			let colour = parse(style.outlineColor);
			if (colour && colour[3] > 0) return colour;
		}
		let shadow = style.boxShadow;
		if (shadow && shadow !== "none") {
			for (let part of shadow.split(/,(?![^(]*\))/)) {
				let colourText = /(?:rgba?|oklch|oklab|color|lab|lch)\([^)]*\)/.exec(part)?.[0];
				let lengths = part.replace(colourText ?? "", "").replace("inset", "").trim().split(/\s+/)
					.map(parseFloat);
				// x, y, blur, spread: a ring has no offset or blur and some spread.
				if (
					lengths.length >= 4 && lengths[0] === 0 && lengths[1] === 0 && lengths[2] === 0
					&& lengths[3]! > 0
				) {
					let colour = colourText ? parse(colourText) : null;
					if (colour && colour[3] > 0) return colour;
				}
			}
		}
		return null;
	}
	function boundary(element: Element, label: string, role: Role) {
		// A checkbox or radio the browser draws keeps the platform's own edge.
		if (
			element.matches('input:is([type="checkbox"], [type="radio"])')
			&& getComputedStyle(element).appearance !== "none"
		) return;
		// The edge is drawn by the field itself or the first of its three nearest ancestors that draws
		// one, on the box or on a `::before` laid over its border (the composer's own edge layer).
		let owner: Element | null = element;
		let colour: RGBA | null = null;
		for (let depth = 0; owner && depth < 4; depth++, owner = parentOf(owner)) {
			colour = edge(owner) ?? edge(owner, "::before");
			if (colour) break;
			let fill = parse(getComputedStyle(owner).backgroundColor);
			if (fill && fill[3] > 0.5) break;
		}
		owner ??= element;
		// MDXEditor draws a task list's checkbox on the item's `::before`.
		let ownBefore = !colour && role === "checkbox or switch" ? edge(element, "::before") : null;
		if (ownBefore) [owner, colour] = [element, ownBefore];
		let fill = parse(getComputedStyle(owner).backgroundColor) ?? [0, 0, 0, 0];
		// A field with no box of its own (a palette's search row) is found by its words and icon.
		if (!colour && (owner !== element || fill[3] === 0)) return;
		let outside = chain(owner).slice(0, -1);
		// Either the edge or the fill can mark the field out from what surrounds it.
		let edgeRatio = colour ? measurePair(outside.concat(owner), colour, true) : null;
		let fillRatio = measurePair(outside, fill);
		let best = !edgeRatio || fillRatio.ratio > edgeRatio.ratio
			? { colour: fill, pair: fillRatio }
			: { colour: colour!, pair: edgeRatio };
		results.push({
			where: where(element),
			text: label.replace(/\s+/g, " ").trim().slice(0, 60),
			role,
			fg: describe(best.colour),
			bg: describe(best.pair.back),
			ratio: Math.round(best.pair.ratio * 100) / 100,
			threshold: 3,
			exempt: disabled(element) ? "disabled" : null,
			uncertain: best.pair.uncertain,
			tokens: byColour.get(describe(best.colour)) ?? [],
			classes: classesOf(owner),
			path: path(owner),
		});
	}
	for (let element of elements) {
		if (!visible(element)) continue;
		let label = element.getAttribute("aria-label") ?? element.getAttribute("placeholder")
			?? element.getAttribute("name") ?? element.localName;
		if (
			element.matches(
				'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="switch"], [role="radio"]',
			)
		) {
			boundary(element, label, "checkbox or switch");
		} else if (
			element.matches(
				'input:not([type="hidden"], [type="button"], [type="submit"], [type="range"], [type="file"]), textarea, select, [role="textbox"], [role="combobox"]:not(button), [contenteditable="true"]:not([contenteditable="true"] *)',
			)
		) {
			// The document itself is the page, not a field drawn on it.
			if (element.matches(".plan-content")) continue;
			boundary(element, label, "field boundary");
		}
		// Status dots: a small round filled shape with no text.
		let box = element.getBoundingClientRect();
		if (
			box.width >= 4 && box.width <= 14 && Math.abs(box.width - box.height) < 1
			&& !element.textContent?.trim() && element.localName !== "svg" && !element.closest("svg")
			&& !element.querySelector("img, video, canvas, svg")
		) {
			let style = getComputedStyle(element);
			let fill = parse(style.backgroundColor);
			if (fill && fill[3] > 0.5 && parseFloat(style.borderTopLeftRadius) >= box.width / 2 - 1) {
				record(
					element,
					element.getAttribute("aria-label") ?? element.parentElement?.getAttribute("aria-label")
						?? "dot",
					"status dot",
					fill,
					3,
					{ list: chain(element), skipOwnBackground: true },
				);
			}
		}
	}

	// Focus rings: focus each control as a keyboard would, and measure what focus changed: an
	// outline, a ring drawn as a shadow, or a border that darkens on the control or the box around it.
	function marks(element: Element): string[] {
		let style = getComputedStyle(element);
		let list: string[] = [];
		if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) {
			list.push(style.outlineColor);
		}
		if (style.boxShadow !== "none") {
			for (let part of style.boxShadow.split(/,(?![^(]*\))/)) {
				let colourText = /(?:rgba?|oklch|oklab|color|lab|lch)\([^)]*\)/.exec(part)?.[0];
				if (colourText) list.push(colourText);
			}
		}
		if (parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none") {
			list.push(style.borderTopColor);
		}
		return list.filter(text => (parse(text)?.[3] ?? 0) > 0);
	}
	if (focus) {
		let previous = document.activeElement as HTMLElement | null;
		// Chopin draws a ring only for focus a keyboard moved (`useFocusInput`); say a key moved it.
		let input = document.documentElement.dataset.focusInput;
		document.documentElement.dataset.focusInput = "keyboard";
		for (let element of elements) {
			if (!(element instanceof HTMLElement)) continue;
			if (
				!element.matches(
					'button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]',
				)
			) continue;
			if (disabled(element) || !visible(element)) continue;
			// The document's own editor shows focus by its caret, as a page does.
			if (element.matches(".plan-content")) continue;
			let owners: Element[] = [];
			for (let at: Element | null = element; at && owners.length < 4; at = parentOf(at)) {
				owners.push(at);
			}
			// A specimen held in its hover, press or focus state already draws it.
			let held = element.closest("[data-audit-state]")?.getAttribute("data-audit-state");
			if ((held && held !== "default") || element.closest("[data-force-state]")) continue;
			// Read each state once it has settled: a transition would report where it starts.
			let settle = () => {
				for (let owner of owners) for (let animation of owner.getAnimations()) animation.finish();
			};
			(document.activeElement as HTMLElement | null)?.blur();
			settle();
			let rest = owners.map(marks);
			element.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
			if (document.activeElement !== element) continue;
			settle();
			let label = (element.getAttribute("aria-label") ?? element.textContent ?? element.localName)
				.replace(/\s+/g, " ").trim().slice(0, 60);
			let best:
				| { ratio: number; ring: RGBA; back: RGBA; uncertain: boolean; owner: Element }
				| null = null;
			owners.forEach((owner, index) => {
				let unfocused = new Set(rest[index]!);
				for (let text of marks(owner)) {
					if (unfocused.has(text)) continue;
					let ring = parse(text)!;
					let pair = measurePair(chain(owner).slice(0, -1), ring);
					if (!best || pair.ratio > best.ratio) {
						best = { ratio: pair.ratio, ring, back: pair.back, uncertain: pair.uncertain, owner };
					}
				}
			});
			let found = best as {
				ratio: number;
				ring: RGBA;
				back: RGBA;
				uncertain: boolean;
				owner: Element;
			} | null;
			results.push({
				where: where(element),
				text: label,
				role: "focus ring",
				fg: found ? describe(found.ring) : "none",
				bg: found ? describe(found.back) : "",
				ratio: found ? Math.round(found.ratio * 100) / 100 : 0,
				threshold: 3,
				exempt: null,
				uncertain: found?.uncertain ?? false,
				tokens: found ? byColour.get(describe(found.ring)) ?? [] : [],
				classes: classesOf(element),
				path: path(element),
			});
		}
		(document.activeElement as HTMLElement | null)?.blur();
		previous?.focus?.({ preventScroll: true });
		if (input) document.documentElement.dataset.focusInput = input;
		else delete document.documentElement.dataset.focusInput;
	}
	return results;
}
