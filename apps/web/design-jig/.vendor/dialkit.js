// dprint-ignore-file
/* eslint-disable */
"use strict";
var DialKit = (() => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
		for (var name in all) {
			__defProp(target, name, { get: all[name], enumerable: true });
		}
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) {
				if (!__hasOwnProp.call(to, key) && key !== except) {
					__defProp(to, key, {
						get: () => from[key],
						enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
					});
				}
			}
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

	// src/vanilla/index.ts
	var vanilla_exports = {};
	__export(vanilla_exports, {
		ButtonGroup: () => mountButtonGroup,
		ColorControl: () => mountColorControl,
		ControlRenderer: () => mountControlRenderer,
		DialPad: () => mountDialPad,
		DialRoot: () => DialRoot,
		DialStore: () => DialStore,
		DialTimeline: () => DialTimeline,
		EasingVisualization: () => mountEasingVisualization,
		Folder: () => mountFolder,
		ImageControl: () => mountImageControl,
		PresetManager: () => mountPresetManager,
		SegmentedControl: () => mountSegmentedControl,
		SelectControl: () => mountSelectControl,
		ShortcutsMenu: () => mountShortcutsMenu,
		Slider: () => mountSlider,
		SpringControl: () => mountSpringControl,
		SpringVisualization: () => mountSpringVisualization,
		TextControl: () => mountTextControl,
		TimelineStore: () => TimelineStore,
		Toggle: () => mountToggle,
		TransitionControl: () => mountTransitionControl,
		createDialKit: () => createDialKit,
		createDialKitController: () => createDialKitController,
		createDialRoot: () => createDialRoot,
		createDialTimeline: () => createDialTimeline,
		createDialTimelineRoot: () => createDialTimelineRoot,
		formatClock: () => formatClock,
		mountButtonGroup: () => mountButtonGroup,
		mountColorControl: () => mountColorControl,
		mountControlRenderer: () => mountControlRenderer,
		mountDialPad: () => mountDialPad,
		mountEasingVisualization: () => mountEasingVisualization,
		mountFolder: () => mountFolder,
		mountImageControl: () => mountImageControl,
		mountPresetManager: () => mountPresetManager,
		mountSegmentedControl: () => mountSegmentedControl,
		mountSelectControl: () => mountSelectControl,
		mountShortcutListener: () => mountShortcutListener,
		mountShortcutsMenu: () => mountShortcutsMenu,
		mountSlider: () => mountSlider,
		mountSpringControl: () => mountSpringControl,
		mountSpringVisualization: () => mountSpringVisualization,
		mountTextControl: () => mountTextControl,
		mountToggle: () => mountToggle,
		mountTransitionControl: () => mountTransitionControl,
	});

	// src/numeric.ts
	function decimalsForStep(step, min = 0, max = 0) {
		return Math.min(
			100,
			Math.max(...[step, min, max].map((value) => {
				const [coefficient, exponent = "0"] = String(value).toLowerCase().split("e");
				return Math.max(0, (coefficient.split(".")[1]?.length ?? 0) - Number(exponent));
			})),
		);
	}
	function roundValue(value, step, min, max) {
		const lower = min ?? -Infinity;
		const upper = max ?? Infinity;
		const clamped = Math.max(lower, Math.min(upper, value));
		if (clamped === lower || clamped === upper || !Number.isFinite(step) || step <= 0) {
			return clamped;
		}
		const origin = min ?? 0;
		const snapped = origin + Math.round((clamped - origin) / step) * step;
		return Math.max(lower, Math.min(upper, Number(snapped.toPrecision(14))));
	}

	// src/color.ts
	var clamp = (n, min = 0, max = 1) => Math.max(min, Math.min(max, n));
	var wrapHue = (h) => (h % 360 + 360) % 360;
	var multiply = (m, v) => m.map((row) => row.reduce((n, x, i) => n + x * v[i], 0));
	var linearize = (v) =>
		Math.abs(v) <= 0.04045 ? v / 12.92 : Math.sign(v) * ((Math.abs(v) + 0.055) / 1.055) ** 2.4;
	var encode = (v) =>
		Math.abs(v) <= 31308e-7 ? 12.92 * v : Math.sign(v) * (1.055 * Math.abs(v) ** (1 / 2.4) - 0.055);
	var RGB_XYZ = [[0.4123907993, 0.3575843394, 0.1804807884], [
		0.2126390059,
		0.7151686788,
		0.0721923154,
	], [0.0193308187, 0.1191947798, 0.9505321522]];
	var P3_XYZ = [[0.4865709486, 0.2656676932, 0.1982172852], [
		0.2289745641,
		0.6917385218,
		0.0792869141,
	], [0, 0.0451133819, 1.0439443689]];
	var XYZ_RGB = [[3.2409699419, -1.5373831776, -0.4986107603], [
		-0.9692436363,
		1.8759675015,
		0.0415550574,
	], [0.0556300797, -0.2039769589, 1.0569715142]];
	var XYZ_P3 = [[2.4934969119, -0.9313836179, -0.4027107845], [
		-0.8294889696,
		1.7626640603,
		0.0236246858,
	], [0.0358458302, -0.0761723893, 0.956884524]];
	function rgbToColor(rgb, a = 1, space = "srgb") {
		const xyz = multiply(space === "p3" ? P3_XYZ : RGB_XYZ, rgb.map(linearize));
		const [l, m, s] = multiply([[0.819022438, 0.3619062601, -0.1288737815], [
			0.0329836539,
			0.9292868616,
			0.0361446664,
		], [0.0481771894, 0.2642395318, 0.6335478285]], xyz).map(Math.cbrt);
		const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
		const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
		const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
		const c = Math.hypot(A, B);
		return {
			l: clamp(L),
			c: c < 1e-7 ? 0 : c,
			h: c < 1e-7 ? 0 : wrapHue(Math.atan2(B, A) * 180 / Math.PI),
			a: clamp(a),
		};
	}
	function colorToRgb(color, space = "srgb") {
		const a = color.c * Math.cos(color.h * Math.PI / 180);
		const b = color.c * Math.sin(color.h * Math.PI / 180);
		const lms = [
			(color.l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
			(color.l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
			(color.l - 0.0894841775 * a - 1.291485548 * b) ** 3,
		];
		const xyz = multiply([[1.2268798734, -0.5578149966, 0.2813910502], [
			-0.0405757626,
			1.1122868294,
			-0.0717110667,
		], [-0.0763729497, -0.421493324, 1.5869240244]], lms);
		return multiply(space === "p3" ? XYZ_P3 : XYZ_RGB, xyz).map(encode);
	}
	function inGamut(color, space = "srgb") {
		return colorToRgb(color, space).every((n) => n >= -1e-5 && n <= 1.00001);
	}
	function fitGamut(color, space = "srgb") {
		if (inGamut(color, space)) return color;
		let lo = 0;
		let hi = color.c;
		for (let i = 0; i < 20; i++) {
			const mid = (lo + hi) / 2;
			if (inGamut({ ...color, c: mid }, space)) lo = mid;
			else hi = mid;
		}
		return { ...color, c: lo };
	}
	function maxChroma(l, h, space = "srgb") {
		if (l <= 0 || l >= 1) return 0;
		return fitGamut({ l, c: 0.5, h, a: 1 }, space).c;
	}
	function colorFormat(value) {
		return /^oklch\(/i.test(value.trim())
			? "oklch"
			: /^color\(display-p3\s/i.test(value.trim())
			? "p3"
			: "hex";
	}
	var round = (v, digits = 4) => Number(v.toFixed(digits));
	function formatColor(color, format) {
		const alpha = color.a < 1 ? ` / ${round(color.a)}` : "";
		if (format === "oklch") {
			return `oklch(${round(color.l)} ${round(color.c)} ${round(color.h, 2)}${alpha})`;
		}
		const rgb = colorToRgb(
			fitGamut(color, format === "p3" ? "p3" : "srgb"),
			format === "p3" ? "p3" : "srgb",
		);
		if (format === "p3") {
			return `color(display-p3 ${rgb.map((n) => round(clamp(n), 5)).join(" ")}${alpha})`;
		}
		const bytes = rgb.map((n) => Math.round(clamp(n) * 255));
		if (color.a < 1) bytes.push(Math.round(color.a * 255));
		return "#" + bytes.map((n) => n.toString(16).padStart(2, "0")).join("");
	}
	var NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(%|deg|grad|rad|turn)?$/i;
	function number(value, percentScale = 1, hue = false) {
		const match = value.match(NUMBER);
		if (!match) return null;
		const n = parseFloat(value);
		if (!Number.isFinite(n)) return null;
		const unit = match[1]?.toLowerCase();
		if (hue) {
			return unit === "rad"
				? n * 180 / Math.PI
				: unit === "turn"
				? n * 360
				: unit === "grad"
				? n * 0.9
				: !unit || unit === "deg"
				? n
				: null;
		}
		return unit === "%" ? n * percentScale / 100 : !unit ? n : null;
	}
	function parseColor(value) {
		const text = value.trim().toLowerCase();
		if (text === "transparent") return { l: 0, c: 0, h: 0, a: 0 };
		if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.test(text)) {
			let hex = text.slice(1);
			if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
			const bytes = hex.match(/../g).map((c) => parseInt(c, 16) / 255);
			return rgbToColor(bytes.slice(0, 3), bytes[3] ?? 1);
		}
		const match = text.match(/^(oklch|rgb|rgba|hsl|hsla|color)\(([^()]*)\)$/);
		if (!match) return null;
		const kind = match[1];
		let body = match[2].trim();
		const p3 = kind === "color";
		if (p3) {
			if (!body.startsWith("display-p3 ")) return null;
			body = body.slice(11).trim();
		}
		const legacy = body.includes(",");
		if (legacy && (p3 || kind === "oklch" || body.includes("/"))) return null;
		const parts = legacy ? body.split(",").map((x) => x.trim()) : body.split(/\s*\/\s*/);
		if (!legacy && parts.length > 2) return null;
		const channels = legacy ? parts.slice(0, 3) : parts[0].split(/\s+/);
		if (channels.length !== 3 || legacy && parts.length !== 3 && parts.length !== 4) return null;
		if (
			legacy && kind.startsWith("rgb") && channels.some((c) => c.endsWith("%"))
			&& !channels.every((c) => c.endsWith("%"))
		) return null;
		const alphaText = legacy ? parts[3] : parts[1];
		const alpha = alphaText === void 0 ? 1 : number(alphaText);
		if (alpha === null) return null;
		if (kind === "oklch") {
			const l = number(channels[0]);
			const c = number(channels[1], 0.4);
			const h = number(channels[2], 1, true);
			return l === null || c === null || h === null
				? null
				: { l: clamp(l), c: Math.max(0, c), h: wrapHue(h), a: clamp(alpha) };
		}
		if (kind.startsWith("hsl")) {
			const h = number(channels[0], 1, true);
			const s = number(channels[1]);
			const l = number(channels[2]);
			if (
				h === null || s === null || l === null || !channels[1].endsWith("%")
				|| !channels[2].endsWith("%")
			) return null;
			const sat = clamp(s), light = clamp(l);
			const a = sat * Math.min(light, 1 - light);
			const f = (n) => {
				const k = (n + wrapHue(h) / 30) % 12;
				return light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
			};
			return rgbToColor([f(0), f(8), f(4)], alpha);
		}
		const values = channels.map((c) => number(c, p3 ? 1 : 255));
		if (values.some((n) => n === null)) return null;
		return rgbToColor(values.map((n) => p3 ? n : clamp(n / 255)), alpha, p3 ? "p3" : "srgb");
	}

	// src/dial-pad.ts
	var PAD_GRID_DIVISIONS = 6;
	function padGridIntersection(x, y, width, height) {
		if (width <= 0 || height <= 0) return void 0;
		const column = Math.round(x / width * PAD_GRID_DIVISIONS);
		const row = Math.round(y / height * PAD_GRID_DIVISIONS);
		if (column < 1 || column >= PAD_GRID_DIVISIONS || row < 1 || row >= PAD_GRID_DIVISIONS) {
			return void 0;
		}
		const target = { x: column / PAD_GRID_DIVISIONS * width, y: row / PAD_GRID_DIVISIONS * height };
		return Math.abs(x - target.x) <= 8 && Math.abs(y - target.y) <= 8 ? target : void 0;
	}
	function resolvePadAxis(config = [0, -1, 1, 0.01]) {
		const [initial, min, max, suppliedStep] = config;
		const step = suppliedStep ?? (max - min) / 200;
		if (![initial, min, max, step, max - min].every(Number.isFinite) || max <= min || step <= 0) {
			throw new RangeError(
				"DialPad axes need finite [default, min, max, step?] values, min < max, and a positive step.",
			);
		}
		const axis = { default: initial, min, max, step };
		axis.default = snapPadAxis(initial, axis);
		return axis;
	}
	function snapPadAxis(value, axis) {
		if (!Number.isFinite(value)) return axis.default;
		const clamped = Math.max(axis.min, Math.min(axis.max, value));
		if (clamped === axis.min || clamped === axis.max) return clamped;
		const snapped = axis.min + Math.round((clamped - axis.min) / axis.step) * axis.step;
		return Math.max(axis.min, Math.min(axis.max, Number(snapped.toPrecision(12))));
	}
	function normalizePadValue(value, config = {}) {
		const axes = { x: resolvePadAxis(config.x), y: resolvePadAxis(config.y) };
		const input = typeof value === "object" && value !== null ? value : {};
		return {
			x: typeof input.x === "number" ? snapPadAxis(input.x, axes.x) : axes.x.default,
			y: typeof input.y === "number" ? snapPadAxis(input.y, axes.y) : axes.y.default,
		};
	}
	function padValueFromPoint(x, y, config = {}) {
		const horizontal = resolvePadAxis(config.x);
		const vertical = resolvePadAxis(config.y);
		return {
			x: snapPadAxis(horizontal.min + x * (horizontal.max - horizontal.min), horizontal),
			y: snapPadAxis(vertical.max - y * (vertical.max - vertical.min), vertical),
		};
	}
	function padValueFromKey(value, key, shift, config = {}) {
		const axis = key === "ArrowLeft" || key === "ArrowRight"
			? "x"
			: key === "ArrowUp" || key === "ArrowDown"
			? "y"
			: void 0;
		if (!axis) return void 0;
		const range = resolvePadAxis(config[axis]);
		const direction = key === "ArrowRight" || key === "ArrowUp" ? 1 : -1;
		return {
			...value,
			[axis]: snapPadAxis(value[axis] + direction * range.step * (shift ? 10 : 1), range),
		};
	}

	// src/store/DialStore.ts
	var EMPTY_VALUES = Object.freeze({});
	function resolveDialValues(config, flatValues) {
		return resolveConfigValues(config, flatValues, "");
	}
	function flattenDialValueUpdates(config, updates) {
		const values = {};
		if (typeof updates === "object" && updates !== null) {
			flattenConfigUpdates(config, updates, "", values);
		}
		return values;
	}
	function resolveConfigValues(config, flatValues, prefix) {
		const result = {};
		for (const [key, configValue] of Object.entries(config)) {
			if (key === "_collapsed") continue;
			const path = prefix ? `${prefix}.${key}` : key;
			if (isLeafConfigValue(configValue)) {
				result[key] = flatValues[path] ?? configDefaultValue(configValue);
			} else if (typeof configValue === "object" && configValue !== null) {
				result[key] = resolveConfigValues(configValue, flatValues, path);
			}
		}
		return result;
	}
	function flattenConfigUpdates(config, updates, prefix, values) {
		for (const [key, configValue] of Object.entries(config)) {
			if (key === "_collapsed" || !(key in updates)) continue;
			const nextValue = updates[key];
			if (nextValue === void 0) continue;
			const path = prefix ? `${prefix}.${key}` : key;
			if (isActionConfigValue(configValue)) {
				continue;
			}
			if (isLeafConfigValue(configValue)) {
				values[path] = nextValue;
				continue;
			}
			if (
				typeof configValue === "object" && configValue !== null && typeof nextValue === "object"
				&& nextValue !== null && !Array.isArray(nextValue)
			) {
				flattenConfigUpdates(configValue, nextValue, path, values);
			}
		}
	}
	function isLeafConfigValue(value) {
		return Array.isArray(value) && value.length <= 4 && typeof value[0] === "number"
			|| typeof value === "number" || typeof value === "boolean" || typeof value === "string"
			|| isSpringConfigValue(value) || isEasingConfigValue(value) || isActionConfigValue(value)
			|| isSelectConfigValue(value) || isColorConfigValue(value) || isImageConfigValue(value)
			|| isTextConfigValue(value) || isPadConfigValue(value);
	}
	function configDefaultValue(value) {
		if (Array.isArray(value)) return value[0];
		if (isSelectConfigValue(value)) return value.default ?? getFirstOptionValue(value.options);
		if (isColorConfigValue(value)) return value.default ?? "#000000";
		if (isImageConfigValue(value)) return value.default ?? getFirstOptionValue(value.options ?? []);
		if (isTextConfigValue(value)) return value.default ?? "";
		if (isPadConfigValue(value)) return normalizePadValue(void 0, value);
		return value;
	}
	function isRecord(value) {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}
	function sameControlValue(previous, next, control) {
		return Object.is(previous, next)
			|| control?.type === "pad" && isRecord(previous) && isRecord(next) && previous.x === next.x
				&& previous.y === next.y;
	}
	function hasType(value, type) {
		return typeof value === "object" && value !== null && "type" in value && value.type === type;
	}
	function isSpringConfigValue(value) {
		return hasType(value, "spring");
	}
	function isEasingConfigValue(value) {
		return hasType(value, "easing");
	}
	function isHexColor(value) {
		return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(value);
	}
	function formatLabel(key) {
		return key.replace(/([A-Z])/g, " $1").replace(/^./, (str) => str.toUpperCase()).trim();
	}
	function inferStep(min, max) {
		const range = max - min;
		if (range <= 1) return 0.01;
		if (range <= 10) return 0.1;
		if (range <= 100) return 1;
		return 10;
	}
	function isActionConfigValue(value) {
		return hasType(value, "action");
	}
	function isSelectConfigValue(value) {
		return hasType(value, "select") && "options" in value && Array.isArray(value.options);
	}
	function isColorConfigValue(value) {
		return hasType(value, "color");
	}
	function isImageConfigValue(value) {
		return hasType(value, "image");
	}
	function isTextConfigValue(value) {
		return hasType(value, "text");
	}
	function isPadConfigValue(value) {
		return hasType(value, "pad");
	}
	function getFirstOptionValue(options) {
		const first = options[0];
		if (first === void 0) return "";
		return typeof first === "string" ? first : first.value;
	}
	var DialStoreClass = class {
		constructor() {
			this.panelOpenListeners = /* @__PURE__ */ new Set();
			this.panelOpenStates = /* @__PURE__ */ new Map();
			this.panels = /* @__PURE__ */ new Map();
			this.controlsByPanel = /* @__PURE__ */ new WeakMap();
			this.panelsSnapshot = [];
			this.standardPanelsSnapshot = [];
			this.timelinePanelsSnapshot = [];
			this.listeners = /* @__PURE__ */ new Map();
			this.globalListeners = /* @__PURE__ */ new Set();
			this.snapshots = /* @__PURE__ */ new Map();
			this.actionListeners = /* @__PURE__ */ new Map();
			this.presets = /* @__PURE__ */ new Map();
			this.activePreset = /* @__PURE__ */ new Map();
			this.baseValues = /* @__PURE__ */ new Map();
			this.defaultValues = /* @__PURE__ */ new Map();
			this.registrationCounts = /* @__PURE__ */ new Map();
			this.retainedPanels = /* @__PURE__ */ new Set();
			this.persistConfigs = /* @__PURE__ */ new Map();
		}
		registerPanel(id, name, config, shortcuts, options = {}) {
			const { controls, controlsByPath, defaultValues } = this.parseConfig(config, shortcuts);
			if (!this.panelOpenStates.has(id) && options.defaultCollapsed !== void 0) {
				this.panelOpenStates.set(id, !options.defaultCollapsed);
			}
			const existingPanel = this.panels.get(id);
			if (existingPanel && existingPanel.kind !== options.kind) {
				console.warn(
					`[dialkit] Panel id "${id}" cannot be shared by a timeline and a standard panel; the most recent registration controls where it renders.`,
				);
			}
			this.configurePanelRetention(id, options);
			this.registrationCounts.set(id, (this.registrationCounts.get(id) ?? 0) + 1);
			const persisted = this.loadPersistedPanel(id);
			const previousValues = this.panels.get(id)?.values ?? this.snapshots.get(id)
				?? persisted?.values ?? {};
			const values = this.reconcileValues(defaultValues, previousValues, controlsByPath);
			const previousBaseValues = this.baseValues.get(id) ?? persisted?.baseValues
				?? persisted?.values ?? {};
			const baseValues = this.reconcileValues(defaultValues, previousBaseValues, controlsByPath);
			const panel = { id, name, controls, values, shortcuts: shortcuts ?? {}, kind: options.kind };
			this.panels.set(id, panel);
			this.controlsByPanel.set(panel, controlsByPath);
			this.snapshots.set(id, { ...values });
			this.baseValues.set(id, baseValues);
			this.defaultValues.set(id, { ...defaultValues });
			const existingPresets = this.presets.get(id) ?? persisted?.presets;
			if (existingPresets) {
				this.presets.set(id, this.reconcilePresets(existingPresets, defaultValues, controlsByPath));
			}
			if (!this.activePreset.has(id) && persisted?.activePresetId !== void 0) {
				this.activePreset.set(id, persisted.activePresetId);
			}
			this.persistPanel(id);
			this.notify(id);
			this.notifyGlobal();
		}
		updatePanel(id, name, config, shortcuts, options = {}) {
			const existing = this.panels.get(id);
			if (!existing) {
				this.registerPanel(id, name, config, shortcuts, options);
				return;
			}
			const { controls, controlsByPath, defaultValues } = this.parseConfig(
				config,
				shortcuts ?? existing.shortcuts,
			);
			this.configurePanelRetention(id, options);
			const nextValues = this.reconcileValues(defaultValues, existing.values, controlsByPath);
			const nextPanel = {
				id,
				name,
				controls,
				values: nextValues,
				shortcuts: shortcuts ?? existing.shortcuts,
				kind: options.kind ?? existing.kind,
			};
			this.panels.set(id, nextPanel);
			this.controlsByPanel.set(nextPanel, controlsByPath);
			this.snapshots.set(id, { ...nextValues });
			const previousBaseValues = this.baseValues.get(id) ?? {};
			const nextBaseValues = this.reconcileValues(
				defaultValues,
				previousBaseValues,
				controlsByPath,
			);
			for (const [path, value] of Object.entries(nextValues)) {
				if (path.endsWith(".__mode")) {
					nextBaseValues[path] = value;
				}
			}
			this.baseValues.set(id, nextBaseValues);
			this.defaultValues.set(id, { ...defaultValues });
			this.presets.set(
				id,
				this.reconcilePresets(this.presets.get(id) ?? [], defaultValues, controlsByPath),
			);
			this.persistPanel(id);
			this.notify(id);
			this.notifyGlobal();
		}
		unregisterPanel(id) {
			const nextCount = (this.registrationCounts.get(id) ?? 1) - 1;
			if (nextCount > 0) {
				this.registrationCounts.set(id, nextCount);
				return;
			}
			this.registrationCounts.delete(id);
			this.panels.delete(id);
			if (this.listeners.get(id)?.size === 0) this.listeners.delete(id);
			if (this.actionListeners.get(id)?.size === 0) this.actionListeners.delete(id);
			if (!this.retainedPanels.has(id)) {
				this.panelOpenStates.delete(id);
				this.snapshots.delete(id);
				this.baseValues.delete(id);
				this.defaultValues.delete(id);
				this.presets.delete(id);
				this.activePreset.delete(id);
				this.persistConfigs.delete(id);
			}
			this.notifyGlobal();
		}
		/** Undefined delegates the initial state to DialRoot.defaultOpen. */
		getPanelOpen(panelId) {
			return this.panelOpenStates.get(panelId);
		}
		isPanelOpen(panelId) {
			return this.panelOpenStates.get(panelId) ?? true;
		}
		togglePanelOpen(panelId) {
			this.setPanelOpen(panelId, !this.isPanelOpen(panelId));
		}
		/** Applies a host component's own default; no-op once the panel has state. */
		initPanelOpen(panelId, open) {
			if (this.panelOpenStates.has(panelId)) return;
			this.panelOpenStates.set(panelId, open);
			this.notify(panelId);
		}
		/** Observe open requests so a containing toolkit can reveal its requested panel. */
		subscribePanelOpen(listener) {
			this.panelOpenListeners.add(listener);
			return () => {
				this.panelOpenListeners.delete(listener);
			};
		}
		setPanelOpen(panelId, open) {
			if (!this.panels.has(panelId)) return;
			if (this.panelOpenStates.get(panelId) !== open) {
				this.panelOpenStates.set(panelId, open);
				this.notify(panelId);
			}
			this.panelOpenListeners.forEach((listener) => listener(panelId, open));
		}
		updateValue(panelId, path, value) {
			this.updateValues(panelId, { [path]: value });
		}
		updateValues(panelId, updates) {
			const panel = this.panels.get(panelId);
			if (!panel) return;
			const validUpdates = {};
			const activeId = this.activePreset.get(panelId);
			const target = activeId
				? this.presets.get(panelId)?.find((preset) => preset.id === activeId)?.values
				: this.baseValues.get(panelId);
			for (const [path, value] of Object.entries(updates)) {
				if (!Object.prototype.hasOwnProperty.call(panel.values, path)) {
					continue;
				}
				const control = this.controlsByPanel.get(panel)?.get(path);
				if (control?.type === "action") {
					continue;
				}
				const next = control?.type === "pad" ? normalizePadValue(value, control.pad) : value;
				if (
					sameControlValue(panel.values[path], next, control)
					&& (!target || sameControlValue(target[path], next, control))
				) continue;
				panel.values[path] = next;
				validUpdates[path] = next;
			}
			if (Object.keys(validUpdates).length === 0) {
				return;
			}
			if (target) Object.assign(target, validUpdates);
			this.snapshots.set(panelId, { ...panel.values });
			this.persistPanel(panelId);
			this.notify(panelId);
		}
		resetValues(panelId) {
			const panel = this.panels.get(panelId);
			const defaults = this.defaultValues.get(panelId);
			if (!panel || !defaults) return;
			panel.values = { ...defaults };
			this.snapshots.set(panelId, { ...panel.values });
			this.baseValues.set(panelId, { ...defaults });
			this.activePreset.set(panelId, null);
			this.persistPanel(panelId);
			this.notify(panelId);
		}
		updateSpringMode(panelId, path, mode) {
			this.updateTransitionMode(panelId, path, mode);
		}
		getSpringMode(panelId, path) {
			const mode = this.getTransitionMode(panelId, path);
			if (mode === "easing") return "simple";
			return mode;
		}
		updateTransitionMode(panelId, path, mode) {
			const panel = this.panels.get(panelId);
			if (!panel) return;
			if (panel.values[`${path}.__mode`] === mode) return;
			panel.values[`${path}.__mode`] = mode;
			this.snapshots.set(panelId, { ...panel.values });
			this.persistPanel(panelId);
			this.notify(panelId);
		}
		getTransitionMode(panelId, path) {
			const panel = this.panels.get(panelId);
			if (!panel) return "simple";
			return panel.values[`${path}.__mode`] || "simple";
		}
		getValue(panelId, path) {
			const panel = this.panels.get(panelId);
			return panel?.values[path];
		}
		getValues(panelId) {
			return this.snapshots.get(panelId) ?? EMPTY_VALUES;
		}
		getPanels(kind) {
			if (kind === "panel") return this.standardPanelsSnapshot;
			if (kind === "timeline") return this.timelinePanelsSnapshot;
			return this.panelsSnapshot;
		}
		getPanel(id) {
			return this.panels.get(id);
		}
		subscribe(panelId, listener) {
			if (!this.listeners.has(panelId)) {
				this.listeners.set(panelId, /* @__PURE__ */ new Set());
			}
			this.listeners.get(panelId).add(listener);
			return () => {
				const listeners2 = this.listeners.get(panelId);
				listeners2?.delete(listener);
				if (listeners2?.size === 0 && !this.panels.has(panelId)) {
					this.listeners.delete(panelId);
				}
			};
		}
		subscribeGlobal(listener) {
			this.globalListeners.add(listener);
			return () => this.globalListeners.delete(listener);
		}
		subscribeActions(panelId, listener) {
			if (!this.actionListeners.has(panelId)) {
				this.actionListeners.set(panelId, /* @__PURE__ */ new Set());
			}
			this.actionListeners.get(panelId).add(listener);
			return () => {
				const listeners2 = this.actionListeners.get(panelId);
				listeners2?.delete(listener);
				if (listeners2?.size === 0 && !this.panels.has(panelId)) {
					this.actionListeners.delete(panelId);
				}
			};
		}
		triggerAction(panelId, path) {
			this.actionListeners.get(panelId)?.forEach((fn) => fn(path));
		}
		saveNewPreset(panelId) {
			const highest = this.getPresets(panelId).reduce((max, preset) => {
				const match = /^Version (\d+)$/.exec(preset.name);
				return match ? Math.max(max, Number(match[1])) : max;
			}, 1);
			return this.savePreset(panelId, `Version ${highest + 1}`);
		}
		savePreset(panelId, name) {
			const panel = this.panels.get(panelId);
			if (!panel) throw new Error(`Panel ${panelId} not found`);
			const id = `preset-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
			const preset = {
				id,
				name,
				values: { ...panel.values },
			};
			const existing = this.presets.get(panelId) ?? [];
			this.presets.set(panelId, [...existing, preset]);
			this.activePreset.set(panelId, id);
			this.snapshots.set(panelId, { ...panel.values });
			this.persistPanel(panelId);
			this.notify(panelId);
			return id;
		}
		loadPreset(panelId, presetId) {
			const panel = this.panels.get(panelId);
			if (!panel) return;
			const presets = this.presets.get(panelId) ?? [];
			const preset = presets.find((p) => p.id === presetId);
			if (!preset) return;
			panel.values = { ...preset.values };
			this.snapshots.set(panelId, { ...panel.values });
			this.activePreset.set(panelId, presetId);
			this.persistPanel(panelId);
			this.notify(panelId);
		}
		deletePreset(panelId, presetId) {
			const presets = this.presets.get(panelId) ?? [];
			this.presets.set(panelId, presets.filter((p) => p.id !== presetId));
			if (this.activePreset.get(panelId) === presetId) {
				this.activePreset.set(panelId, null);
			}
			const panel = this.panels.get(panelId);
			if (panel) {
				this.snapshots.set(panelId, { ...panel.values });
			}
			this.persistPanel(panelId);
			this.notify(panelId);
		}
		getPresets(panelId) {
			return this.presets.get(panelId) ?? [];
		}
		getActivePresetId(panelId) {
			return this.activePreset.get(panelId) ?? null;
		}
		clearActivePreset(panelId) {
			const panel = this.panels.get(panelId);
			const base = this.baseValues.get(panelId);
			if (panel && base) {
				panel.values = { ...base };
				this.snapshots.set(panelId, { ...panel.values });
			}
			this.activePreset.set(panelId, null);
			this.persistPanel(panelId);
			this.notify(panelId);
		}
		resolveShortcutTarget(key, modifier) {
			for (const panel of this.panels.values()) {
				for (const [path, shortcut] of Object.entries(panel.shortcuts)) {
					if (!shortcut.key) continue;
					if (shortcut.key.toLowerCase() !== key.toLowerCase()) continue;
					const scMod = shortcut.modifier ?? void 0;
					if (scMod !== modifier) continue;
					const control = this.controlsByPanel.get(panel)?.get(path);
					if (control) {
						return { panelId: panel.id, path, control };
					}
				}
			}
			return null;
		}
		resolveScrollOnlyTargets() {
			const results = [];
			for (const panel of this.panels.values()) {
				for (const [path, shortcut] of Object.entries(panel.shortcuts)) {
					if ((shortcut.interaction ?? "scroll") !== "scroll-only") continue;
					const control = this.controlsByPanel.get(panel)?.get(path);
					if (control) {
						results.push({ panelId: panel.id, path, control, shortcut });
					}
				}
			}
			return results;
		}
		configurePanelRetention(id, options) {
			if (options.retainOnUnmount) {
				this.retainedPanels.add(id);
			}
			const persistConfig = this.normalizePersistConfig(id, options.persist);
			if (persistConfig) {
				this.persistConfigs.set(id, persistConfig);
				this.retainedPanels.add(id);
			} else if (options.persist === false) {
				this.persistConfigs.delete(id);
			}
		}
		reconcileValues(defaultValues, previousValues, controlsByPath) {
			const nextValues = {};
			for (const [path, defaultValue] of Object.entries(defaultValues)) {
				if (path.endsWith(".__mode")) {
					const transitionPath = path.slice(0, -".__mode".length);
					const transitionControl = controlsByPath.get(transitionPath);
					const mode = previousValues[path];
					nextValues[path] = transitionControl?.type === "transition"
							&& (mode === "easing" || mode === "simple" || mode === "advanced")
						? mode
						: defaultValue;
					continue;
				}
				nextValues[path] = this.normalizePreservedValue(
					previousValues[path],
					defaultValue,
					controlsByPath.get(path),
				);
			}
			return nextValues;
		}
		reconcilePresets(presets, defaultValues, controlsByPath) {
			return presets.map((preset) => ({
				...preset,
				values: this.reconcileValues(defaultValues, preset.values, controlsByPath),
			}));
		}
		normalizePersistConfig(id, persist) {
			if (!persist) return null;
			const options = typeof persist === "object" ? persist : {};
			return {
				key: options.key ?? `dialkit:${id}`,
				storage: options.storage ?? "localStorage",
				presets: options.presets ?? true,
			};
		}
		loadPersistedPanel(id) {
			const config = this.persistConfigs.get(id);
			if (!config) return null;
			const storage = this.getStorage(config.storage);
			if (!storage) return null;
			try {
				const raw = storage.getItem(config.key);
				if (!raw) return null;
				const parsed = JSON.parse(raw);
				if (!isRecord(parsed) || parsed.version !== 1) return null;
				const values = isRecord(parsed.values) ? parsed.values : void 0;
				const presets = config.presets && Array.isArray(parsed.presets)
					? parsed.presets.filter((preset) =>
						isRecord(preset) && typeof preset.id === "string" && typeof preset.name === "string"
						&& isRecord(preset.values)
					)
					: [];
				return {
					version: 1,
					values,
					baseValues: config.presets && isRecord(parsed.baseValues) ? parsed.baseValues : values,
					presets,
					activePresetId: presets.some((preset) => preset.id === parsed.activePresetId)
						? parsed.activePresetId
						: null,
				};
			} catch {
				return null;
			}
		}
		persistPanel(id) {
			const config = this.persistConfigs.get(id);
			if (!config) return;
			const storage = this.getStorage(config.storage);
			if (!storage) return;
			const values = this.snapshots.get(id) ?? this.panels.get(id)?.values;
			if (!values) return;
			const state = { version: 1, values };
			if (config.presets) {
				state.baseValues = this.baseValues.get(id) ?? values;
				state.presets = this.presets.get(id) ?? [];
				state.activePresetId = this.activePreset.get(id) ?? null;
			}
			try {
				storage.setItem(config.key, JSON.stringify(state));
			} catch {
			}
		}
		getStorage(kind) {
			if (typeof globalThis === "undefined" || !("window" in globalThis)) {
				return null;
			}
			try {
				return kind === "sessionStorage"
					? globalThis.window?.sessionStorage ?? null
					: globalThis.window?.localStorage ?? null;
			} catch {
				return null;
			}
		}
		notify(panelId) {
			this.listeners.get(panelId)?.forEach((fn) => fn());
		}
		notifyGlobal() {
			this.panelsSnapshot = Array.from(this.panels.values());
			this.standardPanelsSnapshot = this.panelsSnapshot.filter((panel) =>
				panel.kind !== "timeline"
			);
			this.timelinePanelsSnapshot = this.panelsSnapshot.filter((panel) =>
				panel.kind === "timeline"
			);
			this.globalListeners.forEach((fn) => fn());
		}
		/** Compile controls, defaults, and the lookup index in one walk. */
		parseConfig(config, shortcuts) {
			const defaultValues = {};
			const modes = {};
			const controlsByPath = /* @__PURE__ */ new Map();
			const visit = (config2, prefix) => {
				const controls2 = [];
				for (const [key, value] of Object.entries(config2)) {
					if (key === "_collapsed") continue;
					const path = prefix ? `${prefix}.${key}` : key;
					const label = formatLabel(key);
					const shortcut = shortcuts?.[path];
					let control;
					if (Array.isArray(value) && value.length <= 4 && typeof value[0] === "number") {
						control = {
							type: "slider",
							path,
							label,
							min: value[1],
							max: value[2],
							step: value[3] ?? inferStep(value[1], value[2]),
							shortcut,
						};
					} else if (typeof value === "number") {
						const { min, max, step } = this.inferRange(value);
						control = { type: "slider", path, label, min, max, step, shortcut };
					} else if (typeof value === "boolean") {
						control = { type: "toggle", path, label, shortcut };
					} else if (isSpringConfigValue(value) || isEasingConfigValue(value)) {
						control = { type: "transition", path, label };
					} else if (isActionConfigValue(value)) {
						control = { type: "action", path, label: value.label || label };
					} else if (isSelectConfigValue(value)) {
						control = { type: "select", path, label, options: value.options };
					} else if (isColorConfigValue(value)) {
						control = { type: "color", path, label };
					} else if (isImageConfigValue(value)) {
						control = { type: "image", path, label, options: value.options };
					} else if (isTextConfigValue(value)) {
						control = { type: "text", path, label, placeholder: value.placeholder };
					} else if (isPadConfigValue(value)) {
						control = { type: "pad", path, label, pad: value };
					} else if (typeof value === "string") {
						if (parseColor(value) && value !== "transparent") {
							control = { type: "color", path, label };
						} else {
							control = { type: "text", path, label };
						}
					} else if (typeof value === "object" && value !== null) {
						const folderConfig = value;
						const defaultOpen = "_collapsed" in folderConfig ? !folderConfig._collapsed : true;
						control = {
							type: "folder",
							path,
							label,
							defaultOpen,
							children: visit(folderConfig, path),
						};
					}
					if (!control) continue;
					controls2.push(control);
					controlsByPath.set(path, control);
					if (control.type === "folder") continue;
					defaultValues[path] = configDefaultValue(value);
					if (isEasingConfigValue(value)) {
						modes[`${path}.__mode`] = "easing";
					} else if (isSpringConfigValue(value)) {
						const hasPhysics = value.stiffness !== void 0 || value.damping !== void 0
							|| value.mass !== void 0;
						const hasTime = value.visualDuration !== void 0 || value.bounce !== void 0;
						modes[`${path}.__mode`] = hasPhysics && !hasTime ? "advanced" : "simple";
					}
				}
				return controls2;
			};
			const controls = visit(config, "");
			Object.assign(defaultValues, modes);
			return { controls, defaultValues, controlsByPath };
		}
		inferRange(value) {
			if (value >= 0 && value <= 1) {
				return { min: 0, max: 1, step: 0.01 };
			} else if (value >= 0 && value <= 10) {
				return { min: 0, max: value * 3 || 10, step: 0.1 };
			} else if (value >= 0 && value <= 100) {
				return { min: 0, max: value * 3 || 100, step: 1 };
			} else if (value >= 0) {
				return { min: 0, max: value * 3 || 1e3, step: 10 };
			} else {
				return { min: value * 3, max: -value * 3, step: 1 };
			}
		}
		normalizePreservedValue(existingValue, defaultValue, control) {
			if (existingValue === void 0 || !control) {
				return defaultValue;
			}
			switch (control.type) {
				case "slider": {
					if (
						typeof existingValue !== "number" || !Number.isFinite(existingValue)
						|| typeof defaultValue !== "number"
					) {
						return defaultValue;
					}
					const min = control.min ?? Number.NEGATIVE_INFINITY;
					const max = control.max ?? Number.POSITIVE_INFINITY;
					const clamped = Math.min(max, Math.max(min, existingValue));
					if (typeof control.step !== "number" || control.step <= 0) {
						return clamped;
					}
					return roundValue(clamped, control.step, min, max);
				}
				case "toggle":
					return typeof existingValue === "boolean" ? existingValue : defaultValue;
				case "pad":
					return normalizePadValue(existingValue, control.pad);
				case "select": {
					if (typeof existingValue !== "string") {
						return defaultValue;
					}
					const options = control.options ?? [];
					const validValues = new Set(
						options.map((option) => typeof option === "string" ? option : option.value),
					);
					return validValues.has(existingValue) ? existingValue : defaultValue;
				}
				case "color":
				case "image":
				case "text":
					return typeof existingValue === "string" ? existingValue : defaultValue;
				case "transition":
					if (isSpringConfigValue(defaultValue)) {
						return isSpringConfigValue(existingValue) ? existingValue : defaultValue;
					}
					if (isEasingConfigValue(defaultValue)) {
						return isEasingConfigValue(existingValue) ? existingValue : defaultValue;
					}
					return defaultValue;
				case "action":
					return defaultValue;
				default:
					return defaultValue;
			}
		}
	};
	var DialStore = /* @__PURE__ */ new DialStoreClass();

	// src/vanilla/createDialKit.ts
	var nextId = 0;
	function createDialKit(name, config, options = {}) {
		const id = options.id ?? `vanilla-${name}-${++nextId}`;
		let currentConfig = config;
		let destroyed = false;
		const subscriptions = /* @__PURE__ */ new Set();
		const registration = {
			retainOnUnmount: options.id !== void 0,
			persist: options.persist,
			defaultCollapsed: options.defaultCollapsed,
		};
		const getValues = () => resolveDialValues(currentConfig, DialStore.getValues(id));
		DialStore.registerPanel(id, name, currentConfig, options.shortcuts, registration);
		const stopActions = options.onAction
			? DialStore.subscribeActions(id, options.onAction)
			: void 0;
		return {
			id,
			get values() {
				return getValues();
			},
			getValues,
			setValue(path, value) {
				if (!destroyed) {
					DialStore.updateValue(id, path, value);
				}
			},
			setValues(values) {
				if (!destroyed) {
					DialStore.updateValues(id, flattenDialValueUpdates(currentConfig, values));
				}
			},
			resetValues() {
				if (!destroyed) {
					DialStore.resetValues(id);
				}
			},
			setOpen(open) {
				if (!destroyed) {
					DialStore.setPanelOpen(id, open);
				}
			},
			getOpen() {
				return DialStore.getPanelOpen(id);
			},
			subscribe(listener, immediate = true) {
				if (destroyed) {
					return () => {
					};
				}
				const stop2 = DialStore.subscribe(id, () => listener(getValues()));
				const unsubscribe = () => {
					stop2();
					subscriptions.delete(unsubscribe);
				};
				subscriptions.add(unsubscribe);
				if (immediate) {
					listener(getValues());
				}
				return unsubscribe;
			},
			updateConfig(next) {
				if (destroyed) {
					return;
				}
				currentConfig = next;
				DialStore.updatePanel(id, name, currentConfig, options.shortcuts, registration);
			},
			destroy() {
				if (destroyed) {
					return;
				}
				destroyed = true;
				subscriptions.forEach((stop2) => stop2());
				stopActions?.();
				DialStore.unregisterPanel(id);
			},
		};
	}
	var createDialKitController = createDialKit;

	// src/store/TimelineStore.ts
	function loopSpan(duration, loopStart) {
		if (!Number.isFinite(duration) || duration <= 0) return 0;
		if (!Number.isFinite(loopStart)) loopStart = 0;
		const start = Math.min(Math.max(0, loopStart), duration);
		return duration - start > 0 ? duration - start : duration;
	}
	function foldLoopTime(time, duration, loopStart = 0) {
		if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) {
			return { time: 0, wraps: 0 };
		}
		if (time < duration) return { time, wraps: 0 };
		const span = loopSpan(duration, loopStart);
		const base = duration - span;
		const over = time - base;
		return { time: base + over % span, wraps: Math.floor(over / span) };
	}
	var TIMELINE_CLIP_COLORS = [
		"#E8E8E8",
		// neutral white — slightly off-white so the pure-white selection ring still reads
	];
	var EMPTY_TRANSPORT = Object.freeze({ time: 0, playing: false, duration: 0, wraps: 0 });
	var TimelineStoreClass = class {
		constructor() {
			this.timelines = /* @__PURE__ */ new Map();
			this.transports = /* @__PURE__ */ new Map();
			this.listeners = /* @__PURE__ */ new Map();
			this.globalListeners = /* @__PURE__ */ new Set();
			this.registrationCounts = /* @__PURE__ */ new Map();
			this.listCache = null;
			this.rafId = null;
			this.lastTick = 0;
			this.tick = (now) => {
				const dt = Math.max(0, (now - this.lastTick) / 1e3);
				this.lastTick = now;
				let anyPlaying = false;
				for (const [id, transport] of this.transports) {
					if (!transport.playing) continue;
					const meta = this.timelines.get(id);
					const duration = meta?.duration ?? transport.duration;
					if (!Number.isFinite(duration) || duration <= 0) {
						this.transports.set(id, { time: 0, playing: false, duration: 0, wraps: 0 });
						this.notify(id);
						continue;
					}
					let time = transport.time + dt;
					let playing = true;
					let wraps = transport.wraps;
					if (time >= duration) {
						if (meta?.loop) {
							const folded = foldLoopTime(time, duration, meta.loopStart);
							time = folded.time;
							wraps += folded.wraps;
						} else {
							time = duration;
							playing = false;
						}
					}
					this.transports.set(id, { time, playing, duration, wraps });
					if (playing) anyPlaying = true;
					this.notify(id);
				}
				this.rafId = anyPlaying ? window.requestAnimationFrame(this.tick) : null;
			};
		}
		register(meta, options) {
			const existing = this.timelines.get(meta.id);
			if (existing && existing.name !== meta.name) {
				console.warn(
					`[dialkit] Timeline id "${meta.id}" is already registered by "${existing.name}"; "${meta.name}" will share and overwrite that transport.`,
				);
			}
			this.registrationCounts.set(meta.id, (this.registrationCounts.get(meta.id) ?? 0) + 1);
			this.applyMeta(meta, options.autoplay);
		}
		update(meta) {
			if (!this.timelines.has(meta.id)) return;
			this.applyMeta(meta, false);
		}
		unregister(id) {
			const nextCount = (this.registrationCounts.get(id) ?? 1) - 1;
			if (nextCount > 0) {
				this.registrationCounts.set(id, nextCount);
				return;
			}
			this.registrationCounts.delete(id);
			this.timelines.delete(id);
			this.transports.delete(id);
			if (this.listeners.get(id)?.size === 0) this.listeners.delete(id);
			this.listCache = null;
			this.notifyGlobal();
		}
		play(id) {
			const transport = this.transports.get(id);
			if (!transport || transport.duration <= 0 || transport.playing) return;
			const restart = transport.time >= transport.duration;
			this.transports.set(id, {
				...transport,
				time: restart ? 0 : transport.time,
				wraps: restart ? 0 : transport.wraps,
				playing: true,
			});
			this.notify(id);
			this.ensureLoop();
		}
		pause(id) {
			const transport = this.transports.get(id);
			if (!transport || !transport.playing) return;
			this.transports.set(id, { ...transport, playing: false });
			this.notify(id);
		}
		replay(id) {
			const transport = this.transports.get(id);
			if (!transport || transport.duration <= 0) return;
			this.transports.set(id, { ...transport, time: 0, wraps: 0, playing: true });
			this.notify(id);
			this.ensureLoop();
		}
		seek(id, time) {
			const transport = this.transports.get(id);
			if (!transport || !Number.isFinite(time)) return;
			const clamped = Math.min(transport.duration, Math.max(0, time));
			this.transports.set(id, { ...transport, time: clamped, wraps: 0 });
			this.notify(id);
		}
		getTransport(id) {
			return this.transports.get(id) ?? EMPTY_TRANSPORT;
		}
		getTimeline(id) {
			return this.timelines.get(id);
		}
		getTimelines() {
			if (!this.listCache) {
				this.listCache = Array.from(this.timelines.values());
			}
			return this.listCache;
		}
		subscribe(id, listener) {
			if (!this.listeners.has(id)) {
				this.listeners.set(id, /* @__PURE__ */ new Set());
			}
			this.listeners.get(id).add(listener);
			return () => {
				const listeners2 = this.listeners.get(id);
				listeners2?.delete(listener);
				if (listeners2?.size === 0 && !this.timelines.has(id)) {
					this.listeners.delete(id);
				}
			};
		}
		subscribeGlobal(listener) {
			this.globalListeners.add(listener);
			return () => {
				this.globalListeners.delete(listener);
			};
		}
		applyMeta(meta, autoplay) {
			const duration = Number.isFinite(meta.duration) ? Math.max(0, meta.duration) : 0;
			const loopStart = Number.isFinite(meta.loopStart)
				? Math.min(duration, Math.max(0, meta.loopStart))
				: 0;
			const safeMeta = { ...meta, duration, loopStart };
			this.timelines.set(meta.id, safeMeta);
			const existing = this.transports.get(meta.id);
			if (existing) {
				this.transports.set(meta.id, {
					time: Math.min(existing.time, duration),
					playing: duration > 0 && existing.playing,
					duration,
					wraps: existing.wraps,
				});
			} else {
				const playing = duration > 0 && autoplay;
				this.transports.set(meta.id, { time: 0, playing, duration, wraps: 0 });
				if (playing) this.ensureLoop();
			}
			this.listCache = null;
			this.notify(meta.id);
			this.notifyGlobal();
		}
		ensureLoop() {
			if (this.rafId !== null || typeof window === "undefined") return;
			this.lastTick = performance.now();
			this.rafId = window.requestAnimationFrame(this.tick);
		}
		notify(id) {
			this.listeners.get(id)?.forEach((fn) => fn());
		}
		notifyGlobal() {
			this.globalListeners.forEach((fn) => fn());
		}
	};
	var TimelineStore = /* @__PURE__ */ new TimelineStoreClass();

	// src/store/TimelineUiStore.ts
	var TimelineUiStoreClass = class {
		constructor() {
			this.visible = true;
			this.initialized = false;
			this.controllers = /* @__PURE__ */ new Map();
			this.listeners = /* @__PURE__ */ new Set();
		}
		getVisible() {
			for (const controller of this.controllers.values()) {
				if (controller.visible !== void 0) return controller.visible;
			}
			return this.visible;
		}
		registerController(id, controller) {
			const previous = this.getVisible();
			if (!this.initialized) {
				this.visible = controller.defaultVisible;
				this.initialized = true;
			}
			this.controllers.set(id, controller);
			if (previous !== this.getVisible()) this.notify();
			return () => {
				const before = this.getVisible();
				this.controllers.delete(id);
				if (this.controllers.size === 0) this.initialized = false;
				if (before !== this.getVisible()) this.notify();
			};
		}
		updateController(id, controller) {
			if (!this.controllers.has(id)) return;
			const previous = this.getVisible();
			this.controllers.set(id, controller);
			if (previous !== this.getVisible()) this.notify();
		}
		requestVisible(visible) {
			const current = this.getVisible();
			if (current === visible) return;
			const controlled = Array.from(this.controllers.values()).filter(
				(controller) => controller.visible !== void 0,
			);
			if (controlled.length > 0) {
				controlled.forEach((controller) => controller.onVisibilityChange?.(visible));
				return;
			}
			this.visible = visible;
			this.controllers.forEach((controller) => controller.onVisibilityChange?.(visible));
			this.notify();
		}
		toggle() {
			this.requestVisible(!this.getVisible());
		}
		subscribe(listener) {
			this.listeners.add(listener);
			return () => this.listeners.delete(listener);
		}
		notify() {
			this.listeners.forEach((listener) => listener());
		}
	};
	var TimelineUiStore = /* @__PURE__ */ new TimelineUiStoreClass();

	// src/panel-drag.ts
	var PANEL_DRAG_THRESHOLD = 8;
	var COLLAPSED_PANEL_SIZE = 42;
	var DRAG_EXCLUSION_SELECTOR = [
		".dialkit-panel-icon",
		".dialkit-panel-toolbar",
		"button",
		"input",
		"select",
		"textarea",
		"a",
		'[role="button"]',
		'[contenteditable="true"]',
	].join(",");
	function getPanelDragHandle(target, panel) {
		if (!(target instanceof Element) || !panel) return null;
		const inner = target.closest(".dialkit-panel-inner");
		if (!inner || !panel.contains(inner)) return null;
		if (inner.getAttribute("data-collapsed") === "true") {
			return inner;
		}
		const header = target.closest(".dialkit-panel-header");
		if (!header || !inner.contains(header)) return null;
		if (target.closest(DRAG_EXCLUSION_SELECTOR)) return null;
		return header;
	}
	function getPanelDragStart(pointerX, pointerY, panel) {
		const rect = panel.getBoundingClientRect();
		return {
			pointerX,
			pointerY,
			elX: rect.left,
			elY: rect.top,
		};
	}
	function getPanelDragOffset(start, pointerX, pointerY) {
		return {
			x: start.elX + pointerX - start.pointerX,
			y: start.elY + pointerY - start.pointerY,
		};
	}
	function hasPanelDragMoved(start, pointerX, pointerY) {
		const dx = pointerX - start.pointerX;
		const dy = pointerY - start.pointerY;
		return Math.hypot(dx, dy) >= PANEL_DRAG_THRESHOLD;
	}
	function getPanelOriginX(
		position,
		offset,
		viewportWidth = typeof window !== "undefined" ? window.innerWidth : void 0,
	) {
		if (offset && viewportWidth) {
			return offset.x + COLLAPSED_PANEL_SIZE / 2 < viewportWidth / 2 ? "left" : "right";
		}
		return position.endsWith("left") ? "left" : "right";
	}
	function getPanelOriginY(
		position,
		offset,
		viewportHeight = typeof window !== "undefined" ? window.innerHeight : void 0,
	) {
		if (offset && viewportHeight) {
			return offset.y + COLLAPSED_PANEL_SIZE / 2 < viewportHeight / 2 ? "top" : "bottom";
		}
		return position.startsWith("bottom") ? "bottom" : "top";
	}
	function getPanelCorner(
		position,
		offset,
		viewportWidth = typeof window !== "undefined" ? window.innerWidth : void 0,
		viewportHeight = typeof window !== "undefined" ? window.innerHeight : void 0,
	) {
		return `${getPanelOriginY(position, offset, viewportHeight)}-${
			getPanelOriginX(position, offset, viewportWidth)
		}`;
	}
	function blockPanelDragClick(handle) {
		const blocker = (event) => {
			event.preventDefault();
			event.stopImmediatePropagation();
			event.stopPropagation();
		};
		handle.addEventListener("click", blocker, { capture: true, once: true });
		window.setTimeout(() => {
			handle.removeEventListener("click", blocker, true);
		}, 0);
	}
	function capturePanelPointer(handle, pointerId) {
		try {
			handle.setPointerCapture(pointerId);
		} catch (error) {
			if (
				!(error instanceof DOMException)
				|| !["NotFoundError", "InvalidStateError"].includes(error.name)
			) throw error;
		}
	}
	function releasePanelPointer(handle, pointerId) {
		try {
			if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
		} catch (error) {
			if (
				!(error instanceof DOMException)
				|| !["NotFoundError", "InvalidStateError"].includes(error.name)
			) throw error;
		}
	}

	// src/copy-instruction.ts
	function buildCopyInstruction(hookName, panelName, values) {
		const jsonStr = JSON.stringify(
			Object.fromEntries(
				Object.entries(values).filter(([path]) => !path.endsWith(".__mode")),
			),
			null,
			2,
		);
		if (hookName === "useDialTimeline" || hookName === "createDialTimeline") {
			return `Update the ${hookName} configuration for "${panelName}" with these values:

\`\`\`json
${jsonStr}
\`\`\`

Apply these values as the new defaults in the ${hookName} call. Keep the existing \`clip.current\` bindings while this timeline is being authored; do not convert the animation or remove DialKit yet.

Add this comment immediately above the ${hookName} call as a production handoff note:

\`\`\`tsx
// TODO(production): DialKit's clip.current values are the scrubbable authoring preview.
// Replace them with equivalent real Motion animations using the tuned timeline
// timings and transitions, then remove ${hookName} and <DialTimeline />.
\`\`\``;
		}
		return `Update the ${hookName} configuration for "${panelName}" with these values:

\`\`\`json
${jsonStr}
\`\`\`

Apply these values as the new defaults in the ${hookName} call.`;
	}

	// src/icons.ts
	var ICON_CHEVRON = "M6 9.5L12 15.5L18 9.5";
	var ICON_CLOSE = "M6 6L18 18M18 6L6 18";
	var ICON_CHECK = "M5 12.75L10 19L19 5";
	var ICON_PAUSE = [
		"M6.75 3C5.23122 3 4 4.23122 4 5.75V18.25C4 19.7688 5.23122 21 6.75 21H7.25C8.76878 21 10 19.7688 10 18.25V5.75C10 4.23122 8.76878 3 7.25 3H6.75Z",
		"M16.75 3C15.2312 3 14 4.23122 14 5.75V18.25C14 19.7688 15.2312 21 16.75 21H17.25C18.7688 21 20 19.7688 20 18.25V5.75C20 4.23122 18.7688 3 17.25 3H16.75Z",
	];
	var ICON_PLAY =
		"M9.24394 2.36758C7.41419 1.18362 5 2.49701 5 4.67639V19.3238C5 21.5032 7.41419 22.8166 9.24394 21.6326L20.5624 14.3089C22.2371 13.2253 22.2372 10.775 20.5624 9.69129L9.24394 2.36758Z";
	var ICON_REPLAY = [
		"M12 2.5C17.2466 2.50016 21.5 6.7534 21.5 12C21.5 17.2466 17.2466 21.4998 12 21.5C7.52191 21.5 3.76987 18.4025 2.76465 14.2344C2.63517 13.6975 2.96508 13.1578 3.50195 13.0283C4.03883 12.8988 4.57851 13.2288 4.70801 13.7656C5.5016 17.0563 8.46701 19.5 12 19.5C16.142 19.4998 19.5 16.142 19.5 12C19.5 7.85796 16.142 4.50016 12 4.5C9.32981 4.5 6.98389 5.89541 5.6543 8H7.5C8.05228 8 8.5 8.44772 8.5 9C8.5 9.55228 8.05228 10 7.5 10H3.5C2.94772 10 2.5 9.55228 2.5 9V5C2.5 4.44772 2.94772 4 3.5 4C4.05228 4 4.5 4.44772 4.5 5V6.16797C6.2376 3.93677 8.95063 2.5 12 2.5Z",
		"M10 9.94043C10 9.33379 10.6826 8.97849 11.1797 9.32617L14.1221 11.3857C14.5486 11.6843 14.5486 12.3157 14.1221 12.6143L11.1797 14.6738C10.6826 15.0215 10 14.6662 10 14.0596V9.94043Z",
	];
	var ICON_CLIPBOARD = {
		board: "M8 6C8 4.34315 9.34315 3 11 3H13C14.6569 3 16 4.34315 16 6V7H8V6Z",
		sparkle:
			"M19.2405 16.1852L18.5436 14.3733C18.4571 14.1484 18.241 14 18 14C17.759 14 17.5429 14.1484 17.4564 14.3733L16.7595 16.1852C16.658 16.4493 16.4493 16.658 16.1852 16.7595L14.3733 17.4564C14.1484 17.5429 14 17.759 14 18C14 18.241 14.1484 18.4571 14.3733 18.5436L16.1852 19.2405C16.4493 19.342 16.658 19.5507 16.7595 19.8148L17.4564 21.6267C17.5429 21.8516 17.759 22 18 22C18.241 22 18.4571 21.8516 18.5436 21.6267L19.2405 19.8148C19.342 19.5507 19.5507 19.342 19.8148 19.2405L21.6267 18.5436C21.8516 18.4571 22 18.241 22 18C22 17.759 21.8516 17.5429 21.6267 17.4564L19.8148 16.7595C19.5507 16.658 19.342 16.4493 19.2405 16.1852Z",
		body:
			"M16 5H17C18.6569 5 20 6.34315 20 8V11M8 5H7C5.34315 5 4 6.34315 4 8V18C4 19.6569 5.34315 21 7 21H12",
	};
	var ICON_CLIPBOARD_PLAIN = {
		board: ICON_CLIPBOARD.board,
		body:
			"M16 5H17C18.6569 5 20 6.34315 20 8V18C20 19.6569 18.6569 21 17 21H7C5.34315 21 4 19.6569 4 18V8C4 6.34315 5.34315 5 7 5H8",
	};
	var ICON_PLUS = ["M5 12H19M12 5V19"];
	var ICON_TRASH = [
		"M5 6.5L5.80734 18.2064C5.91582 19.7794 7.22348 21 8.80023 21H15.1998C16.7765 21 18.0842 19.7794 18.1927 18.2064L19 6.5",
		"M10 11V16",
		"M14 11V16",
		"M3.5 6H20.5",
		"M8.07092 5.74621C8.42348 3.89745 10.0485 2.5 12 2.5C13.9515 2.5 15.5765 3.89745 15.9291 5.74621",
	];
	var ICON_PANEL = {
		path:
			"M6.84766 11.75C6.78583 11.9899 6.75 12.2408 6.75 12.5C6.75 12.7592 6.78583 13.0101 6.84766 13.25H2C1.58579 13.25 1.25 12.9142 1.25 12.5C1.25 12.0858 1.58579 11.75 2 11.75H6.84766ZM14 11.75C14.4142 11.75 14.75 12.0858 14.75 12.5C14.75 12.9142 14.4142 13.25 14 13.25H12.6523C12.7142 13.0101 12.75 12.7592 12.75 12.5C12.75 12.2408 12.7142 11.9899 12.6523 11.75H14ZM3.09766 7.25C3.03583 7.48994 3 7.74075 3 8C3 8.25925 3.03583 8.51006 3.09766 8.75H2C1.58579 8.75 1.25 8.41421 1.25 8C1.25 7.58579 1.58579 7.25 2 7.25H3.09766ZM14 7.25C14.4142 7.25 14.75 7.58579 14.75 8C14.75 8.41421 14.4142 8.75 14 8.75H8.90234C8.96417 8.51006 9 8.25925 9 8C9 7.74075 8.96417 7.48994 8.90234 7.25H14ZM7.59766 2.75C7.53583 2.98994 7.5 3.24075 7.5 3.5C7.5 3.75925 7.53583 4.01006 7.59766 4.25H2C1.58579 4.25 1.25 3.91421 1.25 3.5C1.25 3.08579 1.58579 2.75 2 2.75H7.59766ZM14 2.75C14.4142 2.75 14.75 3.08579 14.75 3.5C14.75 3.91421 14.4142 4.25 14 4.25H13.4023C13.4642 4.01006 13.5 3.75925 13.5 3.5C13.5 3.24075 13.4642 2.98994 13.4023 2.75H14Z",
		circles: [
			{ cx: "6", cy: "8", r: "0.998596" },
			{ cx: "10.4999", cy: "3.5", r: "0.998657" },
			{ cx: "9.75015", cy: "12.5", r: "0.997986" },
		],
	};

	// src/dropdown-position.ts
	function getDropdownPosition(trigger, portalRoot, options = {}) {
		const { dropdownHeight = 0, gap = 4, allowAbove = true } = options;
		const triggerRect = trigger.getBoundingClientRect();
		const rootRect = portalRoot.getBoundingClientRect();
		const viewport = window.visualViewport;
		const viewportTop = viewport?.offsetTop ?? 0;
		const viewportLeft = viewport?.offsetLeft ?? 0;
		const viewportHeight = viewport?.height ?? window.innerHeight;
		const viewportWidth = viewport?.width ?? window.innerWidth;
		const margin = 8;
		const spaceBelow = Math.max(
			0,
			viewportTop + viewportHeight - triggerRect.bottom - gap - margin,
		);
		const spaceAbove = Math.max(0, triggerRect.top - viewportTop - gap - margin);
		const above = allowAbove && spaceBelow < dropdownHeight && spaceAbove > spaceBelow;
		let maxHeight = Math.min(options.maxHeight ?? 320, above ? spaceAbove : spaceBelow);
		const height = Math.min(dropdownHeight, maxHeight);
		const width = Math.min(
			options.width ?? triggerRect.width,
			Math.max(0, viewportWidth - margin * 2),
		);
		let left = Math.max(
			viewportLeft + margin,
			Math.min(triggerRect.left, viewportLeft + viewportWidth - width - margin),
		);
		let top = Math.max(
			viewportTop + margin,
			above ? triggerRect.top - height - gap : triggerRect.bottom + gap,
		);
		if (options.preferSide) {
			const sideRect = trigger.closest(".dialkit-panel-inner")?.getBoundingClientRect()
				?? triggerRect;
			const before = sideRect.left - width - gap;
			const after = sideRect.right + gap;
			if (before >= viewportLeft + margin) left = before;
			else if (after + width <= viewportLeft + viewportWidth - margin) left = after;
			maxHeight = Math.min(options.maxHeight ?? 480, viewportHeight - margin * 2);
			top = Math.max(
				viewportTop + margin,
				Math.min(
					triggerRect.top - 32,
					viewportTop + viewportHeight - Math.min(dropdownHeight, maxHeight) - margin,
				),
			);
		}
		return {
			top: options.fixed ? top : top - rootRect.top + portalRoot.scrollTop - portalRoot.clientTop,
			left: options.fixed
				? left
				: left - rootRect.left + portalRoot.scrollLeft - portalRoot.clientLeft,
			width,
			above,
			maxHeight,
		};
	}
	function observeDropdownPosition(trigger, update, popup) {
		let frame = 0;
		let disposed = false;
		let previous = "";
		const tick = () => {
			if (disposed) return;
			const floating = popup?.();
			if (
				floating?.isConnected && floating.style.position === "fixed"
				&& typeof floating.showPopover === "function" && !floating.matches(":popover-open")
			) {
				floating.setAttribute("popover", "manual");
				floating.showPopover();
			}
			const rect = trigger.getBoundingClientRect();
			const root = getDialKitPortalRoot(trigger)?.getBoundingClientRect();
			const viewport = window.visualViewport;
			const next = [
				rect.x,
				rect.y,
				rect.width,
				rect.height,
				root?.x,
				root?.y,
				popup?.()?.scrollHeight,
				window.innerWidth,
				window.innerHeight,
				viewport?.height,
				viewport?.offsetTop,
				viewport?.offsetLeft,
			].join(",");
			if (next !== previous) {
				previous = next;
				update();
			}
			if (!disposed) frame = requestAnimationFrame(tick);
		};
		tick();
		window.addEventListener("scroll", update, true);
		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			window.removeEventListener("scroll", update, true);
		};
	}
	function getDialKitPortalRoot(trigger) {
		return trigger?.closest(".dialkit-root") ?? null;
	}

	// src/control-keyboard.ts
	function sliderKeyValue(key, value, min, max, step, shift = false) {
		if (key === "Home") return min;
		if (key === "End") return max;
		const direction = ["ArrowRight", "ArrowUp", "PageUp"].includes(key)
			? 1
			: ["ArrowLeft", "ArrowDown", "PageDown"].includes(key)
			? -1
			: 0;
		if (!direction) return void 0;
		if (!(step > 0) || max <= min) return min;
		const amount = key.startsWith("Page") || shift ? 10 : 1;
		const position = (value - min) / step;
		const nextStep = direction > 0
			? Math.floor(position + 1e-9) + amount
			: Math.ceil(position - 1e-9) - amount;
		const next = min + nextStep * step;
		return Math.max(min, Math.min(max, Number(next.toPrecision(14))));
	}
	function handleSliderKey(event, value, min, max, step, change, edit) {
		if (event.target !== event.currentTarget || event.altKey || event.metaKey || event.ctrlKey) {
			return;
		}
		const next = sliderKeyValue(event.key, value, min, max, step, event.shiftKey);
		if (next === void 0 && event.key !== "Enter") return;
		event.preventDefault();
		event.stopPropagation();
		if (next === void 0) edit();
		else change(next);
	}
	function activateOnKey(event, activate) {
		if (event.target !== event.currentTarget || !["Enter", " "].includes(event.key)) return;
		event.preventDefault();
		event.stopPropagation();
		activate();
	}
	function optionKeyIndex(key, index, count, wrap = false) {
		if (!count) return void 0;
		if (key === "Home") return 0;
		if (key === "End") return count - 1;
		const delta = ["ArrowRight", "ArrowDown"].includes(key)
			? 1
			: ["ArrowLeft", "ArrowUp"].includes(key)
			? -1
			: 0;
		if (!delta) return void 0;
		return wrap ? (index + delta + count) % count : Math.max(0, Math.min(count - 1, index + delta));
	}
	function handleSegmentKey(event) {
		if (event.altKey || event.metaKey || event.ctrlKey) return;
		const group = event.currentTarget;
		const buttons = Array.from(group.querySelectorAll(".dialkit-segmented-button:not(:disabled)"));
		const next = optionKeyIndex(event.key, buttons.indexOf(event.target), buttons.length, true);
		if (next === void 0) return;
		event.preventDefault();
		event.stopPropagation();
		buttons[next].focus({ preventScroll: true });
		buttons[next].click();
	}
	var labelId = 0;
	function labelSegmentedControl(group) {
		if (group.hasAttribute("aria-label") || group.hasAttribute("aria-labelledby")) return;
		const label = group.closest(".dialkit-labeled-control")?.querySelector(
			".dialkit-labeled-control-label",
		);
		if (!label) {
			group.setAttribute("aria-label", "Options");
			return;
		}
		label.id || (label.id = `dialkit-segment-label-${++labelId}`);
		group.setAttribute("aria-labelledby", label.id);
	}
	function openDropdownOnKey(event, open) {
		if (
			!["ArrowDown", "ArrowUp"].includes(event.key) || event.altKey || event.metaKey
			|| event.ctrlKey
		) return;
		event.preventDefault();
		event.stopPropagation();
		open();
	}
	function adjacentTabStop(trigger, backwards = false) {
		const candidates = Array.from(
			trigger.ownerDocument.querySelectorAll(
				'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]',
			),
		);
		const stops = candidates.filter((el) =>
			el === trigger
			|| el.tabIndex >= 0 && !el.matches(":disabled") && el.getClientRects().length > 0
				&& getComputedStyle(el).visibility !== "hidden"
				&& !el.closest(
					'[inert], [aria-hidden="true"], .dialkit-select-dropdown, .dialkit-preset-dropdown, .dialkit-shortcuts-dropdown, .dialkit-color-popover',
				)
		);
		const index = stops.indexOf(trigger);
		return index < 0 ? void 0 : stops[index + (backwards ? -1 : 1)];
	}

	// src/color-control.ts
	function element(tag, className, text) {
		const el = document.createElement(tag);
		el.className = className;
		if (text) el.textContent = text;
		if (el instanceof HTMLButtonElement) el.type = "button";
		return el;
	}
	function mountColorControl(host, initial, presentation = "popover") {
		const inline = presentation === "inline";
		let props = initial;
		let color = parseColor(props.value) ?? { l: 0, c: 0, h: 0, a: 1 };
		let format = colorFormat(props.value);
		let lastEmitted;
		let popup;
		let stopPosition;
		let paintFrame = 0;
		let updatePicker = () => {
		};
		const row = element("div", "dialkit-color-control");
		const label = element("span", "dialkit-color-label");
		const inputs = element("div", "dialkit-color-inputs");
		const valueInput = element("input", "dialkit-color-value");
		valueInput.type = "text";
		valueInput.spellcheck = false;
		valueInput.autocomplete = "off";
		const swatch = element("button", "dialkit-color-swatch");
		swatch.setAttribute("aria-haspopup", "dialog");
		swatch.setAttribute("aria-expanded", "false");
		inputs.append(valueInput, swatch);
		row.append(label, inputs);
		host.append(row);
		if (inline) row.style.display = "none";
		const render = () => {
			label.textContent = props.label;
			valueInput.setAttribute("aria-label", `${props.label} color value`);
			if (document.activeElement !== valueInput) valueInput.value = props.value;
			valueInput.title = props.value;
			swatch.style.setProperty("--dial-color", props.value);
			swatch.setAttribute("aria-label", `Pick ${props.label.toLowerCase()} color`);
			updatePicker();
		};
		const commit = (next, nextFormat = format) => {
			format = nextFormat;
			color = format === "oklch" ? next : fitGamut(next, format === "p3" ? "p3" : "srgb");
			const value = formatColor(color, format);
			lastEmitted = value;
			props = { ...props, value };
			render();
			props.onChange(value);
		};
		const acceptText = (input) => {
			const parsed = parseColor(input.value);
			if (!parsed) {
				input.setAttribute("aria-invalid", "true");
				input.title = "Enter a hex, RGB, HSL, OKLCH, or Display P3 color";
				return false;
			}
			input.removeAttribute("aria-invalid");
			color = parsed;
			format = colorFormat(input.value);
			const value = input.value.trim();
			lastEmitted = value;
			props = { ...props, value };
			render();
			props.onChange(value);
			return true;
		};
		valueInput.addEventListener("change", () => acceptText(valueInput));
		valueInput.addEventListener("blur", () => {
			if (valueInput.getAttribute("aria-invalid")) {
				valueInput.value = props.value;
				valueInput.removeAttribute("aria-invalid");
			}
		});
		valueInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				if (acceptText(valueInput)) valueInput.blur();
			}
			if (e.key === "Escape") {
				valueInput.value = props.value;
				valueInput.removeAttribute("aria-invalid");
				valueInput.blur();
			}
			e.stopPropagation();
		});
		const close = (restoreFocus = false) => {
			stopPosition?.();
			stopPosition = void 0;
			cancelAnimationFrame(paintFrame);
			popup?.remove();
			popup = void 0;
			updatePicker = () => {
			};
			delete row.dataset.open;
			swatch.setAttribute("aria-expanded", "false");
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("focusin", focusOutside);
			if (restoreFocus) swatch.focus({ preventScroll: true });
		};
		const outside = (e) => {
			if (!popup?.contains(e.target) && !row.contains(e.target)) close();
		};
		const focusOutside = (e) => {
			if (!popup?.contains(e.target) && !row.contains(e.target)) close();
		};
		const open = () => {
			if (popup) {
				if (!inline) close();
				return;
			}
			const root = inline ? host : getDialKitPortalRoot(host) ?? host;
			popup = element("div", "dialkit-color-popover");
			popup.dataset.presentation = presentation;
			popup.style.position = inline ? "static" : "fixed";
			popup.setAttribute("role", inline ? "group" : "dialog");
			popup.setAttribute("aria-label", `${props.label} color picker`);
			const plane = element("div", "dialkit-color-plane");
			plane.setAttribute("role", "group");
			plane.setAttribute(
				"aria-label",
				"Color field; use arrow keys to adjust saturation and lightness",
			);
			plane.tabIndex = 0;
			const canvas = element("canvas", "dialkit-color-canvas");
			canvas.width = 252;
			canvas.height = 160;
			canvas.setAttribute("aria-hidden", "true");
			const marker = element("span", "dialkit-color-marker");
			marker.setAttribute("aria-hidden", "true");
			plane.append(canvas, marker);
			const tracks = element("div", "dialkit-color-tracks");
			function track(name, max, step, className) {
				const line = element("label", "dialkit-color-track-row");
				const nameEl = element("span", "", name);
				const input = element("input", `dialkit-color-track ${className}`);
				input.type = "range";
				input.min = "0";
				input.max = String(max);
				input.step = String(step);
				input.setAttribute("aria-label", name);
				line.append(nameEl, input);
				tracks.append(line);
				return input;
			}
			const hue = track("Hue", 360, 0.1, "dialkit-color-hue");
			const opacity = track("Opacity", 100, 1, "dialkit-color-opacity");
			hue.addEventListener("input", () => {
				const h = Number(hue.value);
				commit({ ...color, h, c: saturation * maxChroma(color.l, h, planeSpace()) });
			});
			opacity.addEventListener("input", () => commit({ ...color, a: Number(opacity.value) / 100 }));
			const formatRow = element("div", "dialkit-labeled-control dialkit-color-format-row");
			const formats = element("div", "dialkit-segmented dialkit-color-formats");
			formatRow.append(formats);
			formats.setAttribute("role", "radiogroup");
			formats.addEventListener("keydown", handleSegmentKey);
			formats.setAttribute("aria-label", "Color format");
			const formatPill = element("div", "dialkit-segmented-pill");
			formatPill.setAttribute("aria-hidden", "true");
			formats.append(formatPill);
			const formatButtons = ["hex", "oklch", "p3"].map((f) => {
				const button2 = element(
					"button",
					"dialkit-segmented-button dialkit-color-format",
					f === "p3" ? "Display P3" : f === "hex" ? "Hex" : "OKLCH",
				);
				button2.type = "button";
				button2.setAttribute("role", "radio");
				button2.addEventListener("click", () => commit(color, f));
				formats.append(button2);
				return button2;
			});
			const output = element("input", "dialkit-color-css-input");
			output.type = "text";
			output.spellcheck = false;
			output.setAttribute("aria-label", "CSS color");
			output.addEventListener("change", () => acceptText(output));
			output.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					acceptText(output);
				}
			});
			let lastHue = -1;
			let lastSpace = "";
			let lastHueTrack = "";
			let saturation = 0;
			const planeSpace = () => format === "hex" ? "srgb" : "p3";
			const ctx = canvas.getContext("2d", { colorSpace: "display-p3" });
			const canvasSpace = ctx?.getContextAttributes?.().colorSpace === "display-p3" ? "p3" : "srgb";
			const paint = () => {
				if (!ctx) return;
				const space = planeSpace();
				if (lastHue === color.h && lastSpace === space) return;
				lastHue = color.h;
				lastSpace = space;
				const pixels = ctx.createImageData(canvas.width, canvas.height);
				for (let y = 0; y < canvas.height; y++) {
					const l = 1 - y / (canvas.height - 1);
					const max = maxChroma(l, color.h, space);
					for (let x = 0; x < canvas.width; x++) {
						const sample = { l, c: x / (canvas.width - 1) * max, h: color.h, a: 1 };
						const rgb = colorToRgb(sample, canvasSpace);
						const index = (y * canvas.width + x) * 4;
						rgb.forEach((n, i) => {
							pixels.data[index + i] = Math.round(clamp(n) * 255);
						});
						pixels.data[index + 3] = 255;
					}
				}
				ctx.putImageData(pixels, 0, 0);
			};
			updatePicker = () => {
				popup?.setAttribute("aria-label", `${props.label} color picker`);
				const max = maxChroma(color.l, color.h, planeSpace());
				if (max > 0) saturation = clamp(color.c / max);
				marker.style.left = `${saturation * 100}%`;
				marker.style.top = `${(1 - color.l) * 100}%`;
				marker.style.background = formatColor({ ...color, a: 1 }, "oklch");
				hue.value = String(color.h);
				opacity.value = String(color.a * 100);
				hue.setAttribute("aria-valuetext", `${Math.round(color.h)} degrees`);
				opacity.setAttribute("aria-valuetext", `${Math.round(color.a * 100)} percent`);
				const hueTrackKey = `${color.l.toFixed(5)}:${saturation.toFixed(5)}:${planeSpace()}`;
				if (hueTrackKey !== lastHueTrack) {
					lastHueTrack = hueTrackKey;
					const stops = Array.from({ length: 73 }, (_, i) => {
						const h = i * 5;
						return formatColor({
							l: color.l,
							c: saturation * maxChroma(color.l, h, planeSpace()),
							h,
							a: 1,
						}, "oklch");
					});
					hue.style.setProperty(
						"--dial-color-track-bg",
						`linear-gradient(to right in oklab, ${stops.join(", ")})`,
					);
				}
				hue.style.setProperty("--dial-color-thumb", formatColor({ ...color, a: 1 }, "oklch"));
				opacity.style.setProperty("--dial-color-thumb", formatColor(color, "oklch"));
				opacity.style.setProperty("--dial-color-opaque", formatColor({ ...color, a: 1 }, "oklch"));
				formatButtons.forEach((button2, i) => {
					const active2 = ["hex", "oklch", "p3"][i] === format;
					button2.setAttribute("aria-checked", String(active2));
					button2.tabIndex = active2 ? 0 : -1;
					button2.dataset.active = String(active2);
					if (active2) formatPill.style.transform = `translateX(${i * 100}%)`;
				});
				if (document.activeElement !== output) {
					output.value = props.value;
					output.removeAttribute("aria-invalid");
				}
				output.title = props.value;
				cancelAnimationFrame(paintFrame);
				paintFrame = requestAnimationFrame(paint);
			};
			const move = (e) => {
				const rect = plane.getBoundingClientRect();
				const l = 1 - clamp((e.clientY - rect.top) / rect.height);
				saturation = clamp((e.clientX - rect.left) / rect.width);
				commit({ ...color, l, c: saturation * maxChroma(l, color.h, planeSpace()) });
			};
			plane.addEventListener("pointerdown", (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				plane.focus({ preventScroll: true });
				plane.setPointerCapture(e.pointerId);
				move(e);
			});
			plane.addEventListener("keydown", (e) => {
				if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
				e.preventDefault();
				const step = e.shiftKey ? 0.1 : 0.01;
				const l = clamp(color.l + (e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0));
				saturation = clamp(
					saturation + (e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0),
				);
				commit({ ...color, l, c: saturation * maxChroma(l, color.h, planeSpace()) });
			});
			plane.addEventListener("pointermove", (e) => {
				if (plane.hasPointerCapture(e.pointerId)) move(e);
			});
			plane.addEventListener("pointerup", (e) => {
				if (plane.hasPointerCapture(e.pointerId)) plane.releasePointerCapture(e.pointerId);
			});
			popup.addEventListener("keydown", (e) => {
				if (inline) return;
				if (e.key === "Escape") {
					e.preventDefault();
					close(true);
				}
				if (e.key === "Tab") {
					const first = formatButtons.find((button2) => button2.tabIndex === 0);
					if (
						e.shiftKey && document.activeElement === first
						|| !e.shiftKey && document.activeElement === output
					) {
						swatch.focus({ preventScroll: true });
						close();
					}
				}
				e.stopPropagation();
			});
			popup.append(formatRow, plane, tracks, output);
			root.append(popup);
			const updatePosition = () => {
				if (!popup) return;
				if (!host.isConnected || row.getClientRects().length === 0) {
					close();
					return;
				}
				const p = getDropdownPosition(row, root, {
					dropdownHeight: popup.scrollHeight + 2,
					width: 280,
					maxHeight: 480,
					preferSide: true,
					fixed: true,
					gap: 8,
				});
				Object.assign(popup.style, {
					left: `${p.left}px`,
					top: `${p.top}px`,
					width: `${p.width}px`,
					maxHeight: `${p.maxHeight}px`,
					transformOrigin: p.above ? "bottom" : "top",
				});
			};
			updatePicker();
			if (inline) return;
			stopPosition = observeDropdownPosition(row, updatePosition, () => popup);
			row.dataset.open = "true";
			swatch.setAttribute("aria-expanded", "true");
			document.addEventListener("pointerdown", outside);
			document.addEventListener("focusin", focusOutside);
			formatButtons.find((button2) => button2.getAttribute("aria-checked") === "true")?.focus({
				preventScroll: true,
			});
		};
		swatch.addEventListener("click", open);
		render();
		if (inline) open();
		return {
			update(next) {
				const parsed = parseColor(next.value);
				if (parsed && next.value !== lastEmitted && next.value !== props.value) {
					color = { ...parsed, h: parsed.c < 1e-7 ? color.h : parsed.h };
					format = colorFormat(next.value);
				}
				props = next;
				render();
			},
			destroy() {
				close();
				row.remove();
			},
		};
	}

	// src/image-control.ts
	var imageControlId = 0;
	var MAX_FILE_SIZE = 10 * 1024 * 1024;
	function element2(tag, className, text) {
		const el = document.createElement(tag);
		el.className = className;
		if (text) el.textContent = text;
		if (tag === "button") el.type = "button";
		return el;
	}
	function icon(kind) {
		const svg2 = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg2.setAttribute("viewBox", "0 0 24 24");
		svg2.setAttribute("fill", "none");
		svg2.setAttribute("stroke", "currentColor");
		svg2.setAttribute("stroke-width", "1.5");
		svg2.setAttribute("stroke-linecap", "round");
		svg2.setAttribute("stroke-linejoin", "round");
		svg2.setAttribute("aria-hidden", "true");
		const path = document.createElementNS(svg2.namespaceURI, "path");
		path.setAttribute(
			"d",
			kind === "upload"
				? "M12 16V3m-4 4 4-4 4 4M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"
				: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm-2 13 5-5 4 4 3-3 6 6M15 7h.01",
		);
		svg2.append(path);
		return svg2;
	}
	function imageLabel(value) {
		if (!value) return "No image";
		if (value.startsWith("data:") || value.startsWith("blob:")) return "Uploaded image";
		const name = value.split(/[?#]/)[0].split("/").filter(Boolean).pop();
		try {
			return name ? decodeURIComponent(name) : "Image";
		} catch {
			return name || "Image";
		}
	}
	function imageOptions(options = [], uploaded = [], value = "") {
		const unique = /* @__PURE__ */ new Map();
		for (const option of [...options, ...uploaded]) {
			const item = typeof option === "string"
				? { value: option, label: imageLabel(option) }
				: option;
			if (item.value && !unique.has(item.value)) unique.set(item.value, item);
		}
		if (value && !unique.has(value)) unique.set(value, { value, label: imageLabel(value) });
		return [...unique.values()];
	}
	function preview(className) {
		const frame = element2("span", `dialkit-image-frame ${className}`);
		const fallback = element2("span", "dialkit-image-fallback");
		fallback.append(icon("image"));
		const img = element2("img", "dialkit-image-img");
		img.alt = "";
		img.draggable = false;
		img.decoding = "async";
		img.hidden = true;
		frame.append(fallback, img);
		let current;
		img.addEventListener("load", () => {
			img.hidden = false;
			fallback.hidden = true;
			frame.removeAttribute("title");
		});
		img.addEventListener("error", () => {
			img.hidden = true;
			fallback.hidden = false;
			frame.title = "Image unavailable";
		});
		return {
			frame,
			update(value) {
				if (value === current) return;
				current = value;
				img.hidden = true;
				fallback.hidden = false;
				frame.removeAttribute("title");
				if (value) img.src = value;
				else img.removeAttribute("src");
			},
		};
	}
	function mountImageControl(host, initial, presentation = "popover") {
		const inline = presentation === "inline";
		let props = initial;
		const uploaded = [];
		let popup;
		let stopPosition;
		let updatePicker = () => {
		};
		let resetUpload = () => {
		};
		let reader;
		let uploadRequest = 0;
		const popupId = `dialkit-image-picker-${++imageControlId}`;
		const trigger = element2("button", "dialkit-image-control");
		const label = element2("span", "dialkit-image-label");
		const name = element2("span", "dialkit-image-value");
		const thumbnail = preview("dialkit-image-thumbnail");
		trigger.setAttribute("aria-haspopup", "dialog");
		trigger.setAttribute("aria-expanded", "false");
		trigger.append(label, name, thumbnail.frame);
		const fileInput = element2("input", "dialkit-image-file");
		fileInput.type = "file";
		fileInput.accept = "image/*";
		fileInput.hidden = true;
		host.append(trigger, fileInput);
		if (inline) trigger.style.display = "none";
		const choices = () => imageOptions(props.options, uploaded, props.value);
		const render = () => {
			label.textContent = props.label;
			name.textContent = choices().find((item) => item.value === props.value)?.label ?? "No image";
			trigger.setAttribute(
				"aria-label",
				`Choose ${props.label.toLowerCase()} image: ${name.textContent}`,
			);
			thumbnail.update(props.value);
			updatePicker();
		};
		const commit = (value) => {
			props = { ...props, value };
			render();
			props.onChange(value);
		};
		const close = (restoreFocus = false) => {
			uploadRequest++;
			reader?.abort();
			reader = void 0;
			fileInput.onchange = null;
			stopPosition?.();
			stopPosition = void 0;
			popup?.remove();
			popup = void 0;
			updatePicker = () => {
			};
			resetUpload = () => {
			};
			delete trigger.dataset.open;
			trigger.setAttribute("aria-expanded", "false");
			trigger.removeAttribute("aria-controls");
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("focusin", focusOutside);
			if (restoreFocus) trigger.focus({ preventScroll: true });
		};
		const outside = (event) => {
			if (!popup?.contains(event.target) && !host.contains(event.target)) close();
		};
		const focusOutside = (event) => {
			if (!popup?.contains(event.target) && !host.contains(event.target)) close();
		};
		const open = () => {
			if (popup) {
				if (!inline) close();
				return;
			}
			const root = inline ? host : getDialKitPortalRoot(host) ?? host;
			popup = element2("div", "dialkit-image-popover");
			popup.dataset.presentation = presentation;
			popup.style.position = inline ? "static" : "fixed";
			popup.id = popupId;
			popup.setAttribute("role", inline ? "group" : "dialog");
			const heading = element2("div", "dialkit-image-heading");
			const title = element2("span", "dialkit-image-title");
			const clear = element2("button", "dialkit-image-clear", "Remove");
			clear.addEventListener("click", () => {
				commit("");
				if (!inline) close(true);
			});
			heading.append(title, clear);
			const grid = element2("div", "dialkit-image-grid");
			grid.setAttribute("role", "group");
			grid.setAttribute("aria-label", "Available images");
			const empty = element2("div", "dialkit-image-empty", "Choose an image to get started.");
			const upload = element2("button", "dialkit-button dialkit-image-upload");
			const uploadText = element2("span", "", "Upload image");
			upload.append(icon("upload"), uploadText);
			const status = element2("div", "dialkit-image-status");
			status.setAttribute("role", "status");
			status.hidden = true;
			upload.addEventListener("click", () => {
				if (!busy) fileInput.click();
			});
			let buttons = [];
			let previousItems = [];
			let busy = false;
			const setBusy = (next) => {
				busy = next;
				upload.setAttribute("aria-disabled", String(next));
				uploadText.textContent = next ? "Loading image\u2026" : "Upload image";
				grid.setAttribute("aria-busy", String(next));
			};
			resetUpload = () => {
				uploadRequest++;
				reader?.abort();
				reader = void 0;
				setBusy(false);
				status.hidden = true;
			};
			const acceptFile = (file) => {
				if (busy) return;
				status.hidden = true;
				if (!file.type.startsWith("image/") || file.size > MAX_FILE_SIZE) {
					status.textContent = file.size > MAX_FILE_SIZE
						? "Choose an image smaller than 10 MB."
						: "Choose an image file, such as PNG, JPG, WebP, GIF, or SVG.";
					status.hidden = false;
					return;
				}
				const request = ++uploadRequest;
				setBusy(true);
				const fail = () => {
					if (request !== uploadRequest) return;
					setBusy(false);
					status.textContent = "This image could not be opened. Try another file.";
					status.hidden = false;
				};
				reader = new FileReader();
				reader.addEventListener("error", fail);
				reader.addEventListener("load", () => {
					if (request !== uploadRequest) return;
					const value = reader?.result;
					reader = void 0;
					if (typeof value !== "string") {
						fail();
						return;
					}
					const check = new Image();
					check.onerror = fail;
					check.onload = () => {
						if (request !== uploadRequest) return;
						setBusy(false);
						if (!uploaded.some((item) => item.value === value)) {
							uploaded.push({ value, label: file.name });
						}
						commit(value);
						buttons.find((button2) => button2.getAttribute("aria-pressed") === "true")?.focus({
							preventScroll: true,
						});
					};
					check.src = value;
				});
				reader.readAsDataURL(file);
			};
			fileInput.onchange = () => {
				const file = fileInput.files?.[0];
				fileInput.value = "";
				if (file) acceptFile(file);
			};
			popup.addEventListener("dragover", (event) => {
				if (!event.dataTransfer?.types.includes("Files")) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
				popup.dataset.dragging = "true";
			});
			popup.addEventListener("dragleave", (event) => {
				if (!popup?.contains(event.relatedTarget)) delete popup.dataset.dragging;
			});
			popup.addEventListener("drop", (event) => {
				event.preventDefault();
				delete popup.dataset.dragging;
				const file = event.dataTransfer?.files[0];
				if (file) acceptFile(file);
			});
			grid.addEventListener("keydown", (event) => {
				if (event.metaKey || event.ctrlKey || event.altKey) return;
				const index = buttons.indexOf(document.activeElement);
				if (index < 0) return;
				const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
				const next = event.key === "ArrowRight"
					? index + 1
					: event.key === "ArrowLeft"
					? index - 1
					: event.key === "ArrowDown"
					? index + columns
					: event.key === "ArrowUp"
					? index - columns
					: event.key === "Home"
					? 0
					: event.key === "End"
					? buttons.length - 1
					: void 0;
				if (next === void 0) return;
				event.preventDefault();
				const button2 = buttons[Math.max(0, Math.min(buttons.length - 1, next))];
				buttons.forEach((item) => {
					item.tabIndex = item === button2 ? 0 : -1;
				});
				button2.focus({ preventScroll: true });
				button2.scrollIntoView({ block: "nearest" });
			});
			popup.addEventListener("keydown", (event) => {
				if (inline) return;
				event.stopPropagation();
				if (event.key === "Escape") {
					event.preventDefault();
					close(true);
				}
				if (event.key === "Tab") {
					const first = clear.hidden
						? buttons.find((button2) => button2.tabIndex === 0) ?? upload
						: clear;
					if (
						event.shiftKey && document.activeElement === first
						|| !event.shiftKey && document.activeElement === upload
					) {
						const next = adjacentTabStop(trigger, event.shiftKey);
						close(true);
						if (next) {
							event.preventDefault();
							next.focus();
						}
					}
				}
			});
			updatePicker = () => {
				popup?.setAttribute("aria-label", `${props.label} image picker`);
				title.textContent = props.label;
				clear.hidden = !props.value;
				clear.setAttribute("aria-label", `Remove ${props.label.toLowerCase()} image`);
				const items = choices();
				empty.hidden = items.length > 0;
				grid.hidden = items.length === 0;
				if (
					items.length !== previousItems.length
					|| items.some((item, i) =>
						item.value !== previousItems[i].value || item.label !== previousItems[i].label
					)
				) {
					const focusedIndex = buttons.indexOf(document.activeElement);
					previousItems = items;
					buttons = items.map((item) => {
						const button2 = element2("button", "dialkit-image-option");
						button2.setAttribute("aria-label", item.label);
						button2.title = item.label;
						const thumb = preview("dialkit-image-option-preview");
						thumb.update(item.value);
						button2.append(thumb.frame);
						button2.addEventListener("click", () => {
							resetUpload();
							commit(item.value);
						});
						return button2;
					});
					grid.replaceChildren(...buttons);
					if (focusedIndex >= 0) {
						buttons[Math.min(focusedIndex, buttons.length - 1)]?.focus({ preventScroll: true });
					}
				}
				const selected = items.findIndex((item) => item.value === props.value);
				buttons.forEach((button2, index) => {
					button2.setAttribute("aria-pressed", String(index === selected));
					button2.tabIndex = index === Math.max(0, selected) ? 0 : -1;
				});
			};
			popup.append(heading, grid, empty, upload, status);
			root.append(popup);
			render();
			const position = () => {
				if (!popup) return;
				if (!host.isConnected || trigger.getClientRects().length === 0) {
					close();
					return;
				}
				const p = getDropdownPosition(trigger, root, {
					dropdownHeight: popup.scrollHeight + 2,
					width: 320,
					maxHeight: 560,
					preferSide: true,
					fixed: true,
					gap: 8,
				});
				Object.assign(popup.style, {
					left: `${p.left}px`,
					top: `${p.top}px`,
					width: `${p.width}px`,
					maxHeight: `${p.maxHeight}px`,
					transformOrigin: p.above ? "bottom" : "top",
				});
			};
			if (inline) return;
			stopPosition = observeDropdownPosition(trigger, position, () => popup);
			trigger.dataset.open = "true";
			trigger.setAttribute("aria-expanded", "true");
			trigger.setAttribute("aria-controls", popupId);
			document.addEventListener("pointerdown", outside);
			document.addEventListener("focusin", focusOutside);
			(buttons.find((button2) => button2.tabIndex === 0) ?? upload).focus({ preventScroll: true });
		};
		trigger.addEventListener("click", open);
		trigger.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Escape") {
				event.preventDefault();
				close();
			}
			if (event.key === "ArrowDown" && !popup) {
				event.preventDefault();
				open();
			}
		});
		render();
		if (inline) open();
		return {
			update(next) {
				if (next.value !== props.value) resetUpload();
				props = next;
				render();
			},
			destroy() {
				close();
				fileInput.onchange = null;
				trigger.remove();
				fileInput.remove();
			},
		};
	}

	// src/dial-pad-control.ts
	var nextId2 = 0;
	function element3(tag, className, text) {
		const el = document.createElement(tag);
		el.className = className;
		if (text) el.textContent = text;
		return el;
	}
	function mountDialPad(host, initial) {
		let props = initial;
		let value = normalizePadValue(props.value, props);
		let drag;
		const root = element3("div", "dialkit-pad");
		const fields = element3("div", "dialkit-pad-fields");
		const caption = element3("div", "dialkit-pad-caption");
		const label = element3("span", "dialkit-pad-label");
		caption.append(label);
		fields.append(caption);
		const surface = element3("div", "dialkit-pad-surface");
		surface.tabIndex = 0;
		surface.setAttribute("role", "group");
		const plane = element3("div", "dialkit-pad-plane");
		plane.setAttribute("aria-hidden", "true");
		const grid = element3("div", "dialkit-pad-grid");
		grid.setAttribute("aria-hidden", "true");
		for (let index = 1; index < PAD_GRID_DIVISIONS; index++) {
			const vertical = element3("span", "dialkit-pad-grid-line dialkit-pad-grid-vertical");
			const horizontal = element3("span", "dialkit-pad-grid-line dialkit-pad-grid-horizontal");
			vertical.style.left = `${index / PAD_GRID_DIVISIONS * 100}%`;
			horizontal.style.top = `${index / PAD_GRID_DIVISIONS * 100}%`;
			grid.append(vertical, horizontal);
		}
		const center = element3("span", "dialkit-pad-center");
		const point = element3("span", "dialkit-pad-point");
		plane.append(center, point);
		surface.append(grid, plane);
		const instructions = element3(
			"span",
			"dialkit-pad-instructions",
			"Arrow keys adjust each axis. Shift adjusts by ten steps. Home resets both axes. Hold Shift while dragging to lock an axis.",
		);
		instructions.id = `dialkit-pad-help-${++nextId2}`;
		surface.setAttribute("aria-describedby", instructions.id);
		const inputs = ["x", "y"].map((axis) => {
			const field = element3("label", "dialkit-pad-field");
			const name = element3("span", "dialkit-pad-axis");
			const input = element3("input", "dialkit-pad-value");
			input.type = "text";
			input.inputMode = "decimal";
			input.autocomplete = "off";
			input.spellcheck = false;
			input.setAttribute("role", "spinbutton");
			field.append(name, input);
			fields.append(field);
			input.addEventListener("focus", () => input.select());
			input.addEventListener("blur", () => {
				const number2 = input.value.trim() === "" ? NaN : Number(input.value);
				if (Number.isFinite(number2)) commit({ ...value, [axis]: number2 });
				input.value = String(value[axis]);
			});
			input.addEventListener("keydown", (event) => {
				event.stopPropagation();
				if (event.key === "Enter" || event.key === "Escape") {
					event.preventDefault();
					if (event.key === "Escape") input.value = String(value[axis]);
					input.blur();
					surface.focus({ preventScroll: true });
				} else if (
					!event.altKey && !event.metaKey && !event.ctrlKey
					&& ["ArrowUp", "ArrowDown"].includes(event.key)
				) {
					event.preventDefault();
					const range = resolvePadAxis(props[axis]);
					const draft = input.value.trim() === "" ? NaN : Number(input.value);
					const current = Number.isFinite(draft) ? draft : value[axis];
					const direction = event.key === "ArrowUp" ? 1 : -1;
					commit({
						...value,
						[axis]: snapPadAxis(
							current + direction * range.step * (event.shiftKey ? 10 : 1),
							range,
						),
					});
					input.value = String(value[axis]);
				}
			});
			return { axis, name, input };
		});
		root.append(fields, surface, instructions);
		host.append(root);
		function render() {
			label.textContent = props.label;
			label.title = props.label;
			const names = { x: props.labels?.x ?? "X", y: props.labels?.y ?? "Y" };
			surface.setAttribute(
				"aria-label",
				`${props.label}: ${names.x} ${value.x}, ${names.y} ${value.y}`,
			);
			inputs.forEach(({ axis, name, input }) => {
				const range = resolvePadAxis(props[axis]);
				name.textContent = names[axis];
				name.title = names[axis];
				input.setAttribute("aria-label", `${props.label} ${names[axis]}`);
				input.setAttribute("aria-valuemin", String(range.min));
				input.setAttribute("aria-valuemax", String(range.max));
				input.setAttribute("aria-valuenow", String(value[axis]));
				if (document.activeElement !== input) input.value = String(value[axis]);
				const fraction = (value[axis] - range.min) / (range.max - range.min);
				point.style[axis === "x" ? "left" : "top"] = `${
					(axis === "x" ? fraction : 1 - fraction) * 100
				}%`;
			});
		}
		function commit(next) {
			const normalized = normalizePadValue(next, props);
			if (normalized.x === value.x && normalized.y === value.y) return;
			value = normalized;
			render();
			props.onChange({ ...value });
		}
		function endDrag() {
			const id = drag?.id;
			drag = void 0;
			delete surface.dataset.dragging;
			if (id !== void 0 && surface.hasPointerCapture(id)) surface.releasePointerCapture(id);
		}
		function move(event, released = false) {
			if (!drag || event.pointerId !== drag.id) return;
			if (
				Math.max(Math.abs(event.clientX - drag.start.x), Math.abs(event.clientY - drag.start.y))
					>= 3
			) {
				drag.moved = true;
				surface.dataset.dragging = "true";
			}
			const bounds = plane.getBoundingClientRect();
			if (!bounds.width || !bounds.height) return;
			let x = event.clientX - drag.offset.x;
			let y = event.clientY - drag.offset.y;
			if (released && !drag.moved && !event.shiftKey) {
				const gridBounds = grid.getBoundingClientRect();
				const intersection = padGridIntersection(
					event.clientX - gridBounds.left,
					event.clientY - gridBounds.top,
					gridBounds.width,
					gridBounds.height,
				);
				if (intersection) {
					x = gridBounds.left + intersection.x;
					y = gridBounds.top + intersection.y;
				}
			}
			const next = padValueFromPoint(
				(x - bounds.left) / bounds.width,
				(y - bounds.top) / bounds.height,
				props,
			);
			if (event.shiftKey) {
				if (!drag.lock) {
					const dx = Math.abs(event.clientX - drag.start.x);
					const dy = Math.abs(event.clientY - drag.start.y);
					if (Math.max(dx, dy) < 3) return;
					drag.lock = dx >= dy ? "x" : "y";
					drag.lockValue = { ...value };
				}
				const fixed = drag.lock === "x" ? "y" : "x";
				next[fixed] = drag.lockValue[fixed];
			} else {
				drag.lock = void 0;
				drag.lockValue = void 0;
			}
			commit(next);
		}
		surface.addEventListener("dblclick", () => commit(normalizePadValue(void 0, props)));
		surface.addEventListener("pointerdown", (event) => {
			if (event.button !== 0 || drag) return;
			event.preventDefault();
			surface.focus({ preventScroll: true });
			const bounds = point.getBoundingClientRect();
			const onPoint = event.target === point;
			drag = {
				id: event.pointerId,
				start: { x: event.clientX, y: event.clientY },
				value: { ...value },
				offset: onPoint
					? {
						x: event.clientX - bounds.left - bounds.width / 2,
						y: event.clientY - bounds.top - bounds.height / 2,
					}
					: { x: 0, y: 0 },
				moved: false,
			};
			surface.setPointerCapture(event.pointerId);
			move(event);
		});
		surface.addEventListener("pointermove", move);
		surface.addEventListener("pointerup", (event) => {
			if (event.pointerId !== drag?.id) return;
			move(event, true);
			endDrag();
		});
		surface.addEventListener("pointercancel", (event) => {
			if (event.pointerId === drag?.id) endDrag();
		});
		surface.addEventListener("lostpointercapture", (event) => {
			if (event.pointerId === drag?.id) endDrag();
		});
		surface.addEventListener("keydown", (event) => {
			if (event.altKey || event.metaKey || event.ctrlKey) return;
			const next = padValueFromKey(value, event.key, event.shiftKey, props);
			if (next || event.key === "Home" || event.key === "Escape" && drag) {
				event.preventDefault();
				event.stopPropagation();
				if (next) commit(next);
				else if (event.key === "Home") {
					endDrag();
					commit(normalizePadValue(void 0, props));
				} else if (drag) {
					const start = drag.value;
					endDrag();
					commit(start);
				}
			}
		});
		render();
		return {
			update(next) {
				props = next;
				value = normalizePadValue(next.value, props);
				render();
			},
			destroy() {
				endDrag();
				root.remove();
			},
		};
	}

	// src/shortcut-utils.ts
	function getEffectiveStep(control, shortcut) {
		const min = control.min ?? 0;
		const max = control.max ?? 1;
		const range = max - min;
		const mode = shortcut.mode ?? "normal";
		return mode === "fine" ? range * 0.01 : mode === "coarse" ? range * 0.1 : control.step ?? 1;
	}
	function applySliderDelta(panelId, path, control, effectiveStep, direction) {
		const currentValue = DialStore.getValue(panelId, path);
		const min = control.min ?? 0;
		const max = control.max ?? 1;
		const newValue = Math.max(min, Math.min(max, currentValue + direction * effectiveStep));
		DialStore.updateValue(panelId, path, roundValue(newValue, effectiveStep, min, max));
	}
	function snapToDecile(rawValue, min, max) {
		const normalized = (rawValue - min) / (max - min);
		const nearest = Math.round(normalized * 10) / 10;
		if (Math.abs(normalized - nearest) <= 0.03125) {
			return min + nearest * (max - min);
		}
		return rawValue;
	}
	function isInputFocused() {
		const el = document.activeElement;
		if (!el) return false;
		const tag = el.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA") return true;
		if (
			el.closest(
				'select, button, [role="slider"], [role="radio"], [role="listbox"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="button"]',
			)
		) return true;
		if (el.contentEditable === "true") return true;
		return false;
	}
	function getActiveModifier(e) {
		if (e.altKey) return "alt";
		if (e.shiftKey) return "shift";
		if (e.metaKey) return "meta";
		return void 0;
	}
	function findControl(controls, path) {
		for (const control of controls) {
			if (control.path === path) return control;
			if (control.type === "folder" && control.children) {
				const found = findControl(control.children, path);
				if (found) return found;
			}
		}
		return null;
	}
	var DRAG_SENSITIVITY = 4;
	function formatInteractionLabel(interaction) {
		switch (interaction) {
			case "drag":
				return "Drag";
			case "move":
				return "Move";
			case "scroll-only":
				return "Scroll";
			default:
				return "Scroll";
		}
	}
	function formatSliderShortcut(sc) {
		const interaction = sc.interaction ?? "scroll";
		const actionLabel = formatInteractionLabel(interaction);
		if (!sc.key) return actionLabel;
		const mod = formatModifier(sc.modifier);
		return `${mod}${sc.key.toUpperCase()}+${actionLabel}`;
	}
	function formatToggleShortcut(sc) {
		if (!sc.key) return "Press";
		const mod = formatModifier(sc.modifier);
		return `${mod}${sc.key.toUpperCase()}`;
	}
	function formatModifier(modifier) {
		return modifier === "alt"
			? "\u2325"
			: modifier === "shift"
			? "\u21E7"
			: modifier === "meta"
			? "\u2318"
			: "";
	}

	// src/text-autosize.ts
	function observeTextSize(input) {
		const row = input.parentElement;
		const mirror = input.ownerDocument.createElement("textarea");
		mirror.className = input.className;
		mirror.rows = 1;
		mirror.tabIndex = -1;
		mirror.readOnly = true;
		mirror.inert = true;
		mirror.setAttribute("aria-hidden", "true");
		Object.assign(mirror.style, {
			position: "absolute",
			visibility: "hidden",
			pointerEvents: "none",
			top: "0",
			left: "0",
			height: "0",
			minHeight: "0",
			maxHeight: "none",
			overflow: "hidden",
			transition: "none",
		});
		row.append(mirror);
		let frame = 0;
		let width = 0;
		let disposed = false;
		const update = () => {
			if (disposed || !input.isConnected || !input.offsetWidth) return;
			const style = getComputedStyle(input);
			const lineHeight = parseFloat(style.lineHeight);
			const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
			const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
			const gutter = Math.max(0, input.offsetWidth - input.clientWidth - border);
			row.style.setProperty("--dial-text-gutter", `${gutter}px`);
			mirror.style.width = style.width;
			mirror.value = input.value || input.placeholder;
			const minimum = lineHeight + padding + border;
			const maximum = lineHeight * 5 + padding + border;
			const contentHeight = mirror.scrollHeight + border;
			const height = Math.max(minimum, Math.min(maximum, contentHeight));
			input.style.height = `${height}px`;
			input.style.overflowY = contentHeight > maximum ? "auto" : "hidden";
			if (contentHeight <= maximum) input.scrollTop = 0;
			const rowStyle = getComputedStyle(row);
			const rowInsets = parseFloat(rowStyle.paddingTop) + parseFloat(rowStyle.paddingBottom)
				+ parseFloat(rowStyle.borderTopWidth) + parseFloat(rowStyle.borderBottomWidth);
			row.style.height = `${height + rowInsets}px`;
			if (!row.hasAttribute("data-autosized")) {
				void row.offsetHeight;
				row.setAttribute("data-autosized", "true");
			}
		};
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(update);
		};
		const resize = new ResizeObserver(() => {
			if (input.offsetWidth === width) return;
			width = input.offsetWidth;
			schedule();
		});
		resize.observe(input);
		input.addEventListener("input", update);
		input.ownerDocument.fonts?.addEventListener("loadingdone", schedule);
		update();
		return {
			update,
			destroy() {
				disposed = true;
				cancelAnimationFrame(frame);
				resize.disconnect();
				input.removeEventListener("input", update);
				input.ownerDocument.fonts?.removeEventListener("loadingdone", schedule);
				mirror.remove();
				row.removeAttribute("data-autosized");
				row.style.removeProperty("height");
				row.style.removeProperty("--dial-text-gutter");
			},
		};
	}

	// src/panel-size.ts
	function measurePanelHeight(content) {
		const panel = content.parentElement;
		if (!panel) return content.offsetHeight;
		const style = getComputedStyle(panel);
		const chrome = style.boxSizing === "border-box"
			? [style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth]
				.reduce((total, value) => total + (parseFloat(value) || 0), 0)
			: 0;
		return content.offsetHeight + chrome;
	}
	function observePanelHeader(folder) {
		const header = folder.firstElementChild;
		if (!header) {
			return () => {
			};
		}
		const update = () => {
			folder.style.setProperty("--dial-panel-header-height", `${header.offsetHeight}px`);
		};
		const observer = new ResizeObserver(update);
		observer.observe(header);
		update();
		return () => {
			observer.disconnect();
			folder.style.removeProperty("--dial-panel-header-height");
		};
	}
	var panelFolds = /* @__PURE__ */ new WeakMap();
	function finishSectionFold(section) {
		for (const element5 of [section.content, section.toolbar]) {
			element5.style.display = section.open ? "" : "none";
			element5.style.removeProperty("height");
			element5.inert = !section.open;
		}
	}
	function createPanelSectionTransition(folder, initiallyOpen) {
		const content = folder.querySelector(":scope > .dialkit-folder-content");
		const toolbar = folder.querySelector(
			":scope > .dialkit-folder-header > .dialkit-panel-section-toolbar-clip",
		);
		let open = initiallyOpen;
		let panel = null;
		finishSectionFold({ content, toolbar, open });
		return {
			setOpen(next) {
				if (next === open) return;
				open = next;
				panel = folder.closest(".dialkit-panel-inner");
				if (!panel) {
					finishSectionFold({ content, toolbar, open });
					return;
				}
				const root = panel.querySelector(":scope > .dialkit-folder-root");
				const shell = panel.closest(".dialkit-panel");
				const inline = panel.classList.contains("dialkit-panel-inline");
				let group = panelFolds.get(panel);
				if (!group) {
					group = { sections: /* @__PURE__ */ new Map(), frame: 0 };
					panelFolds.set(panel, group);
				}
				cancelAnimationFrame(group.frame);
				const panelFrom = parseFloat(getComputedStyle(panel).height);
				const scrollFrom = panel.scrollTop;
				const section = group.sections.get(folder) ?? {
					content,
					toolbar,
					open,
					fromContent: 0,
					toContent: 0,
					fromToolbar: 0,
					toToolbar: 0,
				};
				section.open = open;
				group.sections.set(folder, section);
				for (const fold of group.sections.values()) {
					fold.fromContent = fold.content.offsetHeight;
					fold.fromToolbar = fold.toolbar.offsetHeight;
					for (
						const [element5, height] of [[fold.content, fold.fromContent], [
							fold.toolbar,
							fold.fromToolbar,
						]]
					) {
						element5.style.height = `${height}px`;
						element5.style.display = "";
						element5.inert = !fold.open;
					}
					fold.toContent = fold.open ? fold.content.firstElementChild.offsetHeight : 0;
					fold.toToolbar = fold.open ? fold.toolbar.firstElementChild.offsetHeight : 0;
				}
				const fullTarget = measurePanelHeight(root) + [...group.sections.values()].reduce(
					(delta, fold) =>
						delta + fold.toContent - fold.fromContent + fold.toToolbar - fold.fromToolbar,
					0,
				);
				const limits = [window.innerHeight - 32, parseFloat(getComputedStyle(panel).maxHeight)];
				if (shell) limits.push(parseFloat(getComputedStyle(shell).maxHeight));
				const panelTo = Math.min(fullTarget, ...limits.filter(Number.isFinite));
				const scrollTo = Math.min(scrollFrom, Math.max(0, fullTarget - panelTo));
				const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 260;
				const started = performance.now();
				const activePanel = panel;
				const activeGroup = group;
				const heightHost = activePanel.parentElement;
				activePanel.setAttribute("data-folding", "true");
				const tick = (now) => {
					const time = duration === 0 ? 1 : Math.min(1, Math.max(0, (now - started) / duration));
					const progress = 1 - (1 - time) ** 3;
					for (const fold of activeGroup.sections.values()) {
						fold.content.style.height = `${
							fold.fromContent + (fold.toContent - fold.fromContent) * progress
						}px`;
						fold.toolbar.style.height = `${
							fold.fromToolbar + (fold.toToolbar - fold.fromToolbar) * progress
						}px`;
					}
					if (!inline) {
						heightHost.style.setProperty(
							"--dial-panel-fold-height",
							`${panelFrom + (panelTo - panelFrom) * progress}px`,
						);
						activePanel.scrollTop = scrollFrom + (scrollTo - scrollFrom) * progress;
					}
					if (time < 1) {
						activeGroup.frame = requestAnimationFrame(tick);
						return;
					}
					for (const fold of activeGroup.sections.values()) finishSectionFold(fold);
					activeGroup.sections.clear();
					activeGroup.frame = requestAnimationFrame(() => {
						if (!inline && activePanel.dataset.collapsed !== "true") {
							activePanel.style.height = `${panelTo}px`;
						}
						activePanel.removeAttribute("data-folding");
						heightHost.style.removeProperty("--dial-panel-fold-height");
						panelFolds.delete(activePanel);
					});
				};
				tick(started);
			},
			destroy() {
				if (!panel) return;
				const group = panelFolds.get(panel);
				group?.sections.delete(folder);
				if (group && group.sections.size === 0) {
					cancelAnimationFrame(group.frame);
					panel.removeAttribute("data-folding");
					panel.parentElement?.style.removeProperty("--dial-panel-fold-height");
					panelFolds.delete(panel);
				}
			},
		};
	}

	// src/vanilla/dom.ts
	function element4(tag, className = "", text) {
		const node = document.createElement(tag);
		node.className = className;
		if (text !== void 0) {
			node.textContent = text;
		}
		if (tag === "button") {
			node.type = "button";
		}
		return node;
	}
	function svg(tag, attrs = {}) {
		const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
		for (const [key, value] of Object.entries(attrs)) {
			node.setAttribute(key, String(value));
		}
		return node;
	}
	function icon2(paths, className = "", viewBox = "0 0 24 24") {
		const node = svg("svg", {
			class: className,
			viewBox,
			fill: "none",
			stroke: "currentColor",
			"stroke-width": 2,
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
			"aria-hidden": "true",
		});
		for (const d of typeof paths === "string" ? [paths] : paths) {
			node.append(svg("path", { d }));
		}
		return node;
	}
	function button(title, paths, onClick) {
		const node = element4("button", "dialkit-toolbar-add");
		node.title = title;
		node.setAttribute("aria-label", title);
		node.append(icon2(paths));
		node.addEventListener("click", onClick);
		return node;
	}

	// src/transition-math.ts
	function round2(value) {
		return Math.round(value * 100) / 100;
	}
	function clamp2(value, min, max) {
		return Math.min(max, Math.max(min, value));
	}
	function isTransitionConfig(value) {
		return isSpringConfigValue(value) || isEasingConfigValue(value);
	}
	function isPhysicsSpring(transition) {
		return transition.type === "spring"
			&& (transition.stiffness !== void 0 || transition.damping !== void 0
				|| transition.mass !== void 0);
	}
	function springParams(spring) {
		if (isPhysicsSpring(spring)) {
			return {
				stiffness: spring.stiffness ?? 200,
				damping: spring.damping ?? 25,
				mass: spring.mass ?? 1,
			};
		}
		const visualDuration = Math.max(0.05, spring.visualDuration ?? 0.3);
		const bounce = spring.bounce ?? 0.3;
		const root = 2 * Math.PI / (visualDuration * 1.2);
		const stiffness = root * root;
		const damping = 2 * Math.min(1, Math.max(0.05, 1 - bounce)) * Math.sqrt(stiffness);
		return { stiffness, damping, mass: 1 };
	}
	function springProgress(t, { stiffness, damping, mass }) {
		if (t <= 0) return 0;
		const w0 = Math.sqrt(stiffness / mass);
		const zeta = damping / (2 * Math.sqrt(stiffness * mass));
		if (zeta < 0.9999) {
			const wd2 = w0 * Math.sqrt(1 - zeta * zeta);
			return 1
				- Math.exp(-zeta * w0 * t) * (Math.cos(wd2 * t) + zeta * w0 / wd2 * Math.sin(wd2 * t));
		}
		if (zeta < 1.0001) {
			return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
		}
		const wd = w0 * Math.sqrt(zeta * zeta - 1);
		const r1 = -zeta * w0 + wd;
		const r2 = -zeta * w0 - wd;
		return 1 + (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r1 - r2);
	}
	function springSettleDuration(params) {
		const w0 = Math.sqrt(params.stiffness / params.mass);
		const zeta = params.damping / (2 * Math.sqrt(params.stiffness * params.mass));
		const decay = zeta >= 1 ? zeta * w0 - w0 * Math.sqrt(Math.max(0, zeta * zeta - 1)) : zeta * w0;
		const duration = Math.log(200) / Math.max(decay, 1e-6);
		return round2(clamp2(duration, 0.05, 10));
	}
	function cubicBezierProgress(p, [x1, y1, x2, y2]) {
		if (p <= 0) return 0;
		if (p >= 1) return 1;
		const sampleX = (t2) => bezierAxis(t2, x1, x2);
		const sampleY = (t2) => bezierAxis(t2, y1, y2);
		let t = p;
		for (let i = 0; i < 8; i++) {
			const x = sampleX(t) - p;
			if (Math.abs(x) < 1e-5) return sampleY(t);
			const dx = bezierAxisDerivative(t, x1, x2);
			if (Math.abs(dx) < 1e-6) break;
			t -= x / dx;
		}
		let lo = 0;
		let hi = 1;
		t = p;
		while (hi - lo > 1e-5) {
			if (sampleX(t) < p) lo = t;
			else hi = t;
			t = (lo + hi) / 2;
		}
		return sampleY(t);
	}
	function bezierAxis(t, a1, a2) {
		return (1 - 3 * a2 + 3 * a1) * t * t * t + (3 * a2 - 6 * a1) * t * t + 3 * a1 * t;
	}
	function bezierAxisDerivative(t, a1, a2) {
		return 3 * (1 - 3 * a2 + 3 * a1) * t * t + 2 * (3 * a2 - 6 * a1) * t + 3 * a1;
	}
	function resolveClipTransition(raw, clipDuration) {
		const safeDuration = Math.max(0.05, clipDuration);
		if (raw.type === "easing") {
			return {
				transition: { ...raw, duration: safeDuration },
				duration: safeDuration,
				isPhysics: false,
			};
		}
		if (isPhysicsSpring(raw)) {
			return {
				transition: raw,
				duration: springSettleDuration(springParams(raw)),
				isPhysics: true,
			};
		}
		return {
			transition: { type: "spring", bounce: raw.bounce ?? 0.2, visualDuration: safeDuration },
			duration: safeDuration,
			isPhysics: false,
		};
	}

	// src/vanilla/animation.ts
	function animateSpring(node, frame, visualDuration = 0.35, bounce = 0.1) {
		if (
			typeof node.animate !== "function"
			|| window.matchMedia("(prefers-reduced-motion: reduce)").matches
		) {
			return;
		}
		const params = springParams({ type: "spring", visualDuration, bounce });
		const duration = springSettleDuration(params);
		const count = Math.max(2, Math.ceil(duration * 60));
		const frames = Array.from(
			{ length: count + 1 },
			(_, index) => frame(index === count ? 1 : springProgress(index / count * duration, params)),
		);
		return node.animate(frames, { duration: duration * 1e3, easing: "linear" });
	}

	// src/vanilla/controls.ts
	function mountFolder(host, initial) {
		let props = initial;
		let open = props.open ?? props.defaultOpen ?? true;
		const folder = element4(
			"div",
			`dialkit-folder${
				props.isRoot ? " dialkit-folder-root" : props.isSection ? " dialkit-folder-section" : ""
			}`,
		);
		const header = element4(
			"div",
			`dialkit-folder-header${props.isRoot ? " dialkit-panel-header" : ""}`,
		);
		const top = element4("div", "dialkit-folder-header-top");
		const titleRow = element4("div", "dialkit-folder-title-row");
		const title = element4(
			"span",
			`dialkit-folder-title${props.isRoot ? " dialkit-folder-title-root" : ""}`,
		);
		titleRow.append(title);
		top.append(titleRow);
		const glyph = props.isRoot
			? svg("svg", {
				class: "dialkit-panel-icon",
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
			})
			: icon2(ICON_CHEVRON, "dialkit-folder-icon");
		if (!props.inline || !props.isRoot) {
			top.append(glyph);
		}
		const toolbar = element4(
			"div",
			props.isRoot ? "dialkit-panel-toolbar" : "dialkit-panel-section-toolbar",
		);
		toolbar.addEventListener("click", (event) => event.stopPropagation());
		header.append(top);
		if (props.isSection) {
			const toolbarClip = element4("div", "dialkit-panel-section-toolbar-clip");
			toolbarClip.append(toolbar);
			header.append(toolbarClip);
		} else if (props.isRoot) {
			header.append(toolbar);
		}
		const content = element4("div", "dialkit-folder-content");
		const body = element4("div", "dialkit-folder-inner");
		content.append(body);
		folder.append(header, content);
		const node = props.isRoot
			? element4("div", `dialkit-panel-inner${props.inline ? " dialkit-panel-inline" : ""}`)
			: folder;
		if (props.isRoot) {
			node.tabIndex = -1;
			node.append(folder);
		}
		host.append(node);
		let renderedOpen = open;
		let animation;
		let sectionTransition;
		const render = () => {
			const changed = renderedOpen !== open;
			const before = (props.isRoot ? node : content).getBoundingClientRect();
			if (changed) {
				animation?.cancel();
			}
			const wasOpen = renderedOpen;
			renderedOpen = open;
			folder.dataset.open = String(open);
			title.textContent = props.title;
			top.setAttribute("aria-label", props.title);
			top.setAttribute("aria-expanded", String(open));
			if (!(props.inline && props.isRoot)) {
				top.setAttribute("role", "button");
				top.tabIndex = 0;
			}
			if (!props.isSection) {
				content.style.display = open ? "" : "none";
				content.inert = !open;
				toolbar.style.display = open ? "" : "none";
			}
			if (props.isRoot) {
				glyph.setAttribute("viewBox", open ? "0 0 24 24" : "0 0 16 16");
				glyph.replaceChildren();
				if (open) {
					glyph.append(
						svg("path", {
							d: ICON_CLOSE,
							stroke: "currentColor",
							"stroke-width": 2,
							"stroke-linecap": "round",
						}),
					);
				} else {
					glyph.append(svg("path", { d: ICON_PANEL.path, fill: "currentColor", opacity: 0.5 }));
					ICON_PANEL.circles.forEach((c) =>
						glyph.append(
							svg("circle", {
								...c,
								fill: "currentColor",
								stroke: "currentColor",
								"stroke-width": 1.25,
							}),
						)
					);
				}
				titleRow.style.display = open ? "" : "none";
				node.dataset.collapsed = String(!open);
				if (!props.inline) {
					Object.assign(
						node.style,
						open
							? {
								width: "280px",
								height: "auto",
								maxHeight: "calc(100dvh - 32px)",
								borderRadius: "14px",
								boxShadow: "var(--dial-shadow)",
								overflowX: "hidden",
								overflowY: "auto",
								cursor: "",
							}
							: {
								width: "42px",
								height: "42px",
								maxHeight: "42px",
								borderRadius: "50%",
								boxShadow: "var(--dial-shadow-collapsed)",
								overflow: "hidden",
								cursor: "pointer",
							},
					);
				}
			} else {
				glyph.style.transform = open ? "rotate(180deg)" : "";
				glyph.style.transition = "transform 250ms ease";
			}
			if (changed && before.width > 0) {
				if (props.isRoot && !props.inline) {
					const after = node.getBoundingClientRect();
					node.style.maxHeight = "calc(100dvh - 32px)";
					animation = animateSpring(
						node,
						(p) => ({
							width: `${before.width + (after.width - before.width) * p}px`,
							height: `${before.height + (after.height - before.height) * p}px`,
							borderRadius: `${(wasOpen ? 14 : 21) + (open ? -7 : 7) * p}px`,
						}),
					);
				} else if (!props.isRoot && !props.isSection) {
					content.style.display = "";
					const targetHeight = open ? content.scrollHeight : 0;
					animation = animateSpring(
						content,
						(p) => ({ height: `${before.height + (targetHeight - before.height) * p}px` }),
					);
					if (!open) {
						if (animation) {
							animation.onfinish = () => {
								if (!open) {
									content.style.display = "none";
								}
							};
						} else {
							content.style.display = "none";
						}
					}
				}
			}
			sectionTransition?.setOpen(open);
		};
		const toggle = () => {
			if (props.inline && props.isRoot) {
				return;
			}
			open = !open;
			render();
			props.onOpenChange?.(open);
		};
		header.addEventListener("click", (event) => {
			event.stopPropagation();
			toggle();
		});
		top.addEventListener("keydown", (event) => activateOnKey(event, toggle));
		if (props.isRoot) {
			node.addEventListener("click", () => {
				if (!open) {
					toggle();
				}
			});
		}
		render();
		if (props.isSection) sectionTransition = createPanelSectionTransition(folder, open);
		const stopHeader = props.isRoot ? observePanelHeader(folder) : void 0;
		return {
			element: node,
			body,
			toolbar,
			update(next) {
				props = next;
				open = next.open ?? open;
				render();
			},
			destroy() {
				animation?.cancel();
				stopHeader?.();
				sectionTransition?.destroy();
				node.remove();
			},
		};
	}
	function mountSegmentedControl(host, initial) {
		let props = initial;
		const group = element4("div", "dialkit-segmented");
		group.setAttribute("role", "radiogroup");
		group.addEventListener("keydown", handleSegmentKey);
		const pill = element4("div", "dialkit-segmented-pill");
		pill.style.transition = "left 200ms ease, width 200ms ease";
		pill.setAttribute("aria-hidden", "true");
		group.append(pill);
		host.append(group);
		labelSegmentedControl(group);
		let buttons = [];
		let signature = "";
		function render() {
			const nextSignature = JSON.stringify(props.options);
			if (signature !== nextSignature) {
				signature = nextSignature;
				buttons.forEach((b) => b.remove());
				buttons = props.options.map((option) => {
					const b = element4("button", "dialkit-segmented-button", option.label);
					b.setAttribute("role", "radio");
					b.addEventListener("click", () => props.onChange(option.value));
					group.append(b);
					return b;
				});
			}
			buttons.forEach((b, i) => {
				const active2 = props.options[i].value === props.value;
				b.dataset.active = String(active2);
				b.setAttribute("aria-checked", String(active2));
				b.tabIndex = active2 ? 0 : -1;
				if (active2) {
					pill.style.left = `${b.offsetLeft}px`;
					pill.style.width = `${b.offsetWidth}px`;
				}
			});
		}
		const observer = new ResizeObserver(render);
		observer.observe(group);
		render();
		return {
			update(next) {
				props = next;
				render();
			},
			destroy() {
				observer.disconnect();
				group.remove();
			},
		};
	}
	function mountToggle(host, initial) {
		let props = initial;
		const row = element4("div", "dialkit-labeled-control");
		const label = element4("span", "dialkit-labeled-control-label");
		row.append(label);
		host.append(row);
		const segmentProps = () => ({
			options: [{ value: "off", label: "Off" }, { value: "on", label: "On" }],
			value: props.checked ? "on" : "off",
			onChange: (value) => props.onChange(value === "on"),
		});
		const segmented = mountSegmentedControl(row, segmentProps());
		function render() {
			label.textContent = props.label;
			appendShortcut(label, props.shortcut, props.shortcutActive, true);
			segmented.update(segmentProps());
		}
		render();
		return {
			update(next) {
				props = next;
				render();
			},
			destroy() {
				segmented.destroy();
				row.remove();
			},
		};
	}
	function appendShortcut(label, shortcut, active2 = false, toggle = false) {
		if (!shortcut) {
			return;
		}
		label.append(
			element4(
				"span",
				`dialkit-shortcut-pill${active2 ? " dialkit-shortcut-pill-active" : ""}`,
				toggle ? formatToggleShortcut(shortcut) : formatSliderShortcut(shortcut),
			),
		);
	}
	function mountSlider(host, initial) {
		let props = initial;
		const wrapper = element4("div", "dialkit-slider-wrapper");
		const track = element4("div", "dialkit-slider");
		track.tabIndex = 0;
		track.setAttribute("role", "slider");
		const hashes = element4("div", "dialkit-slider-hashmarks");
		const fill = element4("div", "dialkit-slider-fill");
		const handle = element4("div", "dialkit-slider-handle");
		const label = element4("span", "dialkit-slider-label");
		const display = element4("span", "dialkit-slider-value");
		const input = element4("input", "dialkit-slider-input");
		input.type = "text";
		input.inputMode = "decimal";
		input.style.display = "none";
		track.append(hashes, fill, handle, label, display, input);
		wrapper.append(track);
		host.append(wrapper);
		let drag;
		let editing = false, hovered = false, editable = false;
		let timer;
		let hashSignature = "";
		let clickAnimations = [];
		const cancelClick = () => {
			clickAnimations.forEach((animation) => animation?.cancel());
			clickAnimations = [];
		};
		const range = () => ({ min: props.min ?? 0, max: props.max ?? 1, step: props.step ?? 0.01 });
		const formatted = () => {
			const { min, max, step } = range();
			return props.value.toFixed(decimalsForStep(step, min, max));
		};
		function render() {
			const { min, max, step } = range();
			const pct = max > min
				? Math.max(0, Math.min(100, (props.value - min) / (max - min) * 100))
				: 0;
			fill.style.width = `${pct}%`;
			handle.style.left = `max(5px, calc(${pct}% - 9px))`;
			const active2 = hovered || !!drag;
			const width = wrapper.offsetWidth;
			const dodge = width > 0
				&& (pct < (18 + label.offsetWidth) / width * 100
					|| pct > (width - 20 - display.offsetWidth) / width * 100);
			handle.style.opacity = active2 ? String(dodge ? 0.1 : drag?.moved ? 0.9 : 0.5) : "0";
			handle.style.transform = `translateY(-50%) scale(${active2 ? 1 : 0.25}, ${
				active2 && dodge ? 0.75 : 1
			})`;
			handle.style.transition = "opacity 150ms, transform 200ms";
			track.classList.toggle("dialkit-slider-active", active2);
			track.setAttribute("aria-label", props.label);
			track.setAttribute("aria-valuemin", String(min));
			track.setAttribute("aria-valuemax", String(max));
			track.setAttribute("aria-valuenow", String(props.value));
			track.setAttribute("aria-valuetext", `${formatted()}${props.unit ? ` ${props.unit}` : ""}`);
			label.textContent = props.label;
			appendShortcut(label, props.shortcut, props.shortcutActive);
			display.textContent = formatted();
			input.setAttribute("aria-label", `${props.label} value`);
			const signature = `${min}:${max}:${step}`;
			if (signature !== hashSignature) {
				hashSignature = signature;
				hashes.replaceChildren();
				const count = (max - min) / step;
				for (let i = 1; i < (count <= 10 ? count : 10); i++) {
					const hash = element4("div", "dialkit-slider-hashmark");
					hash.style.left = `${count <= 10 ? i / count * 100 : i * 10}%`;
					hashes.append(hash);
				}
			}
		}
		const commit = (value) => {
			props = { ...props, value };
			render();
			props.onChange(value);
		};
		const position = (x) => {
			const { min, max } = range();
			const rect = drag?.rect ?? wrapper.getBoundingClientRect();
			return min + Math.max(0, Math.min(1, (x - rect.left) / (rect.width || 1))) * (max - min);
		};
		function endDrag() {
			const id = drag?.id;
			drag = void 0;
			track.style.width = "";
			track.style.transform = "";
			if (id !== void 0 && track.hasPointerCapture(id)) {
				track.releasePointerCapture(id);
			}
			render();
		}
		function edit() {
			endDrag();
			editing = true;
			input.value = formatted();
			input.style.display = "";
			display.style.display = "none";
			track.tabIndex = -1;
			input.focus();
			input.select();
		}
		function finishEdit(cancel = false) {
			if (!editing) {
				return;
			}
			editing = false;
			const value = input.value.trim() ? Number(input.value) : NaN;
			if (!cancel && Number.isFinite(value)) {
				const { min, max, step } = range();
				commit(roundValue(Math.max(min, Math.min(max, value)), step, min, max));
			}
			input.style.display = "none";
			display.style.display = "";
			track.tabIndex = 0;
			editable = false;
			display.classList.remove("dialkit-slider-value-editable");
		}
		track.addEventListener("keydown", (event) => {
			const { min, max, step } = range();
			handleSliderKey(event, props.value, min, max, step, commit, edit);
		});
		track.addEventListener("pointerdown", (event) => {
			if (editing || event.button !== 0) {
				return;
			}
			event.preventDefault();
			cancelClick();
			track.focus({ preventScroll: true });
			track.setPointerCapture(event.pointerId);
			drag = {
				id: event.pointerId,
				x: event.clientX,
				y: event.clientY,
				rect: wrapper.getBoundingClientRect(),
				moved: false,
			};
			render();
		});
		track.addEventListener("pointermove", (event) => {
			if (!drag || drag.id !== event.pointerId) {
				return;
			}
			drag.moved || (drag.moved = Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 3);
			if (!drag.moved) {
				return;
			}
			const { min, max, step } = range();
			const overflow = event.clientX < drag.rect.left
				? event.clientX - drag.rect.left
				: event.clientX > drag.rect.right
				? event.clientX - drag.rect.right
				: 0;
			const stretch = Math.sign(overflow) * 8
				* Math.sqrt(Math.min(Math.max(0, Math.abs(overflow) - 32) / 200, 1));
			track.style.width = `calc(100% + ${Math.abs(stretch)}px)`;
			track.style.transform = `translateX(${Math.min(0, stretch)}px)`;
			commit(roundValue(position(event.clientX), step, min, max));
		});
		track.addEventListener("pointerup", (event) => {
			if (!drag || drag.id !== event.pointerId) {
				return;
			}
			if (!drag.moved) {
				const { min, max, step } = range();
				const raw = position(event.clientX);
				const next = (max - min) / step <= 10
					? min + Math.round((raw - min) / step) * step
					: snapToDecile(raw, min, max);
				const from = props.value;
				commit(roundValue(next, step, min, max));
				const startPct = (from - min) / (max - min) * 100;
				const endPct = (props.value - min) / (max - min) * 100;
				if (max > min) {
					clickAnimations = [
						animateSpring(fill, (p) => ({ width: `${startPct + (endPct - startPct) * p}%` }), 0.25),
						animateSpring(
							handle,
							(p) => ({ left: `max(5px, calc(${startPct + (endPct - startPct) * p}% - 9px))` }),
							0.25,
						),
					];
				}
			}
			endDrag();
		});
		track.addEventListener("pointercancel", endDrag);
		track.addEventListener("lostpointercapture", endDrag);
		track.addEventListener("mouseenter", () => {
			hovered = true;
			render();
		});
		track.addEventListener("mouseleave", () => {
			hovered = false;
			render();
		});
		display.addEventListener("mouseenter", () => {
			timer = setTimeout(() => {
				editable = true;
				display.classList.add("dialkit-slider-value-editable");
			}, 800);
		});
		display.addEventListener("mouseleave", () => {
			clearTimeout(timer);
			editable = false;
			display.classList.remove("dialkit-slider-value-editable");
		});
		display.addEventListener("pointerdown", (event) => {
			if (editable) {
				event.stopPropagation();
			}
		});
		display.addEventListener("click", (event) => {
			if (editable) {
				event.stopPropagation();
				edit();
			}
		});
		input.addEventListener("pointerdown", (event) => event.stopPropagation());
		input.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Enter" || event.key === "Escape") {
				event.preventDefault();
				finishEdit(event.key === "Escape");
				track.focus({ preventScroll: true });
			}
		});
		input.addEventListener("blur", () => finishEdit());
		render();
		return {
			update(next) {
				props = next;
				render();
			},
			destroy() {
				clearTimeout(timer);
				cancelClick();
				endDrag();
				wrapper.remove();
			},
		};
	}
	function mountTextControl(host, initial) {
		let props = initial;
		const row = element4("label", "dialkit-text-control");
		const label = element4("span", "dialkit-text-label");
		const input = element4("textarea", "dialkit-text-input");
		input.rows = 1;
		row.append(label, input);
		host.append(row);
		const size = observeTextSize(input);
		function render() {
			label.textContent = props.label;
			if (input.value !== props.value) {
				input.value = props.value;
			}
			input.placeholder = props.placeholder ?? "";
			size.update();
		}
		input.addEventListener("input", () => {
			props = { ...props, value: input.value };
			size.update();
			props.onChange(input.value);
		});
		render();
		return {
			update(next) {
				props = next;
				render();
			},
			destroy() {
				size.destroy();
				row.remove();
			},
		};
	}
	function mountButtonGroup(host, initial) {
		const group = element4("div", "dialkit-button-group");
		host.append(group);
		function update(props) {
			group.replaceChildren(...props.buttons.map((item) => {
				const b = element4("button", "dialkit-button", item.label);
				b.addEventListener("click", item.onClick);
				return b;
			}));
		}
		update(initial);
		return {
			update,
			destroy() {
				group.remove();
			},
		};
	}

	// src/dropdown-keyboard.ts
	var dropdownId = 0;
	function observeDropdownKeyboard(trigger, getPopup, close, kind = "select") {
		let frame = 0;
		let dispose;
		let stopped = false;
		const connect = () => {
			if (stopped) return;
			const popup = getPopup();
			if (!popup?.isConnected) {
				frame = requestAnimationFrame(connect);
				return;
			}
			popup.inert = false;
			popup.removeAttribute("aria-hidden");
			popup.id || (popup.id = `dialkit-dropdown-${++dropdownId}`);
			popup.setAttribute(
				"role",
				kind === "select" ? "listbox" : kind === "presets" ? "menu" : "dialog",
			);
			popup.setAttribute(
				"aria-label",
				trigger.getAttribute("aria-label")
					|| trigger.querySelector(".dialkit-select-label")?.textContent?.trim()
					|| trigger.getAttribute("title") || trigger.textContent?.trim() || "Options",
			);
			popup.tabIndex = -1;
			trigger.setAttribute("aria-controls", popup.id);
			const selector = kind === "select"
				? ".dialkit-select-option"
				: ".dialkit-preset-name, .dialkit-preset-delete, .dialkit-preset-create";
			let active2;
			let activeIndex = 0;
			let query = "";
			let typedAt = 0;
			let leaving = false;
			const items = () =>
				Array.from(popup.querySelectorAll(selector)).filter((el) => !el.hasAttribute("disabled"));
			const focusItem = (index) => {
				const options = items();
				activeIndex = Math.max(0, Math.min(options.length - 1, index));
				active2 = options[activeIndex];
				(active2 ?? popup).focus({ preventScroll: true });
				active2?.scrollIntoView({ block: "nearest", inline: "nearest" });
			};
			const refresh = () => {
				if (trigger.matches(":disabled")) {
					leaving = true;
					const previous = adjacentTabStop(trigger, true);
					close();
					queueMicrotask(() => previous?.focus());
					return;
				}
				const options = items();
				options.forEach((el) => {
					el.tabIndex = -1;
					el.setAttribute(
						"role",
						kind === "select"
							? "option"
							: !el.classList.contains("dialkit-preset-name")
							? "menuitem"
							: "menuitemradio",
					);
					if (kind === "select") el.setAttribute("aria-selected", el.dataset.selected ?? "false");
					else if (el.classList.contains("dialkit-preset-name")) {
						el.setAttribute("aria-checked", el.parentElement?.dataset.active ?? "false");
					}
				});
				if (active2 && !active2.isConnected && !leaving) focusItem(activeIndex);
			};
			refresh();
			const observer = new MutationObserver(refresh);
			observer.observe(popup, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["data-active", "data-selected"],
			});
			const restore = () => {
				leaving = true;
				trigger.focus({ preventScroll: true });
			};
			const keydown = (event) => {
				if (event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return;
				if (event.key === "Tab") {
					const next2 = adjacentTabStop(trigger, event.shiftKey);
					restore();
					close();
					if (next2) {
						event.preventDefault();
						event.stopPropagation();
						queueMicrotask(() => next2.focus());
					}
					return;
				}
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					restore();
					close();
					return;
				}
				const options = items();
				const index = options.indexOf(document.activeElement);
				const next = optionKeyIndex(event.key, Math.max(0, index), options.length);
				if (next !== void 0) {
					event.preventDefault();
					event.stopPropagation();
					focusItem(next);
					return;
				}
				if (["Enter", " "].includes(event.key) && index >= 0) {
					event.preventDefault();
					event.stopPropagation();
					options[index].click();
					return;
				}
				if (event.key.length === 1 && event.key !== " ") {
					const now = Date.now();
					query = now - typedAt < 700
						? query + event.key.toLocaleLowerCase()
						: event.key.toLocaleLowerCase();
					typedAt = now;
					const search = [...query].every((c) => c === query[0]) ? query[0] : query;
					for (let offset = search.length > 1 ? 0 : 1; offset <= options.length; offset++) {
						const candidate = (Math.max(0, index) + offset) % options.length;
						if (options[candidate]?.textContent?.trim().toLocaleLowerCase().startsWith(search)) {
							focusItem(candidate);
							break;
						}
					}
					event.preventDefault();
					event.stopPropagation();
				}
			};
			const click = (event) => {
				const target = event.target.closest(selector);
				if (target && !target.classList.contains("dialkit-preset-delete")) restore();
			};
			const focusin = (event) => {
				const target = event.target;
				if (!leaving && !popup.contains(target) && !trigger.contains(target)) {
					leaving = true;
					close();
				}
			};
			popup.addEventListener("keydown", keydown);
			popup.addEventListener("click", click, true);
			document.addEventListener("focusin", focusin);
			let stopPosition;
			if (kind !== "select") {
				const root = getDialKitPortalRoot(trigger);
				if (root) {
					popup.dataset.theme = root.dataset.theme ?? "dark";
					const styles = getComputedStyle(root);
					for (const property of Array.from(styles)) {
						if (property.startsWith("--dial-")) {
							popup.style.setProperty(property, styles.getPropertyValue(property));
						}
					}
				}
				const position = () => {
					const pos = getDropdownPosition(trigger, root ?? document.body, {
						fixed: true,
						dropdownHeight: popup.scrollHeight + 2,
						width: kind === "help" ? 280 : trigger.getBoundingClientRect().width,
					});
					Object.assign(popup.style, {
						position: "fixed",
						top: `${pos.top}px`,
						left: `${pos.left}px`,
						right: "auto",
						width: `${pos.width}px`,
						minWidth: "0",
						maxHeight: `${pos.maxHeight}px`,
					});
				};
				stopPosition = observeDropdownPosition(trigger, position, () => popup);
			}
			const selected = items().findIndex((el) =>
				el.dataset.selected === "true"
				|| el.classList.contains("dialkit-preset-name")
					&& el.parentElement?.dataset.active === "true"
			);
			focusItem(Math.max(0, selected));
			dispose = () => {
				leaving = true;
				if (popup.contains(document.activeElement)) trigger.focus({ preventScroll: true });
				popup.inert = true;
				popup.setAttribute("aria-hidden", "true");
				observer.disconnect();
				stopPosition?.();
				popup.removeEventListener("keydown", keydown);
				popup.removeEventListener("click", click, true);
				document.removeEventListener("focusin", focusin);
				trigger.removeAttribute("aria-controls");
			};
		};
		frame = requestAnimationFrame(connect);
		return () => {
			stopped = true;
			cancelAnimationFrame(frame);
			dispose?.();
		};
	}

	// src/vanilla/menus.ts
	function popupMenu(trigger, className, kind, populate) {
		let popup;
		let stopKeyboard, stopPosition;
		const outside = (event) => {
			if (!trigger.contains(event.target) && !popup?.contains(event.target)) {
				close();
			}
		};
		function close() {
			stopKeyboard?.();
			stopPosition?.();
			stopKeyboard = stopPosition = void 0;
			popup?.remove();
			popup = void 0;
			trigger.dataset.open = "false";
			trigger.setAttribute("aria-expanded", "false");
			document.removeEventListener("pointerdown", outside);
		}
		function open() {
			if (popup || trigger.disabled) {
				return;
			}
			const root = getDialKitPortalRoot(trigger) ?? document.body;
			popup = element4("div", className);
			popup.style.position = "fixed";
			root.append(popup);
			populate(popup);
			trigger.dataset.open = "true";
			trigger.setAttribute("aria-expanded", "true");
			stopPosition = observeDropdownPosition(trigger, () => {
				if (!popup) {
					return;
				}
				if (!trigger.isConnected || !trigger.getClientRects().length) {
					close();
					return;
				}
				const p = getDropdownPosition(trigger, root, {
					fixed: true,
					dropdownHeight: popup.scrollHeight + 2,
					...kind === "help" ? { width: 280 } : {},
				});
				Object.assign(popup.style, {
					top: `${p.top}px`,
					left: `${p.left}px`,
					width: `${p.width}px`,
					maxHeight: `${p.maxHeight}px`,
				});
			}, () => popup);
			stopKeyboard = observeDropdownKeyboard(trigger, () => popup, close, kind);
			document.addEventListener("pointerdown", outside);
		}
		const click = () => {
			if (popup) {
				close();
			} else {
				open();
			}
		};
		const key = (e) => openDropdownOnKey(e, open);
		trigger.setAttribute(
			"aria-haspopup",
			kind === "select" ? "listbox" : kind === "presets" ? "menu" : "dialog",
		);
		trigger.setAttribute("aria-expanded", "false");
		trigger.addEventListener("click", click);
		trigger.addEventListener("keydown", key);
		return {
			close,
			refresh() {
				if (popup) {
					populate(popup);
				}
			},
			destroy() {
				close();
				trigger.removeEventListener("click", click);
				trigger.removeEventListener("keydown", key);
			},
		};
	}
	function mountSelectControl(host, initial) {
		let props = initial;
		const row = element4("div", "dialkit-select-row");
		const trigger = element4("button", "dialkit-select-trigger");
		const label = element4("span", "dialkit-select-label");
		const right = element4("div", "dialkit-select-right");
		const value = element4("span", "dialkit-select-value");
		right.append(value, icon2(ICON_CHEVRON, "dialkit-select-chevron"));
		trigger.append(label, right);
		row.append(trigger);
		host.append(row);
		const options = () =>
			props.options.map((option) =>
				typeof option === "string"
					? { value: option, label: option.replace(/\b\w/g, (c) => c.toUpperCase()) }
					: option
			);
		const menu = popupMenu(trigger, "dialkit-select-dropdown", "select", (popup) => {
			popup.replaceChildren(
				...options().map((option) => {
					const b = element4("button", "dialkit-select-option", option.label);
					b.dataset.selected = String(option.value === props.value);
					b.addEventListener("click", () => {
						props.onChange(option.value);
						menu.close();
					});
					return b;
				}),
			);
		});
		function render() {
			label.textContent = props.label;
			value.textContent = options().find((o) => o.value === props.value)?.label ?? props.value;
			trigger.disabled = !props.options.length;
			menu.refresh();
		}
		render();
		return {
			update(next) {
				props = next;
				render();
			},
			destroy() {
				menu.destroy();
				row.remove();
			},
		};
	}
	function mountPresetManager(host, initial) {
		let props = initial;
		const row = element4("div", "dialkit-preset-manager");
		const trigger = element4("button", "dialkit-preset-trigger");
		const label = element4("span", "dialkit-preset-label");
		trigger.setAttribute("aria-label", "Versions");
		trigger.append(label, icon2(ICON_CHEVRON, "dialkit-select-chevron"));
		row.append(trigger);
		host.append(row);
		const menu = popupMenu(trigger, "dialkit-preset-dropdown", "presets", (popup) => {
			const versions = [{ id: null, name: "Version 1" }, ...props.presets];
			popup.replaceChildren(...versions.map((preset) => {
				const item = element4("div", "dialkit-preset-item");
				item.dataset.active = String(preset.id === props.activePresetId);
				const name = element4("button", "dialkit-preset-name", preset.name);
				item.addEventListener("click", () => {
					if (preset.id) {
						DialStore.loadPreset(props.panelId, preset.id);
					} else {
						DialStore.clearActivePreset(props.panelId);
					}
					menu.close();
				});
				item.append(
					icon2(preset.id === props.activePresetId ? ICON_CHECK : [], "dialkit-preset-check"),
					name,
				);
				if (preset.id) {
					const del = element4("button", "dialkit-preset-delete");
					del.title = `Delete ${preset.name}`;
					del.setAttribute("aria-label", del.title);
					del.append(icon2(ICON_TRASH));
					del.addEventListener("click", (event) => {
						event.stopPropagation();
						DialStore.deletePreset(props.panelId, preset.id);
					});
					item.append(del);
				}
				return item;
			}));
			const divider = element4("div", "dialkit-preset-divider");
			divider.setAttribute("role", "separator");
			const create = element4("button", "dialkit-preset-create");
			create.append(
				icon2(ICON_PLUS, "dialkit-preset-check"),
				document.createTextNode("New version"),
			);
			create.addEventListener("click", () => {
				if (props.onAdd) props.onAdd();
				else DialStore.saveNewPreset(props.panelId);
				menu.close();
				trigger.focus();
			});
			popup.append(divider, create);
		});
		function render() {
			const active2 = props.presets.find((p) => p.id === props.activePresetId);
			label.textContent = active2?.name ?? "Version 1";
			trigger.dataset.hasPreset = String(!!active2);
			menu.refresh();
		}
		render();
		return {
			update(next) {
				props = next;
				render();
			},
			destroy() {
				menu.destroy();
				row.remove();
			},
		};
	}
	function mountShortcutsMenu(host, initial) {
		let props = initial;
		const trigger = element4("button", "dialkit-shortcuts-trigger");
		trigger.title = "Keyboard shortcuts";
		trigger.setAttribute("aria-label", trigger.title);
		trigger.append(
			icon2([
				"M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z",
				"M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8",
			]),
		);
		host.append(trigger);
		const menu = popupMenu(trigger, "dialkit-shortcuts-dropdown", "help", (popup) => {
			const panel = DialStore.getPanel(props.panelId);
			popup.replaceChildren(element4("div", "dialkit-shortcuts-title", "Keyboard Shortcuts"));
			const list = element4("div", "dialkit-shortcuts-list");
			for (const [path, shortcut] of Object.entries(panel?.shortcuts ?? {})) {
				const row = element4("div", "dialkit-shortcuts-row");
				const interaction = shortcut.interaction ?? "scroll";
				row.append(
					element4("span", "dialkit-shortcuts-row-key", formatToggleShortcut(shortcut)),
					element4(
						"span",
						"dialkit-shortcuts-row-label",
						findControl(panel.controls, path)?.label ?? path,
					),
					element4(
						"span",
						"dialkit-shortcuts-row-mode",
						interaction === "scroll-only" ? "scroll" : `key+${interaction}`,
					),
				);
				list.append(row);
			}
			popup.append(
				list,
				element4("div", "dialkit-shortcuts-hint", "See pill badges on controls for keys"),
			);
		});
		const render = () => {
			trigger.style.display = Object.keys(DialStore.getPanel(props.panelId)?.shortcuts ?? {}).length
				? ""
				: "none";
			menu.refresh();
		};
		const stop2 = DialStore.subscribeGlobal(render);
		render();
		return {
			update(next) {
				props = next;
				render();
			},
			destroy() {
				stop2();
				menu.destroy();
				trigger.remove();
			},
		};
	}

	// src/easing-geometry.ts
	var clampY = (value) => Math.max(-1, Math.min(2, value));
	function formatEase(ease) {
		return ease.join(", ");
	}
	function parseEase(text) {
		const parts = text.split(",").map((part) => part.trim());
		if (
			parts.length !== 4
			|| parts.some((part) => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(part))
		) return null;
		const values = parts.map(Number);
		if (
			!values.every(Number.isFinite) || values[0] < 0 || values[0] > 1 || values[2] < 0
			|| values[2] > 1
		) return null;
		values[1] = clampY(values[1]);
		values[3] = clampY(values[3]);
		return values;
	}
	function normalizeEase(ease) {
		return ease.map((value, index) => {
			const finite = Number.isFinite(value) ? value : index < 2 ? 0 : 1;
			return index % 2 === 0 ? Math.max(0, Math.min(1, finite)) : finite;
		});
	}
	function fitEasingGraph(ease, width, height) {
		const value = normalizeEase(ease);
		const padding = Math.min(12, width / 4, height / 4);
		const radiusY = Math.max(0.5, Math.abs(value[1] - 0.5), Math.abs(value[3] - 0.5));
		const unit = Math.min(width - padding * 2, (height / 2 - padding) / radiusY);
		const scale = { x: unit, y: unit };
		const project = (x, y) => ({
			x: width / 2 + (x - 0.5) * scale.x,
			y: height / 2 - (y - 0.5) * scale.y,
		});
		return {
			scale,
			start: project(0, 0),
			end: project(1, 1),
			handles: [project(value[0], value[1]), project(value[2], value[3])],
		};
	}
	function moveEasingHandle(ease, handle, dx, dy, scale) {
		const next = [...ease];
		if (!Number.isFinite(scale.x) || !Number.isFinite(scale.y) || scale.x <= 0 || scale.y <= 0) {
			return next;
		}
		const index = handle * 2;
		const x = ease[index] + dx / scale.x;
		const y = ease[index + 1] - dy / scale.y;
		if (dx !== 0) next[index] = Number(Math.max(0, Math.min(1, x)).toFixed(2));
		if (dy !== 0 && Number.isFinite(y)) next[index + 1] = Number(clampY(y).toFixed(2));
		return next;
	}
	function easingHandleFromKey(ease, handle, key, shift) {
		const delta = shift ? 0.1 : 0.01;
		const scale = { x: 1, y: 1 };
		if (key === "ArrowLeft") return moveEasingHandle(ease, handle, -delta, 0, scale);
		if (key === "ArrowRight") return moveEasingHandle(ease, handle, delta, 0, scale);
		if (key === "ArrowUp") return moveEasingHandle(ease, handle, 0, -delta, scale);
		if (key === "ArrowDown") return moveEasingHandle(ease, handle, 0, delta, scale);
	}
	function easingGuideEnd(start, handle, radius = 5) {
		const dx = handle.x - start.x;
		const dy = handle.y - start.y;
		const distance = Math.hypot(dx, dy);
		if (distance <= radius) return { ...start };
		return { x: handle.x - dx / distance * radius, y: handle.y - dy / distance * radius };
	}

	// src/easing-control.ts
	var nextId3 = 0;
	function mountEasingVisualization(host, initial) {
		let props = initial;
		let value = normalizeEase(props.easing.ease);
		let width = 256;
		let height = 180;
		let drag;
		const root = document.createElement("div");
		root.className = "dialkit-easing-viz";
		root.setAttribute("aria-label", "B\xE9zier easing curve");
		const svg2 = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg2.setAttribute("aria-hidden", "true");
		const shape = (tag, className) => {
			const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
			node.setAttribute("class", className);
			svg2.append(node);
			return node;
		};
		const reference = shape("line", "dialkit-easing-reference");
		const tangents = [
			shape("line", "dialkit-easing-tangent"),
			shape("line", "dialkit-easing-tangent"),
		];
		const path = shape("path", "dialkit-easing-curve");
		const endpoints = [
			shape("circle", "dialkit-easing-endpoint"),
			shape("circle", "dialkit-easing-endpoint"),
		];
		const help = document.createElement("span");
		help.className = "dialkit-easing-instructions";
		help.id = `dialkit-easing-help-${++nextId3}`;
		help.textContent =
			"Drag to adjust X from 0 to 1 and Y from -1 to 2. Arrow keys adjust by 0.01. Shift adjusts by 0.1. Escape cancels a drag.";
		root.append(svg2, help);
		const handles = [0, 1].map((handle) => {
			const button2 = document.createElement("button");
			button2.type = "button";
			button2.className = "dialkit-easing-handle";
			button2.setAttribute("aria-describedby", help.id);
			button2.addEventListener("pointerdown", (event) => {
				if (!props.onChange || event.button !== 0 || drag) return;
				event.preventDefault();
				event.stopPropagation();
				button2.focus({ preventScroll: true });
				measure();
				const bounds = root.getBoundingClientRect();
				if (!bounds.width || !bounds.height) return;
				drag = {
					id: event.pointerId,
					handle,
					x: event.clientX,
					y: event.clientY,
					scale: fitEasingGraph(value, width, height).scale,
					ratioX: width / bounds.width,
					ratioY: height / bounds.height,
					value: [...value],
				};
				button2.setPointerCapture(event.pointerId);
				button2.dataset.dragging = "true";
			});
			button2.addEventListener("pointermove", move);
			button2.addEventListener("pointerup", (event) => {
				if (event.pointerId !== drag?.id) return;
				move(event);
				endDrag();
			});
			button2.addEventListener("pointercancel", (event) => {
				if (event.pointerId === drag?.id) cancelDrag();
			});
			button2.addEventListener("lostpointercapture", (event) => {
				if (event.pointerId === drag?.id) endDrag();
			});
			button2.addEventListener("keydown", (event) => {
				if (!props.onChange || event.altKey || event.metaKey || event.ctrlKey) return;
				if (event.key === "Escape" && drag) {
					event.preventDefault();
					event.stopPropagation();
					cancelDrag();
					return;
				}
				const next = easingHandleFromKey(value, handle, event.key, event.shiftKey);
				if (next) {
					event.preventDefault();
					event.stopPropagation();
					endDrag();
					commit(next);
				}
			});
			root.append(button2);
			return button2;
		});
		host.append(root);
		function line(node, a, b) {
			node.setAttribute("x1", String(a.x));
			node.setAttribute("y1", String(a.y));
			node.setAttribute("x2", String(b.x));
			node.setAttribute("y2", String(b.y));
		}
		function render() {
			const graph = fitEasingGraph(value, width, height);
			svg2.setAttribute("viewBox", `0 0 ${width} ${height}`);
			line(reference, graph.start, graph.end);
			[graph.start, graph.end].forEach((point, index) => {
				line(tangents[index], point, easingGuideEnd(point, graph.handles[index]));
				endpoints[index].setAttribute("cx", String(point.x));
				endpoints[index].setAttribute("cy", String(point.y));
				endpoints[index].setAttribute("r", "2.5");
				const button2 = handles[index];
				button2.style.left = `${graph.handles[index].x / width * 100}%`;
				button2.style.top = `${graph.handles[index].y / height * 100}%`;
				button2.disabled = !props.onChange;
				button2.setAttribute(
					"aria-label",
					`B\xE9zier handle ${index + 1}: X ${value[index * 2]}, Y ${value[index * 2 + 1]}`,
				);
			});
			root.setAttribute("role", props.onChange ? "group" : "img");
			const { start, end, handles: [a, b] } = graph;
			path.setAttribute(
				"d",
				`M ${start.x} ${start.y} C ${a.x} ${a.y}, ${b.x} ${b.y}, ${end.x} ${end.y}`,
			);
		}
		function measure() {
			width = root.clientWidth || width;
			height = root.clientHeight || height;
			render();
		}
		function commit(next) {
			if (next.every((part, index) => part === value[index])) return;
			value = next;
			render();
			props.onChange?.([...value]);
		}
		function move(event) {
			if (!drag || event.pointerId !== drag.id) return;
			commit(
				moveEasingHandle(
					drag.value,
					drag.handle,
					(event.clientX - drag.x) * drag.ratioX,
					(event.clientY - drag.y) * drag.ratioY,
					drag.scale,
				),
			);
		}
		function endDrag() {
			if (!drag) return;
			const { id, handle } = drag;
			drag = void 0;
			delete handles[handle].dataset.dragging;
			if (handles[handle].hasPointerCapture(id)) handles[handle].releasePointerCapture(id);
		}
		function cancelDrag() {
			if (!drag) return;
			const original = drag.value;
			endDrag();
			commit(original);
		}
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		measure();
		return {
			update(next) {
				const incoming = normalizeEase(next.easing.ease);
				if (!next.onChange || incoming.some((part, index) => part !== value[index])) endDrag();
				props = next;
				value = incoming;
				render();
			},
			destroy() {
				endDrag();
				observer.disconnect();
				root.remove();
			},
		};
	}

	// src/vanilla/transitions.ts
	function mountSpringVisualization(host, initial) {
		const root = svg("svg", {
			viewBox: "0 0 256 140",
			class: "dialkit-spring-viz",
			role: "img",
			"aria-label": "Spring response curve",
		});
		for (let i = 1; i < 4; i++) {
			root.append(
				svg("line", {
					x1: i * 64,
					y1: 0,
					x2: i * 64,
					y2: 140,
					stroke: "var(--dial-surface-active)",
				}),
				svg("line", {
					x1: 0,
					y1: i * 35,
					x2: 256,
					y2: i * 35,
					stroke: "var(--dial-surface-active)",
				}),
			);
		}
		root.append(
			svg("line", {
				x1: 0,
				y1: 70,
				x2: 256,
				y2: 70,
				stroke: "var(--dial-border-hover)",
				"stroke-dasharray": "4,4",
			}),
		);
		const path = svg("path", {
			fill: "none",
			stroke: "var(--dial-text-label)",
			"stroke-width": 2,
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
		});
		root.append(path);
		host.append(root);
		function update({ spring, isSimpleMode }) {
			const params = springParams(
				isSimpleMode
					? {
						type: "spring",
						visualDuration: spring.visualDuration ?? 0.3,
						bounce: spring.bounce ?? 0.2,
					}
					: {
						type: "spring",
						stiffness: spring.stiffness ?? 400,
						damping: spring.damping ?? 17,
						mass: spring.mass ?? 1,
					},
			);
			const values = Array.from({ length: 101 }, (_, i) => springProgress(i / 50, params));
			const min = Math.min(...values), range = Math.max(...values) - min || 1;
			path.setAttribute(
				"d",
				values.map((v, i) => `${i ? "L" : "M"} ${i * 2.56} ${140 - ((v - min) / range * 84 + 28)}`)
					.join(" "),
			);
		}
		update(initial);
		return {
			update,
			destroy() {
				root.remove();
			},
		};
	}
	function mountTransitionControl(host, initial, springOnly = false) {
		let props = initial;
		const folder = mountFolder(host, { title: props.label });
		const body = element4("div");
		Object.assign(body.style, { display: "flex", flexDirection: "column", gap: "6px" });
		folder.body.append(body);
		let mode;
		let controls = [];
		let refresh = () => {
		};
		const cache = {
			easing: props.value.type === "easing"
				? props.value
				: { type: "easing", duration: 0.3, ease: [1, -0.4, 0.5, 1] },
			simple: props.value.type === "spring" && props.value.visualDuration !== void 0
				? props.value
				: { type: "spring", visualDuration: 0.3, bounce: 0.2 },
			advanced: props.value.type === "spring" && props.value.stiffness !== void 0
				? props.value
				: { type: "spring", stiffness: 200, damping: 25, mass: 1 },
		};
		const currentMode = () =>
			springOnly
				? DialStore.getSpringMode(props.panelId, props.path)
				: DialStore.getTransitionMode(props.panelId, props.path);
		function render() {
			const nextMode = currentMode();
			if (nextMode === "easing" && props.value.type === "easing") {
				cache.easing = props.value;
			}
			if (nextMode !== "easing" && props.value.type === "spring") {
				cache[nextMode] = props.value;
			}
			if (mode !== nextMode) {
				mode = nextMode;
				rebuild();
			}
			folder.update({ title: props.label });
			refresh();
		}
		function rebuild() {
			controls.forEach((c) => c.destroy());
			controls = [];
			body.replaceChildren();
			const updates = [];
			const change = (value) => props.onChange(value);
			if (mode === "easing") {
				const vizProps = () => ({
					easing: cache.easing,
					onChange: (ease) => change({ ...cache.easing, ease }),
				});
				const viz = mountEasingVisualization(body, vizProps());
				controls.push(viz);
				updates.push(() => viz.update(vizProps()));
			} else {
				const vizProps = () => ({ spring: cache[mode], isSimpleMode: mode === "simple" });
				const viz = mountSpringVisualization(body, vizProps());
				controls.push(viz);
				updates.push(() => viz.update(vizProps()));
			}
			const typeRow = element4("div", "dialkit-labeled-control");
			typeRow.append(element4("span", "dialkit-labeled-control-label", "Type"));
			body.append(typeRow);
			const segment = mountSegmentedControl(typeRow, {
				options: [...springOnly ? [] : [{ value: "easing", label: "Easing" }], {
					value: "simple",
					label: "Time",
				}, { value: "advanced", label: "Physics" }],
				value: mode,
				onChange(next) {
					const value = { ...cache[next] };
					if (springOnly) {
						DialStore.updateSpringMode(props.panelId, props.path, next);
					} else {
						DialStore.updateTransitionMode(props.panelId, props.path, next);
					}
					props.onChange(value);
				},
			});
			controls.push(segment);
			function slider(label, key, fallback, min, max, step, duration = false) {
				const getProps = () => {
					const value = cache[mode];
					const external = duration ? props.durationControl : void 0;
					return {
						label,
						value: external?.value ?? value[key] ?? fallback,
						min: external?.min ?? min,
						max: external?.max ?? max,
						step: external?.step ?? step,
						unit: duration ? "s" : void 0,
						onChange: external?.onChange ?? ((v) => {
							const next = { ...cache[mode], [key]: v };
							if (mode === "simple") {
								delete next.stiffness;
								delete next.damping;
								delete next.mass;
							} else if (mode === "advanced") {
								delete next.visualDuration;
								delete next.bounce;
							}
							change(next);
						}),
					};
				};
				const control = mountSlider(body, getProps());
				controls.push(control);
				updates.push(() => control.update(getProps()));
			}
			if (mode === "easing") {
				const row = element4("div", "dialkit-labeled-control");
				row.append(element4("span", "dialkit-labeled-control-label", "Ease"));
				const input = element4("input", "dialkit-text-input");
				input.setAttribute("aria-label", "B\xE9zier coordinates");
				input.spellcheck = false;
				row.append(input);
				body.append(row);
				const commit = () => {
					const ease = parseEase(input.value);
					if (ease) {
						change({ ...cache.easing, ease });
					}
					input.value = formatEase(cache.easing.ease);
				};
				input.addEventListener("blur", commit);
				input.addEventListener("keydown", (event) => {
					if (event.key === "Escape") {
						input.value = formatEase(cache.easing.ease);
					}
					if (event.key === "Escape" || event.key === "Enter") {
						event.preventDefault();
						input.blur();
					}
					event.stopPropagation();
				});
				updates.push(() => {
					if (document.activeElement !== input) {
						input.value = formatEase(cache.easing.ease);
					}
				});
			} else if (mode === "simple") {
				if (springOnly && !props.hideDuration) {
					slider("Duration", "visualDuration", 0.3, 0.1, 1, 0.05, true);
				}
				slider("Bounce", "bounce", 0.2, 0, 1, 0.05);
			} else {
				slider("Stiffness", "stiffness", 400, 1, 1e3, 10);
				slider("Damping", "damping", 17, 1, 100, 1);
				slider("Mass", "mass", 1, 0.1, 10, 0.1);
			}
			if (!springOnly && !props.hideDuration && mode !== "advanced") {
				slider(
					"Duration",
					mode === "easing" ? "duration" : "visualDuration",
					0.3,
					0.1,
					mode === "easing" ? 2 : 1,
					0.05,
					true,
				);
			}
			refresh = () => updates.forEach((update) => update());
		}
		render();
		return {
			update(next) {
				props = next;
				render();
			},
			destroy() {
				controls.forEach((c) => c.destroy());
				folder.destroy();
			},
		};
	}
	function mountSpringControl(host, props) {
		const convert = (p) => ({ ...p, value: p.spring, onChange: (value) => p.onChange(value) });
		const mounted = mountTransitionControl(host, convert(props), true);
		return {
			update(next) {
				mounted.update(convert(next));
			},
			destroy: mounted.destroy,
		};
	}

	// src/vanilla/shortcuts.ts
	var users = 0;
	var stop;
	var active = null;
	var listeners = /* @__PURE__ */ new Set();
	function subscribeShortcut(listener) {
		listeners.add(listener);
		listener(active);
		return () => {
			listeners.delete(listener);
		};
	}
	function setActive(target) {
		active = target;
		listeners.forEach((listener) => listener(target));
	}
	function mountShortcutListener() {
		if (users++ === 0) {
			stop = listen();
		}
		let destroyed = false;
		return {
			destroy() {
				if (destroyed) {
					return;
				}
				destroyed = true;
				if (--users === 0) {
					stop?.();
					stop = void 0;
				}
			},
		};
	}
	function listen() {
		const keys = /* @__PURE__ */ new Set();
		let modifier;
		let dragging = false, lastX, accumulator = 0;
		const targetFor = (...interactions) => {
			for (const key of keys) {
				const target = DialStore.resolveShortcutTarget(key, modifier);
				if (
					target?.control.type === "slider"
					&& interactions.includes(target.control.shortcut?.interaction ?? "scroll")
				) {
					return target;
				}
			}
			return null;
		};
		const resetMouse = () => {
			dragging = false;
			lastX = void 0;
			accumulator = 0;
		};
		const keydown = (event) => {
			if (isInputFocused()) {
				return;
			}
			modifier = getActiveModifier(event);
			if (event.key.startsWith("Arrow") && keys.size) {
				const target2 = targetFor("scroll", "drag", "move");
				if (target2) {
					event.preventDefault();
					applySliderDelta(
						target2.panelId,
						target2.path,
						target2.control,
						getEffectiveStep(target2.control, target2.control.shortcut),
						["ArrowRight", "ArrowUp"].includes(event.key) ? 1 : -1,
					);
					return;
				}
			}
			const key = event.key.toLowerCase(), held = keys.has(key);
			keys.add(key);
			const target = DialStore.resolveShortcutTarget(key, modifier);
			if (target) {
				setActive(target);
				if (!held && target.control.type === "toggle") {
					DialStore.updateValue(
						target.panelId,
						target.path,
						!DialStore.getValue(target.panelId, target.path),
					);
				}
			}
			if (!held) {
				lastX = void 0;
				accumulator = 0;
			}
		};
		const keyup = (event) => {
			keys.delete(event.key.toLowerCase());
			modifier = getActiveModifier(event);
			resetMouse();
			setActive(
				[...keys].map((key) => DialStore.resolveShortcutTarget(key, modifier)).find(Boolean)
					?? null,
			);
		};
		const wheel = (event) => {
			if (isInputFocused()) {
				return;
			}
			modifier = getActiveModifier(event);
			const target = targetFor("scroll")
				?? DialStore.resolveScrollOnlyTargets().find((t) => t.control.type === "slider");
			if (!target) {
				return;
			}
			event.preventDefault();
			applySliderDelta(
				target.panelId,
				target.path,
				target.control,
				getEffectiveStep(target.control, target.control.shortcut),
				event.deltaY > 0 ? -1 : 1,
			);
		};
		const mousedown = (event) => {
			if (event.button !== 0 || isInputFocused()) {
				return;
			}
			modifier = getActiveModifier(event);
			if (targetFor("drag")) {
				dragging = true;
				lastX = event.clientX;
				accumulator = 0;
				event.preventDefault();
			}
		};
		const mousemove = (event) => {
			if (isInputFocused()) {
				return;
			}
			modifier = getActiveModifier(event);
			const target = targetFor(dragging ? "drag" : "move");
			if (!target) {
				return;
			}
			if (lastX === void 0) {
				lastX = event.clientX;
				return;
			}
			accumulator += event.clientX - lastX;
			lastX = event.clientX;
			const steps = Math.trunc(accumulator / DRAG_SENSITIVITY);
			if (steps) {
				accumulator -= steps * DRAG_SENSITIVITY;
				applySliderDelta(
					target.panelId,
					target.path,
					target.control,
					getEffectiveStep(target.control, target.control.shortcut),
					steps,
				);
			}
		};
		const blur = () => {
			keys.clear();
			resetMouse();
			setActive(null);
		};
		window.addEventListener("keydown", keydown);
		window.addEventListener("keyup", keyup);
		window.addEventListener("wheel", wheel, { passive: false });
		window.addEventListener("mousedown", mousedown);
		window.addEventListener("mousemove", mousemove);
		window.addEventListener("mouseup", resetMouse);
		window.addEventListener("blur", blur);
		return () => {
			window.removeEventListener("keydown", keydown);
			window.removeEventListener("keyup", keyup);
			window.removeEventListener("wheel", wheel);
			window.removeEventListener("mousedown", mousedown);
			window.removeEventListener("mousemove", mousemove);
			window.removeEventListener("mouseup", resetMouse);
			window.removeEventListener("blur", blur);
			blur();
		};
	}

	// src/vanilla/ControlRenderer.ts
	function mountControlRenderer(host, initial) {
		let props = initial;
		let active2 = null;
		let signature = "";
		let mounted = [];
		function build(controls, target) {
			for (const control of controls) {
				let mount2 = function(factory, getProps) {
					const instance = factory(target, getProps());
					mounted.push({ update: () => instance.update(getProps()), destroy: instance.destroy });
				};
				var mount = mount2;
				const value = () => props.values[control.path];
				const change = (v) => DialStore.updateValue(props.panelId, control.path, v);
				const shortcut = () => ({
					shortcut: control.shortcut,
					shortcutActive: active2?.panelId === props.panelId && active2?.path === control.path,
				});
				switch (control.type) {
					case "folder": {
						const folder = mountFolder(target, {
							title: control.label,
							defaultOpen: control.defaultOpen,
						});
						mounted.push({
							update() {
							},
							destroy: folder.destroy,
						});
						build(control.children ?? [], folder.body);
						break;
					}
					case "slider":
						mount2(
							mountSlider,
							() => ({
								label: control.label,
								value: value(),
								min: control.min,
								max: control.max,
								step: control.step,
								onChange: change,
								...shortcut(),
							}),
						);
						break;
					case "toggle":
						mount2(
							mountToggle,
							() => ({ label: control.label, checked: value(), onChange: change, ...shortcut() }),
						);
						break;
					case "text":
						mount2(
							mountTextControl,
							() => ({
								label: control.label,
								value: value(),
								placeholder: control.placeholder,
								onChange: change,
							}),
						);
						break;
					case "select":
						mount2(
							mountSelectControl,
							() => ({
								label: control.label,
								value: value(),
								options: control.options ?? [],
								onChange: change,
							}),
						);
						break;
					case "color":
						mount2(
							mountColorControl,
							() => ({ label: control.label, value: value(), onChange: change }),
						);
						break;
					case "image":
						mount2(
							mountImageControl,
							() => ({
								label: control.label,
								value: value(),
								options: control.options,
								onChange: change,
							}),
						);
						break;
					case "pad":
						mount2(
							mountDialPad,
							() => ({ ...control.pad, label: control.label, value: value(), onChange: change }),
						);
						break;
					case "spring":
						mount2(
							mountSpringControl,
							() => ({
								panelId: props.panelId,
								path: control.path,
								label: control.label,
								spring: value(),
								onChange: change,
							}),
						);
						break;
					case "transition":
						mount2(
							mountTransitionControl,
							() => ({
								panelId: props.panelId,
								path: control.path,
								label: control.label,
								value: value(),
								durationControl: props.transitionDuration,
								onChange: change,
							}),
						);
						break;
					case "action": {
						const b = element4("button", "dialkit-button", control.label);
						b.addEventListener("click", () => DialStore.triggerAction(props.panelId, control.path));
						target.append(b);
						mounted.push({
							update() {
							},
							destroy() {
								b.remove();
							},
						});
						break;
					}
				}
			}
		}
		function render() {
			const next = JSON.stringify([props.panelId, props.controls]);
			if (signature !== next) {
				mounted.forEach((c) => c.destroy());
				mounted = [];
				signature = next;
				build(props.controls, host);
			} else {
				mounted.forEach((c) => c.update());
			}
		}
		const stopShortcut = subscribeShortcut((next) => {
			active2 = next;
			mounted.forEach((c) => c.update());
		});
		render();
		return {
			update(next) {
				props = next;
				render();
			},
			destroy() {
				stopShortcut();
				mounted.forEach((c) => c.destroy());
				mounted = [];
			},
		};
	}

	// src/vanilla/DialRoot.ts
	function mountPanelToolbar(host, id, hookName = "createDialKit") {
		let timer;
		let destroyed = false;
		const presetProps = () => ({
			panelId: id,
			presets: DialStore.getPresets(id),
			activePresetId: DialStore.getActivePresetId(id),
		});
		const presets = mountPresetManager(host, presetProps());
		const copy = button(
			"Copy parameters",
			[ICON_CLIPBOARD_PLAIN.board, ICON_CLIPBOARD_PLAIN.body],
			async () => {
				try {
					await navigator.clipboard.writeText(
						buildCopyInstruction(
							hookName,
							DialStore.getPanel(id)?.name ?? "",
							DialStore.getValues(id),
						),
					);
				} catch {
					return;
				}
				if (destroyed) {
					return;
				}
				copy.replaceChildren(icon2(ICON_CHECK));
				clearTimeout(timer);
				timer = setTimeout(
					() =>
						copy.replaceChildren(icon2([ICON_CLIPBOARD_PLAIN.board, ICON_CLIPBOARD_PLAIN.body])),
					1500,
				);
			},
		);
		copy.classList.add("dialkit-toolbar-primary");
		host.append(copy);
		const stop2 = DialStore.subscribe(id, () => presets.update(presetProps()));
		return {
			destroy() {
				destroyed = true;
				clearTimeout(timer);
				stop2();
				presets.destroy();
				copy.remove();
			},
		};
	}
	function createDialRoot(options = {}) {
		const root = element4("div", "dialkit-root");
		const shell = element4("div", "dialkit-panel");
		root.append(shell);
		const inline = options.mode === "inline";
		root.dataset.mode = shell.dataset.mode = inline ? "inline" : "popover";
		root.dataset.theme = options.theme ?? "system";
		let position = options.position ?? "top-right";
		shell.dataset.position = position;
		let offset = null;
		let drag;
		const origin = () => {
			shell.dataset.originX = getPanelOriginX(position, offset);
			shell.dataset.originY = getPanelOriginY(position, offset);
		};
		origin();
		let shellOpen = inline || (options.defaultOpen ?? true);
		let lastOpen = shellOpen;
		let signature = "";
		let children = [];
		let shellFolder;
		let destroyed = false;
		const notify = (open) => {
			if (lastOpen !== open) {
				lastOpen = open;
				options.onOpenChange?.(open);
			}
		};
		function setShellOpen(open) {
			shellOpen = open;
			shellFolder?.update({
				title: "DialKit",
				open,
				isRoot: true,
				inline,
				onOpenChange: setShellOpen,
			});
			notify(open);
		}
		function timelineToggle(host) {
			if (!TimelineStore.getTimelines().length) {
				return;
			}
			const toggle = button(
				"Toggle timeline",
				["M3 5h18v14H3z", "M7 9h10M7 13h6"],
				() => TimelineUiStore.toggle(),
			);
			host.append(toggle);
			const sync = () => toggle.setAttribute("aria-pressed", String(TimelineUiStore.getVisible()));
			const stop2 = TimelineUiStore.subscribe(sync);
			sync();
			children.push({
				destroy() {
					stop2();
					toggle.remove();
				},
			});
		}
		function panelView(panel, host, isRoot) {
			DialStore.initPanelOpen(panel.id, isRoot ? inline || (options.defaultOpen ?? true) : true);
			const folderProps = () => ({
				title: DialStore.getPanel(panel.id)?.name ?? panel.name,
				open: DialStore.getPanelOpen(panel.id),
				isRoot,
				isSection: !isRoot,
				inline: isRoot && inline,
				onOpenChange: (open) => {
					DialStore.setPanelOpen(panel.id, open);
					if (isRoot) {
						notify(open);
					}
				},
			});
			const folder = mountFolder(host, folderProps());
			const toolbar = folder.toolbar;
			const toolbarView = mountPanelToolbar(toolbar, panel.id);
			if (isRoot) {
				timelineToggle(toolbar);
			}
			const rendererProps = () => ({
				panelId: panel.id,
				controls: DialStore.getPanel(panel.id)?.controls ?? [],
				values: DialStore.getValues(panel.id),
			});
			const renderer = mountControlRenderer(folder.body, rendererProps());
			const update = () => {
				folder.update(folderProps());
				renderer.update(rendererProps());
			};
			const stop2 = DialStore.subscribe(panel.id, update);
			children.push({
				destroy() {
					stop2();
					toolbarView.destroy();
					renderer.destroy();
					folder.destroy();
				},
			});
		}
		function render() {
			if (destroyed) {
				return;
			}
			const panels = DialStore.getPanels("panel");
			const timelines = TimelineStore.getTimelines();
			root.style.display = panels.length || timelines.length ? "" : "none";
			const next = JSON.stringify([
				panels.map((p) => [p.id, p.name, p.controls]),
				timelines.length > 0,
			]);
			if (next === signature) {
				return;
			}
			signature = next;
			children.forEach((child) => child.destroy());
			children = [];
			shell.replaceChildren();
			shellFolder = void 0;
			if (!panels.length && !timelines.length) {
				return;
			}
			const wrapper = element4("div", "dialkit-panel-wrapper");
			shell.append(wrapper);
			shell.dataset.multiple = String(panels.length > 1);
			if (panels.length === 1) {
				panelView(panels[0], wrapper, true);
			} else {
				shellFolder = mountFolder(wrapper, {
					title: "DialKit",
					open: shellOpen,
					isRoot: true,
					inline,
					onOpenChange: setShellOpen,
				});
				children.push(shellFolder);
				timelineToggle(shellFolder.toolbar);
				panels.forEach((panel) => panelView(panel, shellFolder.body, false));
				if (!panels.length) {
					shellFolder.body.append(element4("div", "dialkit-timeline-toolkit-only", "Timeline"));
				}
			}
		}
		const endDrag = () => {
			if (!drag) {
				return;
			}
			const current = drag;
			drag = void 0;
			releasePanelPointer(current.handle, current.id);
			if (current.moved) {
				blockPanelDragClick(current.handle);
			}
		};
		if (!inline) {
			shell.addEventListener("pointerdown", (event) => {
				if (event.button !== 0) {
					return;
				}
				const handle = getPanelDragHandle(event.target, shell);
				if (!handle) {
					return;
				}
				event.preventDefault();
				drag = {
					start: getPanelDragStart(event.clientX, event.clientY, shell),
					handle,
					id: event.pointerId,
					moved: false,
				};
				capturePanelPointer(handle, event.pointerId);
			});
			shell.addEventListener("pointermove", (event) => {
				if (
					!drag || drag.id !== event.pointerId
					|| !drag.moved && !hasPanelDragMoved(drag.start, event.clientX, event.clientY)
				) {
					return;
				}
				drag.moved = true;
				offset = getPanelDragOffset(drag.start, event.clientX, event.clientY);
				delete shell.dataset.position;
				Object.assign(shell.style, {
					left: `${offset.x}px`,
					top: `${offset.y}px`,
					right: "auto",
					bottom: "auto",
				});
				origin();
			});
			shell.addEventListener("pointerup", endDrag);
			shell.addEventListener("pointercancel", endDrag);
			shell.addEventListener("lostpointercapture", endDrag);
		}
		if (options.productionEnabled !== false) {
			(options.target ?? document.body).append(root);
		}
		const shortcuts = options.productionEnabled !== false ? mountShortcutListener() : void 0;
		const stopGlobal = options.productionEnabled !== false
			? DialStore.subscribeGlobal(render)
			: () => {
			};
		const stopTimelines = options.productionEnabled !== false
			? TimelineStore.subscribeGlobal(render)
			: () => {
			};
		const stopOpen = DialStore.subscribePanelOpen((id, open) => {
			if (destroyed) {
				return;
			}
			const panels = DialStore.getPanels("panel");
			if (!panels.some((p) => p.id === id)) {
				return;
			}
			if (panels.length > 1 && open) {
				setShellOpen(true);
			} else if (panels.length === 1) {
				notify(open);
			}
			if (!open && !inline && offset) {
				position = getPanelCorner(position, offset);
				offset = null;
				shell.style.cssText = "";
				shell.dataset.position = position;
				origin();
			}
		});
		if (options.productionEnabled !== false) {
			render();
		}
		return {
			element: root,
			destroy() {
				if (destroyed) {
					return;
				}
				destroyed = true;
				endDrag();
				stopGlobal();
				stopTimelines();
				stopOpen();
				shortcuts?.destroy();
				children.forEach((child) => child.destroy());
				root.remove();
			},
		};
	}
	var DialRoot = createDialRoot;

	// src/timeline-core.ts
	var CLIP_VALUE_STEP = 0.01;
	var TIMELINE_MIN_CLIP_DURATION = 0.05;
	var DEFAULT_STEP_DURATION = 0.3;
	var DEFAULT_CLIP_TRANSITION = { type: "spring", bounce: 0.2 };
	var RESERVED_KEYS = /* @__PURE__ */ new Set([
		"time",
		"playing",
		"duration",
		"play",
		"pause",
		"replay",
		"seek",
	]);
	function isClipConfig(value) {
		return isPlainObject(value) && Number.isFinite(value.at);
	}
	function isGroupConfig(value) {
		if (!isPlainObject(value) || "at" in value) return false;
		const entries = Object.values(value);
		return entries.length > 0 && entries.some(isClipConfig);
	}
	function isPlainObject(value) {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}
	function nonNegativeFinite(value, fallback = 0) {
		return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
	}
	function animatedDuration(value, fallback = DEFAULT_STEP_DURATION) {
		return Math.max(TIMELINE_MIN_CLIP_DURATION, nonNegativeFinite(value, fallback));
	}
	function transitionDefaultDuration(transition) {
		if (transition.type === "easing") return animatedDuration(transition.duration);
		if (isPhysicsSpring(transition)) {
			return animatedDuration(springSettleDuration(springParams(transition)));
		}
		if (transition.visualDuration !== void 0) return animatedDuration(transition.visualDuration);
		return animatedDuration(springSettleDuration(springParams(transition)));
	}
	function defaultStepDuration(step, inheritedTransition) {
		const curve = step.transition ?? inheritedTransition;
		if (curve && isPhysicsSpring(curve)) return transitionDefaultDuration(curve);
		if (step.duration !== void 0) return animatedDuration(step.duration);
		if (step.transition) return transitionDefaultDuration(step.transition);
		return DEFAULT_STEP_DURATION;
	}
	function defaultTrackDuration(track, inheritedTransition) {
		const curve = track.transition ?? inheritedTransition;
		if (track.steps?.length) {
			return track.steps.reduce((sum, step) => sum + defaultStepDuration(step, curve), 0);
		}
		if (curve && isPhysicsSpring(curve)) return transitionDefaultDuration(curve);
		if (track.duration !== void 0) return animatedDuration(track.duration);
		if (track.transition) return transitionDefaultDuration(track.transition);
		return DEFAULT_STEP_DURATION;
	}
	function defaultClipDuration(clip) {
		const defaultCurve = isTransitionConfig(clip.transition)
			? clip.transition
			: DEFAULT_CLIP_TRANSITION;
		if (clip.props) {
			return Object.values(clip.props).reduce(
				(max, track) =>
					Math.max(
						max,
						nonNegativeFinite(track.delay) + defaultTrackDuration(track, defaultCurve),
					),
				0,
			);
		}
		if (clip.steps?.length) {
			return clip.steps.reduce((sum, step) => sum + defaultStepDuration(step, defaultCurve), 0);
		}
		const animating = Boolean(clip.transition || clip.from || clip.to);
		if (!animating) return nonNegativeFinite(clip.duration);
		if (isPhysicsSpring(defaultCurve)) return transitionDefaultDuration(defaultCurve);
		if (clip.duration !== void 0) return animatedDuration(clip.duration);
		if (isTransitionConfig(clip.transition)) return transitionDefaultDuration(clip.transition);
		return clip.from || clip.to ? transitionDefaultDuration(DEFAULT_CLIP_TRANSITION) : 0;
	}
	function normalizeLoopMode(value) {
		if (value === true || value === "mirror" || value === "repeat") return "repeat";
		return "off";
	}
	function normalizeStoredTransition(transition, clipDuration) {
		if (transition.type === "easing") {
			return { ...transition, duration: clipDuration };
		}
		if (isPhysicsSpring(transition)) {
			return transition;
		}
		return { type: "spring", bounce: transition.bounce ?? 0.2 };
	}
	function collectClipEntries(config) {
		const entries = [];
		for (const [key, value] of Object.entries(config)) {
			if (key === "duration") continue;
			if (RESERVED_KEYS.has(key)) {
				console.warn(
					`[dialkit] Timeline key "${key}" collides with a reserved key and was skipped.`,
				);
				continue;
			}
			if (isClipConfig(value)) {
				entries.push({ path: key, childKey: key, clip: value });
			} else if (isGroupConfig(value)) {
				for (const [childKey, childClip] of Object.entries(value)) {
					if (isClipConfig(childClip)) {
						entries.push({ path: `${key}.${childKey}`, childKey, group: key, clip: childClip });
					} else {
						console.warn(
							`[dialkit] Timeline clip "${key}.${childKey}" is missing a numeric "at" and was skipped.`,
						);
					}
				}
			} else {
				console.warn(
					`[dialkit] Timeline entry "${key}" is neither a clip (needs a numeric "at") nor a group of clips and was skipped.`,
				);
			}
		}
		return entries;
	}
	function definedValues(values) {
		if (!values) return void 0;
		const result = {};
		for (const [key, value] of Object.entries(values)) {
			if (value !== void 0) result[key] = value;
		}
		return result;
	}
	function setDialPath(dialConfig, path, value) {
		const segments = path.split(".");
		let node = dialConfig;
		for (const segment of segments.slice(0, -1)) {
			node = node[segment] ?? (node[segment] = {});
		}
		node[segments[segments.length - 1]] = value;
	}
	function parseTimelineConfig(config) {
		const entries = collectClipEntries(config);
		let maxEnd = 0;
		for (const { clip } of entries) {
			maxEnd = Math.max(maxEnd, nonNegativeFinite(clip.at) + defaultClipDuration(clip));
		}
		const duration =
			typeof config.duration === "number" && Number.isFinite(config.duration) && config.duration > 0
				? config.duration
				: maxEnd > 0
				? Math.ceil(maxEnd * 100 - 1e-4) / 100
				: 1;
		const dialConfig = {};
		const clips = [];
		entries.forEach(({ path, childKey, group, clip }, index) => {
			const raw = clip;
			if (raw.props && (raw.steps?.length || raw.from || raw.to)) {
				console.warn(
					`[dialkit] Timeline clip "${path}": "props" is mutually exclusive with from/to/steps \u2014 using "props".`,
				);
			} else if (raw.steps?.length && raw.to) {
				console.warn(
					`[dialkit] Timeline clip "${path}": "to" is ignored when "steps" is present \u2014 each leg's "to" defines its targets.`,
				);
			}
			const hasSteps = Boolean(clip.steps?.length) && !clip.props;
			const hasProps = Boolean(clip.props);
			const single = isTransitionConfig(clip.transition) ? clip.transition : void 0;
			const total = defaultClipDuration(clip);
			const defaultCurve = single ?? DEFAULT_CLIP_TRANSITION;
			const clipAt = nonNegativeFinite(clip.at);
			const clipDial = {
				at: [clipAt, 0, duration, CLIP_VALUE_STEP],
			};
			if (!hasSteps && !hasProps) {
				clipDial.duration = [total, 0, duration, CLIP_VALUE_STEP];
			}
			if (!hasSteps && !hasProps && (clip.transition || clip.from || clip.to)) {
				clipDial.transition = normalizeStoredTransition(defaultCurve, total);
			}
			let tracks;
			if (clip.props) {
				tracks = [];
				for (const [prop, track] of Object.entries(clip.props)) {
					if (TRACK_RESERVED.has(prop) || /^step\d+$/.test(prop)) {
						console.warn(
							`[dialkit] Timeline property "${prop}" collides with a clip field and was skipped.`,
						);
						continue;
					}
					const trackDuration = defaultTrackDuration(track, defaultCurve);
					const trackCurve = track.transition ?? defaultCurve;
					const hasTrackSteps = Boolean(track.steps?.length);
					const trackDial = {
						delay: [nonNegativeFinite(track.delay), 0, duration, CLIP_VALUE_STEP],
					};
					if (!hasTrackSteps) {
						trackDial.duration = [trackDuration, 0, duration, CLIP_VALUE_STEP];
						trackDial.transition = normalizeStoredTransition(trackCurve, trackDuration);
					}
					const fromValue = track.from ?? (hasTrackSteps ? void 0 : track.to);
					if (hasTrackSteps && fromValue === void 0) {
						console.warn(
							`[dialkit] Timeline clip "${path}": track "${prop}" has steps but no "from" \u2014 declare its starting value.`,
						);
					}
					if (fromValue !== void 0) {
						trackDial.from = scalarDial(
							prop,
							fromValue,
							hasTrackSteps ? track.steps[0]?.to : track.to,
						);
					}
					if (!hasTrackSteps && track.to !== void 0) {
						trackDial.to = scalarDial(prop, track.to, fromValue);
					}
					let trackStepKeys;
					if (hasTrackSteps) {
						trackStepKeys = [];
						let previous = fromValue;
						track.steps.forEach((step, stepIndex) => {
							const stepKey = `step${stepIndex + 1}`;
							trackStepKeys.push(stepKey);
							const stepDuration = defaultStepDuration(step, trackCurve);
							const stepDial = {
								duration: [stepDuration, 0, duration, CLIP_VALUE_STEP],
								transition: normalizeStoredTransition(step.transition ?? trackCurve, stepDuration),
							};
							if (step.to !== void 0) {
								stepDial.to = scalarDial(prop, step.to, previous);
								previous = step.to;
							}
							trackDial[stepKey] = stepDial;
						});
					}
					clipDial[prop] = trackDial;
					tracks.push({ prop, stepKeys: trackStepKeys });
				}
			}
			if (clip.from && !hasProps) {
				clipDial.from = withFromToRanges(
					clip.from,
					hasSteps ? definedValues(clip.steps[0]?.to) : clip.to,
				);
			}
			if (!hasSteps && !hasProps && clip.to) {
				clipDial.to = withFromToRanges(clip.to, clip.from);
			}
			let stepKeys;
			if (hasSteps) {
				stepKeys = [];
				let running = clip.from;
				clip.steps.forEach((step, stepIndex) => {
					const stepKey = `step${stepIndex + 1}`;
					stepKeys.push(stepKey);
					const stepDuration = defaultStepDuration(step, defaultCurve);
					const stepDial = {
						duration: [stepDuration, 0, duration, CLIP_VALUE_STEP],
						transition: normalizeStoredTransition(step.transition ?? defaultCurve, stepDuration),
					};
					const stepTo = definedValues(step.to);
					if (stepTo) {
						for (const prop of Object.keys(stepTo)) {
							if (!running || !(prop in running)) {
								console.warn(
									`[dialkit] Timeline clip "${path}": property "${prop}" first animates in step ${
										stepIndex + 1
									} with no starting value \u2014 declare it in "from".`,
								);
							}
						}
						stepDial.to = withFromToRanges(stepTo, running);
					}
					clipDial[stepKey] = stepDial;
					running = { ...running, ...stepTo };
				});
			}
			setDialPath(dialConfig, path, clipDial);
			clips.push({
				key: path,
				label: formatLabel(childKey),
				color: TIMELINE_CLIP_COLORS[index % TIMELINE_CLIP_COLORS.length],
				loop: normalizeLoopMode(clip.loop),
				group,
				stepKeys,
				tracks,
			});
		});
		return { duration, dialConfig, clips };
	}
	var TRACK_RESERVED = /* @__PURE__ */ new Set([
		"at",
		"duration",
		"loop",
		"from",
		"to",
		"transition",
		"delay",
	]);
	function scalarDial(prop, value, counterpart) {
		const record = withFromToRanges(
			{ [prop]: value },
			counterpart === void 0 ? void 0 : { [prop]: counterpart },
		);
		return record[prop];
	}
	var FROM_TO_RANGE_PRESETS = [
		[/^(x|y|z|tx|ty|offsetx|offsety|translatex|translatey)$/i, { min: -100, max: 100, step: 1 }],
		[/rotat|angle|skew/i, { min: -180, max: 180, step: 1 }],
		[/^scale/i, { min: 0, max: 2, step: 0.01 }],
		[/opacity|alpha/i, { min: 0, max: 1, step: 0.01 }],
		[/blur|radius|spread/i, { min: 0, max: 100, step: 1 }],
	];
	function inferFromToRange(key, value, counterpart) {
		const lo = Math.min(value, counterpart ?? value);
		const hi = Math.max(value, counterpart ?? value);
		const preset = FROM_TO_RANGE_PRESETS.find(([pattern]) => pattern.test(key))?.[1];
		if (preset) {
			return [value, Math.min(preset.min, lo), Math.max(preset.max, hi), preset.step];
		}
		if (lo >= 0 && hi <= 1) {
			return [value, 0, 1, 0.01];
		}
		const extent = Math.max(Math.abs(lo), Math.abs(hi), 1);
		const min = lo < 0 ? -extent * 2 : 0;
		const max = Math.max(extent * 2, hi);
		return [value, min, max, inferStep(min, max)];
	}
	function withFromToRanges(config, counterpart) {
		const result = {};
		for (const [key, value] of Object.entries(config)) {
			const other = counterpart?.[key];
			if (typeof value === "number") {
				result[key] = inferFromToRange(key, value, typeof other === "number" ? other : void 0);
			} else if (isPlainObject(value) && !("type" in value)) {
				result[key] = withFromToRanges(
					value,
					isPlainObject(other) && !("type" in other) ? other : void 0,
				);
			} else {
				result[key] = value;
			}
		}
		return result;
	}
	function curveStatic(transition, duration) {
		if (!transition) return { duration };
		if (transition.type === "easing") return { duration, ease: transition.ease };
		const spring = springParams(transition);
		return { duration, spring, settle: springSettleDuration(spring) };
	}
	function sampleCurve(curve, elapsed) {
		if (elapsed <= 0) return 0;
		if (curve.spring) {
			if (curve.settle !== void 0 && elapsed >= curve.settle) return 1;
			return springProgress(elapsed, curve.spring);
		}
		if (curve.ease) {
			return cubicBezierProgress(
				clamp2(curve.duration > 0 ? elapsed / curve.duration : 1, 0, 1),
				curve.ease,
			);
		}
		return curve.duration > 0 ? Math.min(1, elapsed / curve.duration) : 1;
	}
	function resolvedAtPath(resolved, path) {
		let node = resolved;
		for (const segment of path.split(".")) {
			node = isPlainObject(node) ? node[segment] : void 0;
		}
		return isPlainObject(node) ? node : {};
	}
	function computeStaticClips(parsed, flatValues) {
		const resolved = resolveDialValues(parsed.dialConfig, flatValues);
		return parsed.clips.map(
			(clip) => buildClipStatic(resolvedAtPath(resolved, clip.key), clip, parsed.duration),
		);
	}
	function computeStaticTimeline(parsed, flatValues) {
		let clips = computeStaticClips(parsed, flatValues);
		const maxEnd = clips.reduce(
			(end, clip) => Math.max(end, clip.at + clip.duration),
			parsed.duration,
		);
		const duration = maxEnd > parsed.duration
			? Math.ceil(maxEnd * 100 - 1e-4) / 100
			: parsed.duration;
		if (duration !== parsed.duration) {
			clips = clips.map(
				(clip) => clip.loop === "repeat" ? { ...clip, end: duration } : clip,
			);
		}
		return { duration, clips };
	}
	function computeClipStaticFromValues(values, clip, timelineDuration) {
		return buildClipStatic(unflattenClipValues(values, clip.key), clip, timelineDuration);
	}
	function buildClipStatic(clipResolved, clip, timelineDuration) {
		{
			const at = typeof clipResolved.at === "number" ? clipResolved.at : 0;
			const from = isPlainObject(clipResolved.from) ? clipResolved.from : void 0;
			const single = isTransitionConfig(clipResolved.transition) ? clipResolved.transition : void 0;
			const staticClip = {
				key: clip.key,
				childKey: clip.group ? clip.key.slice(clip.group.length + 1) : clip.key,
				group: clip.group,
				at,
				duration: 0,
				loop: "off",
				end: 0,
				isPhysics: false,
				from,
				tracks: [],
				explicitSteps: Boolean(clip.stepKeys?.length),
			};
			if (clip.tracks?.length) {
				const tracks = clip.tracks.map(({ prop, stepKeys }) => {
					const trackResolved = isPlainObject(clipResolved[prop]) ? clipResolved[prop] : {};
					const delay = typeof trackResolved.delay === "number" ? trackResolved.delay : 0;
					const fromValue = trackResolved.from;
					let steps;
					let trackDuration = 0;
					if (stepKeys?.length) {
						let running = fromValue;
						steps = stepKeys.map((stepKey) => {
							const stepResolved = isPlainObject(trackResolved[stepKey])
								? trackResolved[stepKey]
								: {};
							const storedDuration = typeof stepResolved.duration === "number"
								? stepResolved.duration
								: 0;
							const raw = isTransitionConfig(stepResolved.transition)
								? stepResolved.transition
								: void 0;
							const effective = raw
								? resolveClipTransition(raw, storedDuration)
								: { transition: void 0, duration: storedDuration, isPhysics: false };
							const toValue = stepResolved.to;
							const step = {
								key: stepKey,
								offset: trackDuration,
								duration: effective.duration,
								isPhysics: effective.isPhysics,
								start: running === void 0 ? {} : { [prop]: running },
								to: toValue === void 0 ? {} : { [prop]: toValue },
								curve: curveStatic(effective.transition, effective.duration),
							};
							if (toValue !== void 0) running = toValue;
							trackDuration += effective.duration;
							return step;
						});
					} else {
						const storedDuration = typeof trackResolved.duration === "number"
							? trackResolved.duration
							: 0;
						const raw = isTransitionConfig(trackResolved.transition)
							? trackResolved.transition
							: void 0;
						const effective = raw
							? resolveClipTransition(raw, storedDuration)
							: { transition: void 0, duration: storedDuration, isPhysics: false };
						const toValue = trackResolved.to;
						trackDuration = effective.duration;
						steps = [
							{
								key: null,
								offset: 0,
								duration: effective.duration,
								isPhysics: effective.isPhysics,
								start: fromValue === void 0 ? {} : { [prop]: fromValue },
								to: toValue === void 0 ? {} : { [prop]: toValue },
								curve: curveStatic(effective.transition, effective.duration),
							},
						];
					}
					return { prop, delay, duration: trackDuration, steps };
				});
				staticClip.tracks = tracks;
				staticClip.props = tracks.map((track) => track.prop);
				staticClip.duration = tracks.reduce(
					(max, track) => Math.max(max, track.delay + track.duration),
					0,
				);
				staticClip.from = Object.fromEntries(
					tracks.map((track) => [track.prop, track.steps[0].start[track.prop]]),
				);
				staticClip.to = Object.fromEntries(
					tracks.map((track) => {
						const last = track.steps[track.steps.length - 1];
						return [track.prop, last.to[track.prop] ?? last.start[track.prop]];
					}),
				);
				staticClip.loop = staticClip.duration > 0 ? clip.loop : "off";
				staticClip.end = staticClip.loop === "off"
					? staticClip.at + staticClip.duration
					: timelineDuration;
				return staticClip;
			}
			if (clip.stepKeys?.length) {
				let running = { ...from };
				let offset = 0;
				const steps = clip.stepKeys.map((stepKey) => {
					const stepResolved = isPlainObject(clipResolved[stepKey]) ? clipResolved[stepKey] : {};
					const storedDuration = typeof stepResolved.duration === "number"
						? stepResolved.duration
						: 0;
					const raw = isTransitionConfig(stepResolved.transition)
						? stepResolved.transition
						: void 0;
					const effective = raw
						? resolveClipTransition(raw, storedDuration)
						: { transition: void 0, duration: storedDuration, isPhysics: false };
					const to = isPlainObject(stepResolved.to) ? stepResolved.to : {};
					const step = {
						key: stepKey,
						offset,
						duration: effective.duration,
						isPhysics: effective.isPhysics,
						start: running,
						to,
						curve: curveStatic(effective.transition, effective.duration),
					};
					running = { ...running, ...to };
					offset += effective.duration;
					return step;
				});
				staticClip.tracks = [{ delay: 0, duration: offset, steps }];
				staticClip.duration = offset;
				staticClip.to = running;
			} else {
				const storedDuration = typeof clipResolved.duration === "number"
					? clipResolved.duration
					: 0;
				const to = isPlainObject(clipResolved.to) ? clipResolved.to : void 0;
				if (single) {
					const effective = resolveClipTransition(single, storedDuration);
					staticClip.duration = effective.duration;
					staticClip.isPhysics = effective.isPhysics;
					staticClip.transition = effective.transition;
					staticClip.css = transitionToCss(effective.transition);
					staticClip.to = to;
					if (from && to) {
						staticClip.tracks = [
							{
								delay: 0,
								duration: effective.duration,
								steps: [
									{
										key: null,
										offset: 0,
										duration: effective.duration,
										isPhysics: effective.isPhysics,
										start: from,
										to,
										curve: curveStatic(effective.transition, effective.duration),
									},
								],
							},
						];
					}
				} else {
					staticClip.duration = storedDuration;
					staticClip.to = to;
					if (from && to) {
						const base = resolveClipTransition(DEFAULT_CLIP_TRANSITION, storedDuration);
						staticClip.duration = base.duration;
						staticClip.tracks = [
							{
								delay: 0,
								duration: base.duration,
								steps: [
									{
										key: null,
										offset: 0,
										duration: base.duration,
										isPhysics: false,
										start: from,
										to,
										curve: curveStatic(base.transition, base.duration),
									},
								],
							},
						];
					}
				}
			}
			if (staticClip.tracks.length) {
				const props = new Set(Object.keys(from ?? {}));
				for (const track of staticClip.tracks) {
					for (const step of track.steps) {
						for (const prop of Object.keys(step.to)) props.add(prop);
					}
				}
				staticClip.props = Array.from(props);
			}
			staticClip.loop = staticClip.duration > 0 ? clip.loop : "off";
			staticClip.end = staticClip.loop === "off"
				? staticClip.at + staticClip.duration
				: timelineDuration;
			return staticClip;
		}
	}
	function stepAtPosition(steps, pos) {
		for (const step of steps) {
			if (pos < step.offset + step.duration) return step;
		}
		return steps[steps.length - 1];
	}
	function evalPropAtPos(steps, prop, pos) {
		const step = stepAtPosition(steps, pos);
		const within = Math.max(0, pos - step.offset);
		if (prop in step.to) {
			const eased = sampleCurve(step.curve, within);
			return interpolateResolved(step.start[prop], step.to[prop], eased);
		}
		return step.start[prop];
	}
	function computeClipState(clip, time, cycleTime = time) {
		const total = clip.duration;
		const looping = clip.loop === "repeat" && total > 0;
		const started = time >= clip.at || looping && cycleTime > time;
		const done = time >= clip.end;
		const elapsed = time - clip.at;
		const phaseElapsed = looping ? cycleTime - clip.at : elapsed;
		const fold = (e) => looping ? e % total : e;
		const basePos = started ? fold(Math.max(0, phaseElapsed)) : 0;
		const progress = total > 0 ? clamp2(basePos / total, 0, 1) : started ? 1 : 0;
		let current;
		let stepIndex = 0;
		if (clip.tracks.length && clip.props?.length) {
			current = {};
			for (const track of clip.tracks) {
				const props = track.prop !== void 0 ? [track.prop] : clip.props;
				for (const prop of props) {
					const startValue = track.steps[0]?.start[prop];
					if (!started) {
						if (startValue !== void 0) current[prop] = startValue;
						continue;
					}
					const phase = phaseElapsed - track.delay;
					if (phase <= 0) {
						if (startValue !== void 0) current[prop] = startValue;
						continue;
					}
					const pos = looping && track.duration > 0 ? phase % track.duration : phase;
					const value = evalPropAtPos(track.steps, prop, pos);
					if (value !== void 0) current[prop] = value;
				}
			}
			const shared = clip.tracks[0];
			if (started && clip.explicitSteps && shared.prop === void 0) {
				stepIndex = shared.steps.indexOf(stepAtPosition(shared.steps, basePos));
			}
		}
		return {
			at: clip.at,
			duration: clip.duration,
			loop: clip.loop,
			started,
			active: started && !done,
			done,
			progress,
			step: clip.explicitSteps ? stepIndex : void 0,
			from: clip.from,
			to: clip.to,
			animate: started ? clip.to : clip.from,
			transition: clip.transition,
			css: clip.css,
			current,
		};
	}
	function interpolateResolved(from, to, p) {
		if (typeof from === "number" && typeof to === "number") {
			return from + (to - from) * p;
		}
		if (typeof from === "string" && typeof to === "string") {
			const mixed = mixHexColors(from, to, p);
			if (mixed) return mixed;
		}
		if (isPlainObject(from) && isPlainObject(to)) {
			const result = {};
			for (const key of Object.keys(from)) {
				result[key] = key in to ? interpolateResolved(from[key], to[key], p) : from[key];
			}
			for (const key of Object.keys(to)) {
				if (!(key in from)) result[key] = to[key];
			}
			return result;
		}
		return p < 0.5 ? from : to;
	}
	function parseHex(hex) {
		if (!isHexColor(hex)) return null;
		let h = hex.slice(1);
		if (h.length === 3) h = h.split("").map((c) => c + c).join("");
		return [
			parseInt(h.slice(0, 2), 16),
			parseInt(h.slice(2, 4), 16),
			parseInt(h.slice(4, 6), 16),
			h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255,
		];
	}
	function mixHexColors(a, b, p) {
		const ca = parseHex(a);
		const cb = parseHex(b);
		if (!ca || !cb) return null;
		const t = clamp2(p, 0, 1);
		const mixed = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
		const hex = (n) => n.toString(16).padStart(2, "0");
		const rgb = `#${hex(mixed[0])}${hex(mixed[1])}${hex(mixed[2])}`;
		return mixed[3] === 255 ? rgb : `${rgb}${hex(mixed[3])}`;
	}
	function transitionToCss(transition) {
		if (!transition) return void 0;
		if (transition.type === "easing") {
			return {
				transitionDuration: `${round2(transition.duration)}s`,
				transitionTimingFunction: `cubic-bezier(${
					transition.ease.map((v) => round2(v)).join(", ")
				})`,
			};
		}
		const params = springParams(transition);
		const dampingRatio = params.damping / (2 * Math.sqrt(params.stiffness * params.mass));
		const duration = transition.visualDuration ?? springSettleDuration(params);
		const bounce = transition.bounce ?? Math.max(0, round2(1 - dampingRatio));
		return {
			transitionDuration: `${round2(duration)}s`,
			transitionTimingFunction: bounce > 0.05
				? `cubic-bezier(0.34, ${round2(1.2 + bounce)}, 0.64, 1)`
				: "cubic-bezier(0.25, 0.6, 0.35, 1)",
		};
	}
	function timelinePopoverDisplayValues(values, clipKey, stepKeys, stepKey) {
		const display = { ...values };
		const swap = (path, duration) => {
			const raw = display[path];
			if (isTransitionConfig(raw)) display[path] = resolveClipTransition(raw, duration).transition;
		};
		if (stepKey) {
			swap(
				`${clipKey}.${stepKey}.transition`,
				numberValue(values[`${clipKey}.${stepKey}.duration`]),
			);
			return display;
		}
		const cycle = stepKeys?.length
			? stepKeys.reduce((sum, sk) => sum + numberValue(values[`${clipKey}.${sk}.duration`]), 0)
			: numberValue(values[`${clipKey}.duration`]);
		swap(`${clipKey}.transition`, cycle);
		return display;
	}
	function numberValue(value) {
		return typeof value === "number" ? value : 0;
	}
	function unflattenClipValues(values, clipKey) {
		const prefix = `${clipKey}.`;
		const result = {};
		const entries = Object.entries(values).filter(([path]) => path.startsWith(prefix)).map((
			[path, value],
		) => ({ segments: path.slice(prefix.length).split("."), value })).sort((a, b) =>
			a.segments.length - b.segments.length
		);
		for (const { segments, value } of entries) {
			let node = result;
			for (let i = 0; i < segments.length - 1; i++) {
				const existing = node[segments[i]];
				node = isPlainObject(existing) ? existing : node[segments[i]] = {};
			}
			node[segments[segments.length - 1]] = cloneTimelineValue(value);
		}
		return result;
	}
	function cloneTimelineValue(value) {
		if (Array.isArray(value)) return value.map(cloneTimelineValue);
		if (!isPlainObject(value)) return value;
		return Object.fromEntries(
			Object.entries(value).map(([key, nested]) => [key, cloneTimelineValue(nested)]),
		);
	}
	function clampTrackDelay(delay, at, trackDuration, timelineDuration) {
		return clamp2(round2(delay), 0, Math.max(0, round2(timelineDuration - at - trackDuration)));
	}
	function clampClipMove(at, duration, timelineDuration) {
		return clamp2(round2(at), 0, Math.max(0, timelineDuration - duration));
	}
	function clampClipResizeEnd(duration, at, timelineDuration) {
		return clamp2(round2(duration), TIMELINE_MIN_CLIP_DURATION, timelineDuration - at);
	}
	function clampClipResizeStart(newAt, at, duration) {
		const clampedAt = clamp2(round2(newAt), 0, at + duration - TIMELINE_MIN_CLIP_DURATION);
		return { at: clampedAt, duration: round2(at + duration - clampedAt) };
	}
	function clampStepResize(duration, at, otherStepsTotal, timelineDuration) {
		const max = Math.max(TIMELINE_MIN_CLIP_DURATION, timelineDuration - at - otherStepsTotal);
		return clamp2(round2(duration), TIMELINE_MIN_CLIP_DURATION, max);
	}
	function normalizeTimelineValuesForCopy(values, clips) {
		const normalized = { ...values };
		for (const path of Object.keys(normalized)) {
			if (path.endsWith(".__mode")) delete normalized[path];
		}
		const normalizeTransitionAt = (transitionPath, durationPath) => {
			const raw = normalized[transitionPath];
			if (!isTransitionConfig(raw)) return;
			if (isPhysicsSpring(raw)) {
				normalized[durationPath] = transitionDefaultDuration(raw);
			}
			normalized[transitionPath] = normalizeStoredTransition(
				raw,
				numberValue(normalized[durationPath]),
			);
		};
		for (const clip of clips) {
			for (const stepKey of clip.stepKeys ?? []) {
				normalizeTransitionAt(
					`${clip.key}.${stepKey}.transition`,
					`${clip.key}.${stepKey}.duration`,
				);
			}
			normalizeTransitionAt(`${clip.key}.transition`, `${clip.key}.duration`);
			for (const track of clip.tracks ?? []) {
				const trackKey = `${clip.key}.${track.prop}`;
				for (const stepKey of track.stepKeys ?? []) {
					normalizeTransitionAt(
						`${trackKey}.${stepKey}.transition`,
						`${trackKey}.${stepKey}.duration`,
					);
				}
				normalizeTransitionAt(`${trackKey}.transition`, `${trackKey}.duration`);
				if (normalized[`${trackKey}.delay`] === 0) {
					delete normalized[`${trackKey}.delay`];
				}
			}
			delete normalized[`${clip.key}.loop`];
		}
		return normalized;
	}
	function formatClock(time, tenths = false) {
		const safe = Math.max(0, time);
		const minutes = Math.floor(safe / 60);
		const seconds = safe - minutes * 60;
		const secondsText = tenths
			? seconds.toFixed(1).padStart(4, "0")
			: String(Math.floor(seconds)).padStart(2, "0");
		return `${String(minutes).padStart(2, "0")}:${secondsText}`;
	}
	function formatSeconds(value) {
		return `${round2(value)}s`;
	}
	function formatStepLabel(stepKey) {
		const match = /^step(\d+)$/.exec(stepKey);
		return match ? `Step ${match[1]}` : formatLabel(stepKey);
	}

	// src/timeline/adapter.ts
	function resolveTimelineLoop(loop) {
		if (typeof loop === "object" && loop !== null) {
			return {
				enabled: true,
				start: Number.isFinite(loop.from) ? Math.max(0, loop.from) : 0,
			};
		}
		return { enabled: Boolean(loop), start: 0 };
	}
	function buildTimelineMeta(id, name, duration, parsed, loop) {
		const resolvedLoop = resolveTimelineLoop(loop);
		return {
			id,
			name,
			duration,
			loop: resolvedLoop.enabled,
			loopStart: resolvedLoop.start,
			clips: parsed.clips,
		};
	}
	function buildTimelineValues(staticClips, transport, timelineDuration, loopStart, actions) {
		var _a;
		const result = {
			time: transport.time,
			playing: transport.playing,
			duration: timelineDuration,
			...actions,
		};
		const span = loopSpan(transport.duration, loopStart);
		const cycleTime = (span > 0 ? transport.wraps * span : 0) + transport.time;
		for (const clip of staticClips) {
			const state = computeClipState(clip, transport.time, cycleTime);
			if (clip.group) {
				const bucket = result[_a = clip.group] ?? (result[_a] = {});
				bucket[clip.childKey] = state;
			} else {
				result[clip.key] = state;
			}
		}
		return result;
	}

	// src/vanilla/createDialTimeline.ts
	var nextId4 = 0;
	function createDialTimeline(name, config, options = {}) {
		const id = options.id ?? `vanilla-timeline-${name}-${++nextId4}`;
		let parsed = parseTimelineConfig(config);
		let destroyed = false;
		const registration = {
			retainOnUnmount: options.id !== void 0,
			persist: options.persist,
			kind: "timeline",
		};
		DialStore.registerPanel(id, name, parsed.dialConfig, void 0, registration);
		let compiled = computeStaticTimeline(parsed, DialStore.getValues(id));
		const meta = () => buildTimelineMeta(id, name, compiled.duration, parsed, options.loop);
		TimelineStore.register(meta(), { autoplay: options.autoplay ?? true });
		const actions = {
			play() {
				if (!destroyed) {
					TimelineStore.play(id);
				}
			},
			pause() {
				if (!destroyed) {
					TimelineStore.pause(id);
				}
			},
			replay() {
				if (!destroyed) {
					TimelineStore.replay(id);
				}
			},
			seek(time) {
				if (!destroyed) {
					TimelineStore.seek(id, time);
				}
			},
		};
		const listeners2 = /* @__PURE__ */ new Set();
		const getValues = () =>
			buildTimelineValues(
				compiled.clips,
				TimelineStore.getTransport(id),
				compiled.duration,
				resolveTimelineLoop(options.loop).start,
				actions,
			);
		const notify = () => {
			const values = getValues();
			listeners2.forEach((listener) => listener(values));
		};
		const stopValues = DialStore.subscribe(id, () => {
			compiled = computeStaticTimeline(parsed, DialStore.getValues(id));
			TimelineStore.update(meta());
		});
		const stopTransport = TimelineStore.subscribe(id, notify);
		return {
			id,
			...actions,
			get values() {
				return getValues();
			},
			getValues,
			subscribe(listener, immediate = true) {
				if (destroyed) {
					return () => {
					};
				}
				listeners2.add(listener);
				if (immediate) {
					listener(getValues());
				}
				return () => {
					listeners2.delete(listener);
				};
			},
			updateConfig(next) {
				if (destroyed) {
					return;
				}
				parsed = parseTimelineConfig(next);
				DialStore.updatePanel(id, name, parsed.dialConfig, void 0, registration);
			},
			destroy() {
				if (destroyed) {
					return;
				}
				destroyed = true;
				listeners2.clear();
				stopValues();
				stopTransport();
				TimelineStore.unregister(id);
				DialStore.unregisterPanel(id);
			},
		};
	}

	// src/vanilla/DialTimeline.ts
	function createDialTimelineRoot(initial = {}) {
		let options = initial;
		let destroyed = false;
		const root = element4("div", "dialkit-root dialkit-timeline");
		root.dataset.theme = options.theme ?? "system";
		const resize = element4("div", "dialkit-timeline-resize-handle");
		resize.setAttribute("role", "separator");
		resize.setAttribute("aria-label", "Resize timeline height");
		resize.setAttribute("aria-orientation", "horizontal");
		resize.tabIndex = 0;
		const dock = element4("div", "dialkit-timeline-dock");
		root.append(resize, dock);
		let height = 400;
		const size = () => {
			dock.style.maxHeight = `min(${height}px, calc(100vh - 24px))`;
		};
		size();
		const drag = pointerGesture();
		resize.addEventListener("pointerdown", (event) => {
			const start = dock.getBoundingClientRect().height;
			drag.start(event, (next) => {
				height = clamp2(
					start + event.clientY - next.clientY,
					120,
					Math.max(120, window.innerHeight - 24),
				);
				size();
			});
		});
		resize.addEventListener("keydown", (event) => {
			if (event.key === "ArrowUp" || event.key === "ArrowDown") {
				event.preventDefault();
				height = clamp2(
					height + (event.key === "ArrowUp" ? 20 : -20),
					120,
					Math.max(120, window.innerHeight - 24),
				);
				size();
			}
		});
		const sections = /* @__PURE__ */ new Map();
		const visibilityId = /* @__PURE__ */ Symbol("vanilla-timeline");
		const controller = () => ({
			visible: options.visible,
			defaultVisible: options.defaultVisible ?? true,
			onVisibilityChange: options.onVisibilityChange,
		});
		function render() {
			const timelines = TimelineStore.getTimelines();
			root.hidden = options.productionEnabled === false || !timelines.length
				|| !TimelineUiStore.getVisible();
			for (const [id, section] of sections) {
				if (!timelines.some((t) => t.id === id)) {
					section.destroy();
					sections.delete(id);
				}
			}
			for (const meta of timelines) {
				let section = sections.get(meta.id);
				if (!section) {
					section = mountSection(dock, meta, options);
					sections.set(meta.id, section);
				} else {
					section.update(meta, options.theme ?? "system");
				}
				if (root.hidden) {
					section.closeEditor();
				}
			}
		}
		const enabled = options.productionEnabled !== false;
		const stopController = enabled
			? TimelineUiStore.registerController(visibilityId, controller())
			: () => {
			};
		const stopGlobal = enabled ? TimelineStore.subscribeGlobal(render) : () => {
		};
		const stopVisible = enabled ? TimelineUiStore.subscribe(render) : () => {
		};
		if (enabled) {
			(options.target ?? document.body).append(root);
			render();
		}
		return {
			element: root,
			setVisible(visible) {
				if (!destroyed) {
					TimelineUiStore.requestVisible(visible);
				}
			},
			update(next) {
				if (destroyed) {
					return;
				}
				options = { ...options, ...next };
				root.dataset.theme = options.theme ?? "system";
				TimelineUiStore.updateController(visibilityId, controller());
				render();
			},
			destroy() {
				if (destroyed) {
					return;
				}
				destroyed = true;
				drag.destroy();
				stopGlobal();
				stopVisible();
				stopController();
				sections.forEach((s) => s.destroy());
				sections.clear();
				root.remove();
			},
		};
	}
	var DialTimeline = createDialTimelineRoot;
	function pointerGesture() {
		let finish;
		return {
			start(event, move, end) {
				if (event.button !== 0) {
					return;
				}
				finish?.(true);
				event.preventDefault();
				event.stopPropagation();
				const onMove = (next) => {
					if (next.pointerId === event.pointerId) {
						next.preventDefault();
						move(next);
					}
				};
				const onEnd = (next) => {
					if (next.pointerId === event.pointerId) {
						finish?.(next.type === "pointercancel");
					}
				};
				finish = (cancelled = false) => {
					finish = void 0;
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onEnd);
					window.removeEventListener("pointercancel", onEnd);
					end?.(cancelled);
				};
				window.addEventListener("pointermove", onMove, { passive: false });
				window.addEventListener("pointerup", onEnd);
				window.addEventListener("pointercancel", onEnd);
			},
			destroy() {
				finish?.(true);
			},
		};
	}
	function mountSection(host, initial, options) {
		let meta = initial;
		let theme = options.theme ?? "system";
		let open = options.defaultOpen ?? true;
		let zoom = 1, viewStart = 0;
		const groups = /* @__PURE__ */ new Set(), tracks = /* @__PURE__ */ new Set();
		const section = element4("div", "dialkit-timeline-section");
		const header = element4("div", "dialkit-timeline-header");
		const identity = element4("div", "dialkit-timeline-identity");
		const title = element4("span", "dialkit-timeline-title");
		identity.append(title);
		const overview = element4("div", "dialkit-timeline-overview");
		const viewport = element4("div", "dialkit-timeline-overview-viewport");
		const progress = element4("div", "dialkit-timeline-overview-progress");
		const marker = element4("div", "dialkit-timeline-overview-playhead");
		overview.append(viewport, progress, marker);
		const actions = element4("div", "dialkit-timeline-actions");
		header.append(identity, overview, actions);
		const play = button("Play timeline", ICON_PLAY, () => {
			if (TimelineStore.getTransport(meta.id).playing) {
				TimelineStore.pause(meta.id);
			} else {
				TimelineStore.play(meta.id);
			}
		});
		const replay = button("Replay timeline", ICON_REPLAY, () => {
			zoom = 1;
			viewStart = 0;
			render();
			TimelineStore.replay(meta.id);
		});
		actions.append(play, replay);
		const presetProps = () => ({
			panelId: meta.id,
			presets: DialStore.getPresets(meta.id),
			activePresetId: DialStore.getActivePresetId(meta.id),
		});
		const presets = mountPresetManager(actions, presetProps());
		let copyTimer;
		let destroyed = false;
		const copy = button(
			"Copy parameters",
			[ICON_CLIPBOARD_PLAIN.board, ICON_CLIPBOARD_PLAIN.body],
			async () => {
				try {
					await navigator.clipboard.writeText(
						buildCopyInstruction(
							"createDialTimeline",
							meta.name,
							normalizeTimelineValuesForCopy(DialStore.getValues(meta.id), meta.clips),
						),
					);
				} catch {
					return;
				}
				if (destroyed) {
					return;
				}
				copy.replaceChildren(icon2(ICON_CHECK));
				clearTimeout(copyTimer);
				copyTimer = setTimeout(
					() =>
						copy.replaceChildren(icon2([ICON_CLIPBOARD_PLAIN.board, ICON_CLIPBOARD_PLAIN.body])),
					1500,
				);
			},
		);
		copy.classList.add("dialkit-toolbar-primary");
		actions.append(copy);
		const collapse = element4("button", "dialkit-timeline-chevron");
		collapse.append(icon2(ICON_CHEVRON));
		collapse.addEventListener("click", () => {
			open = !open;
			closeEditor();
			render();
		});
		actions.append(collapse);
		const body = element4("div", "dialkit-timeline-body");
		const grid = element4("div", "dialkit-timeline-grid");
		const rulerRow = element4("div", "dialkit-timeline-row dialkit-timeline-ruler-row");
		const ruler = element4("div", "dialkit-timeline-ruler");
		ruler.title = "Drag to seek \xB7 Option-drag to zoom \xB7 Shift-drag to reset zoom";
		rulerRow.append(element4("div", "dialkit-timeline-label"), ruler);
		grid.append(rulerRow);
		const playhead = element4("div", "dialkit-timeline-playhead-control");
		playhead.setAttribute("role", "slider");
		playhead.tabIndex = 0;
		playhead.setAttribute("aria-label", "Timeline current time");
		const stem = element4("div", "dialkit-timeline-playhead-stem");
		const anchor = element4("div", "dialkit-timeline-playhead-anchor");
		const flag = element4("div", "dialkit-timeline-playhead-flag");
		anchor.append(flag);
		playhead.append(stem, anchor);
		grid.append(playhead);
		const scrollRow = element4("div", "dialkit-timeline-scroll-row");
		const scroll = element4("div", "dialkit-timeline-horizontal-scroll");
		scroll.setAttribute("aria-label", "Timeline horizontal scroll");
		const spacer = element4("div");
		scroll.append(spacer);
		scrollRow.append(element4("div", "dialkit-timeline-label"), scroll);
		body.append(grid, scrollRow);
		section.append(header, body);
		host.append(section);
		const gesture = pointerGesture();
		let rowElements = [];
		let editor;
		let selected = "";
		function closeEditor() {
			editor?.destroy();
			editor = void 0;
			selected = "";
			section.querySelectorAll(".dialkit-timeline-clip[data-selected]").forEach((node) =>
				delete node.dataset.selected
			);
		}
		const width = () => ruler.clientWidth;
		const visibleDuration = () => meta.duration / zoom;
		const scale = () => meta.duration > 0 ? width() / visibleDuration() : 0;
		function transport() {
			const state = TimelineStore.getTransport(meta.id);
			play.setAttribute("aria-label", state.playing ? "Pause timeline" : "Play timeline");
			play.title = state.playing ? "Pause timeline" : "Play timeline";
			if (play.dataset.playing !== String(state.playing)) {
				play.dataset.playing = String(state.playing);
				play.replaceChildren(icon2(state.playing ? ICON_PAUSE : ICON_PLAY));
			}
			const percent = meta.duration > 0 ? state.time / meta.duration * 100 : 0;
			progress.style.width = marker.style.left = `${percent}%`;
			viewport.style.left = `${meta.duration > 0 ? viewStart / meta.duration * 100 : 0}%`;
			viewport.style.width = `${100 / zoom}%`;
			if (zoom > 1) {
				viewport.dataset.zoomed = "";
			} else {
				delete viewport.dataset.zoomed;
			}
			const x = clamp2((state.time - viewStart) * scale(), 0, width());
			const flagOffset = clamp2(x, 25, Math.max(25, width() - 25)) - x;
			playhead.style.display =
				state.time < viewStart || state.time > viewStart + visibleDuration() || !width()
					? "none"
					: "";
			playhead.style.left = `calc(var(--dial-timeline-label-w) + ${x}px)`;
			playhead.style.setProperty("--dial-timeline-playhead-flag-offset", `${flagOffset}px`);
			playhead.dataset.edge = flagOffset > 0.5 ? "start" : flagOffset < -0.5 ? "end" : "center";
			flag.textContent = state.time.toFixed(2);
			playhead.setAttribute("aria-valuemin", "0");
			playhead.setAttribute("aria-valuemax", String(meta.duration));
			playhead.setAttribute("aria-valuenow", String(state.time));
		}
		function scrub(event, full = false) {
			const rect = (full ? overview : ruler).getBoundingClientRect();
			if (!rect.width) {
				return;
			}
			closeEditor();
			if (event.shiftKey) {
				zoom = 1;
				viewStart = 0;
				render();
			}
			if (event.altKey && !full) {
				const startZoom = zoom,
					ratio = clamp2((event.clientX - rect.left) / rect.width, 0, 1),
					time = viewStart + ratio * visibleDuration();
				gesture.start(event, (next) => {
					zoom = clamp2(
						startZoom * Math.exp((next.clientX - event.clientX) / 180),
						1,
						Math.max(8, meta.duration * rect.width / 140),
					);
					viewStart = time - ratio * visibleDuration();
					render();
				});
				return;
			}
			const wasPlaying = TimelineStore.getTransport(meta.id).playing;
			const start = full ? 0 : viewStart, duration = full ? meta.duration : visibleDuration();
			TimelineStore.pause(meta.id);
			const seek = (next) => {
				const time = clamp2(
					start + (next.clientX - rect.left) / rect.width * duration,
					start,
					start + duration,
				);
				TimelineStore.seek(meta.id, time);
				if (full) {
					viewStart = time - visibleDuration() / 2;
					render();
				}
			};
			gesture.start(event, seek, () => {
				if (wasPlaying && !destroyed) {
					TimelineStore.play(meta.id);
				}
			});
			seek(event);
		}
		ruler.addEventListener("pointerdown", (event) => scrub(event));
		playhead.addEventListener("pointerdown", (event) => scrub(event));
		overview.addEventListener("pointerdown", (event) => scrub(event, true));
		playhead.addEventListener("keydown", (event) => {
			const current = TimelineStore.getTransport(meta.id).time;
			const next = event.key === "Home"
				? 0
				: event.key === "End"
				? meta.duration
				: event.key === "ArrowLeft"
				? current - (event.shiftKey ? 0.1 : 1e-3)
				: event.key === "ArrowRight"
				? current + (event.shiftKey ? 0.1 : 1e-3)
				: void 0;
			if (next !== void 0) {
				event.preventDefault();
				TimelineStore.seek(meta.id, next);
			}
		});
		body.addEventListener("pointerdown", (event) => {
			if (
				event.target.closest(".dialkit-timeline-lane")
				&& (!event.target.closest(".dialkit-timeline-clip") || event.shiftKey)
			) {
				scrub(event);
			}
		});
		scroll.addEventListener("scroll", () => {
			if (!scale()) {
				return;
			}
			const next = scroll.scrollLeft / scale();
			if (Math.abs(next - viewStart) < 1e-3) {
				return;
			}
			viewStart = next;
			closeEditor();
			render();
		});
		body.addEventListener("wheel", (event) => {
			const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
				? event.deltaX
				: event.shiftKey
				? event.deltaY
				: 0;
			if (zoom > 1 && delta) {
				event.preventDefault();
				scroll.scrollLeft += delta;
			}
		}, { passive: false });
		function row(label, className = "", grouped = false) {
			const root = element4("div", `dialkit-timeline-row ${className}`);
			if (grouped) {
				root.dataset.grouped = "";
			}
			const caption = element4("div", "dialkit-timeline-label", label),
				lane = element4("div", "dialkit-timeline-lane");
			root.append(caption, lane);
			grid.insertBefore(root, playhead);
			rowElements.push(root);
			return { root, caption, lane };
		}
		function disclosure(host2, isOpen, label, change) {
			const b = element4("button", "dialkit-timeline-group-toggle");
			b.title = label;
			b.setAttribute("aria-label", label);
			b.setAttribute("aria-expanded", String(isOpen));
			b.dataset.open = String(isOpen);
			b.append(icon2(ICON_CHEVRON));
			b.addEventListener("click", change);
			host2.prepend(b);
		}
		function render() {
			if (destroyed) {
				return;
			}
			title.textContent = meta.name;
			body.style.display = open ? "" : "none";
			overview.style.display = open ? "none" : "";
			if (open) {
				header.dataset.open = "";
			} else {
				delete header.dataset.open;
			}
			collapse.dataset.open = String(open);
			collapse.setAttribute("aria-expanded", String(open));
			collapse.title = open ? "Collapse timeline" : "Expand timeline";
			collapse.setAttribute("aria-label", collapse.title);
			viewStart = clamp2(viewStart, 0, Math.max(0, meta.duration - visibleDuration()));
			const px = scale();
			ruler.replaceChildren();
			const tickSteps = [
				1e-3,
				2e-3,
				5e-3,
				0.01,
				0.02,
				0.05,
				0.1,
				0.2,
				0.5,
				1,
				2,
				5,
				10,
				15,
				30,
				60,
				120,
				300,
				600,
			];
			let major = tickSteps.find((t) => t >= 140 / (px || 1)) ?? 600;
			if (zoom < 1.5 && meta.duration >= 1) {
				major = Math.max(1, major);
			}
			for (
				let i = Math.ceil(viewStart / (major / 10));
				i <= Math.floor((viewStart + visibleDuration()) / (major / 10));
				i++
			) {
				const tick = element4(
					"div",
					`dialkit-timeline-tick${
						i % 10 === 0
							? ""
							: i % 5 === 0
							? " dialkit-timeline-tick-medium"
							: " dialkit-timeline-tick-fine"
					}`,
				);
				tick.style.left = `${(i * major / 10 - viewStart) * px}px`;
				if (i % 10 === 0) {
					tick.append(
						element4(
							"span",
							"dialkit-timeline-tick-label",
							`${Number((i * major / 10).toFixed(3))}s`,
						),
					);
				}
				ruler.append(tick);
			}
			rowElements.forEach((r) => r.remove());
			rowElements = [];
			const values = DialStore.getValues(meta.id);
			let lastGroup;
			for (const clip of meta.clips) {
				if (clip.group && clip.group !== lastGroup) {
					const group = clip.group;
					const r2 = row(formatLabel(group), "dialkit-timeline-group-row");
					disclosure(
						r2.caption,
						!groups.has(group),
						groups.has(group) ? "Expand layer" : "Collapse layer",
						() => {
							if (!groups.delete(group)) {
								groups.add(group);
							}
							closeEditor();
							render();
						},
					);
				}
				lastGroup = clip.group;
				if (clip.group && groups.has(clip.group)) {
					continue;
				}
				const stat = computeClipStaticFromValues(values, clip, meta.duration);
				const r = row(clip.label, "", !!clip.group);
				const composite = !!clip.tracks?.length;
				if (composite) {
					disclosure(
						r.caption,
						tracks.has(clip.key),
						tracks.has(clip.key) ? "Collapse properties" : "Expand properties",
						() => {
							if (!tracks.delete(clip.key)) {
								tracks.add(clip.key);
							}
							closeEditor();
							render();
						},
					);
				}
				bar(
					r.lane,
					clip,
					stat.at,
					stat.duration,
					clip.stepKeys?.length ? stat.tracks[0]?.steps : void 0,
					stat.isPhysics,
					composite,
				);
				if (composite && tracks.has(clip.key)) {
					for (const trackRef of clip.tracks) {
						const track = stat.tracks.find((t) => t.prop === trackRef.prop);
						if (!track) {
							continue;
						}
						const r2 = row(formatLabel(trackRef.prop), "dialkit-timeline-track-row", !!clip.group);
						const trackMeta = {
							...clip,
							key: `${clip.key}.${trackRef.prop}`,
							label: `${clip.label} \xB7 ${formatLabel(trackRef.prop)}`,
							tracks: void 0,
							stepKeys: trackRef.stepKeys,
						};
						bar(
							r2.lane,
							trackMeta,
							stat.at + track.delay,
							track.duration,
							trackRef.stepKeys?.length ? track.steps : void 0,
							!trackRef.stepKeys?.length && track.steps[0]?.isPhysics === true,
							false,
							stat.at,
							true,
						);
					}
				}
			}
			scrollRow.style.display = zoom > 1 ? "" : "none";
			spacer.style.width = `${width() * zoom}px`;
			scroll.scrollLeft = viewStart * px;
			transport();
			presets.update(presetProps());
			editor?.update();
		}
		function bar(
			lane,
			clip,
			at,
			duration,
			steps,
			physics,
			composite = false,
			baseAt = 0,
			delayMode = false,
		) {
			const px = scale();
			if (clip.loop === "repeat" && duration > 0) {
				for (
					let index = Math.max(1, Math.floor((viewStart - at) / duration)), count = 0;
					at + duration * index < meta.duration && count < 256;
					index++, count++
				) {
					const ghost = element4("div", "dialkit-timeline-clip-ghost");
					ghost.setAttribute("aria-hidden", "true");
					Object.assign(ghost.style, {
						left: `${(at + duration * index - viewStart) * px + 1}px`,
						width: `${
							Math.max(1, Math.min(duration, meta.duration - at - duration * index) * px - 2)
						}px`,
						background: clip.color,
					});
					lane.append(ghost);
				}
			}
			const node = element4("div", "dialkit-timeline-clip");
			node.tabIndex = 0;
			node.setAttribute("role", "button");
			node.setAttribute("aria-label", `Edit ${clip.label}`);
			Object.assign(node.style, {
				left: `${(at - viewStart) * px}px`,
				width: `${Math.max(duration * px, 14)}px`,
				background: composite ? `${clip.color}80` : clip.color,
			});
			if (steps?.length) {
				node.dataset.steps = "";
			}
			if (composite) {
				node.dataset.composite = "";
			}
			if (selected === clip.key) {
				node.dataset.selected = "";
			}
			node.title = `${clip.label} \u2014 ${formatSeconds(at)} for ${physics ? "~" : ""}${
				formatSeconds(duration)
			}${physics ? " (duration set by spring physics)" : ""}${
				delayMode ? " \xB7 drag to phase-shift" : ""
			}`;
			const edge = (side) => {
				const handle = element4("div", "dialkit-timeline-clip-handle");
				handle.dataset.edge = side;
				node.append(handle);
			};
			if (steps?.length && !composite) {
				let offset = 0;
				for (const [index, step] of steps.entries()) {
					const segment = element4("div", "dialkit-timeline-clip-segment");
					segment.dataset.step = step.key ?? "";
					segment.style.width = `${step.duration * px}px`;
					if (step.duration * px > 52) {
						segment.append(
							element4("span", "dialkit-timeline-clip-duration", formatSeconds(step.duration)),
						);
					}
					node.append(segment);
					offset += step.duration;
					if (!step.isPhysics) {
						const handle = element4("div", "dialkit-timeline-clip-handle");
						handle.dataset.boundary = String(index);
						handle.style.left = `${offset * px - 4}px`;
						node.append(handle);
					}
				}
				if (!steps[0].isPhysics) {
					edge("start");
				}
			} else {
				if (!physics && !composite && duration > 0) {
					edge("start");
				}
				if (duration * px > 56) {
					node.append(
						element4(
							"span",
							"dialkit-timeline-clip-duration",
							`${physics && !composite ? "~" : ""}${formatSeconds(duration)}`,
						),
					);
				}
				if (!physics && !composite && duration > 0) {
					edge("end");
				}
			}
			lane.append(node);
			if (clip.loop === "repeat" && duration > 0) {
				lane.append(element4("span", "dialkit-timeline-loop-infinity", "\u221E"));
			}
			const edit = (target) => {
				if (composite) {
					if (!tracks.delete(clip.key)) {
						tracks.add(clip.key);
					}
					render();
				} else {
					openEditor(clip, target.closest("[data-step]") ?? node);
				}
			};
			node.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					edit(node);
				}
			});
			node.addEventListener("pointerdown", (event) => {
				if (event.shiftKey || event.button !== 0 || px <= 0) {
					return;
				}
				const target = event.target;
				const boundary = target.dataset.boundary;
				const mode = boundary !== void 0 ? "boundary" : target.dataset.edge ?? "move";
				const durations = steps?.map((s) => s.duration);
				let moved = false;
				gesture.start(event, (next) => {
					const dx = next.clientX - event.clientX;
					if (!moved && Math.abs(dx) <= 3) {
						return;
					}
					moved = true;
					closeEditor();
					const dt = dx / px;
					if (mode === "boundary" && steps && durations) {
						const index = Number(boundary);
						DialStore.updateValue(
							meta.id,
							`${clip.key}.${steps[index].key}.duration`,
							clampStepResize(
								durations[index] + dt,
								at,
								durations.reduce((sum, d, i) => sum + (i === index ? 0 : d), 0),
								meta.duration,
							),
						);
					} else if (mode === "move") {
						DialStore.updateValue(
							meta.id,
							`${clip.key}.${delayMode ? "delay" : "at"}`,
							delayMode
								? clampTrackDelay(at + dt - baseAt, baseAt, duration, meta.duration)
								: clampClipMove(at + dt, duration, meta.duration),
						);
					} else if (mode === "end") {
						DialStore.updateValue(
							meta.id,
							`${clip.key}.duration`,
							clampClipResizeEnd(duration + dt, at, meta.duration),
						);
					} else {
						const result = clampClipResizeStart(
							Math.max(at + dt, baseAt, 0),
							at,
							durations?.[0] ?? duration,
						);
						DialStore.updateValues(meta.id, {
							[`${clip.key}.${delayMode ? "delay" : "at"}`]: delayMode
								? Math.max(0, result.at - baseAt)
								: result.at,
							[`${clip.key}.${steps?.length ? `${steps[0].key}.` : ""}duration`]: result.duration,
						});
					}
				}, (cancelled) => {
					if (!destroyed && !moved && !cancelled) {
						edit(target);
					}
				});
			});
		}
		function openEditor(clip, target) {
			closeEditor();
			selected = clip.key;
			target.closest(".dialkit-timeline-clip")?.setAttribute("data-selected", "");
			const stepKey = target.dataset.step || void 0;
			const path = stepKey ? `${clip.key}.${stepKey}` : clip.key;
			const getControl = (path2) => findControl(DialStore.getPanel(meta.id)?.controls ?? [], path2);
			const excluded = /* @__PURE__ */ new Set([
				...clip.stepKeys ?? [],
				...clip.tracks?.map((t) => t.prop) ?? [],
			]);
			let controls =
				getControl(path)?.children?.filter((c) =>
					!["at", "duration"].includes(c.path.slice(path.length + 1))
					&& (stepKey || !excluded.has(c.path.slice(path.length + 1)))
				) ?? [];
			if (stepKey === clip.stepKeys?.[0]) {
				const from = getControl(`${clip.key}.from`);
				if (from) {
					const index = controls.findIndex((c) => c.path === `${path}.to`);
					controls = [...controls];
					controls.splice(index < 0 ? controls.length : index, 0, from);
				}
			}
			if (!controls.length) {
				return;
			}
			const root = element4("div", "dialkit-root");
			root.dataset.theme = theme;
			const popup = element4("div", "dialkit-timeline-popover");
			popup.setAttribute("role", "dialog");
			popup.setAttribute(
				"aria-label",
				`Edit ${clip.label}${stepKey ? ` \xB7 ${formatStepLabel(stepKey)}` : ""}`,
			);
			const heading = element4("div", "dialkit-timeline-popover-header");
			heading.append(
				element4(
					"span",
					"dialkit-timeline-popover-title",
					`${clip.label}${stepKey ? ` \xB7 ${formatStepLabel(stepKey)}` : ""}`,
				),
			);
			const close = element4("button", "dialkit-timeline-popover-close");
			close.title = "Close editor";
			close.setAttribute("aria-label", close.title);
			close.append(icon2("M6 6l12 12M18 6 6 18"));
			close.addEventListener("click", closeEditor);
			heading.append(close);
			const content = element4("div", "dialkit-timeline-popover-body");
			popup.append(heading, content);
			root.append(popup);
			document.body.append(root);
			const rendererProps = () => {
				const values = DialStore.getValues(meta.id);
				const durationMeta = getControl(`${path}.duration`);
				const duration = values[`${path}.duration`];
				return {
					panelId: meta.id,
					controls,
					values: timelinePopoverDisplayValues(values, clip.key, clip.stepKeys, stepKey),
					transitionDuration: durationMeta?.type === "slider" && typeof duration === "number"
						? {
							value: duration,
							onChange: (v) => DialStore.updateValue(meta.id, `${path}.duration`, v),
							min: Math.max(TIMELINE_MIN_CLIP_DURATION, durationMeta.min ?? 0),
							max: durationMeta.max,
							step: durationMeta.step,
						}
						: void 0,
				};
			};
			const renderer = mountControlRenderer(content, rendererProps());
			const rect = target.getBoundingClientRect();
			const position = () => {
				const p = getDropdownPosition({ getBoundingClientRect: () => rect }, document.body, {
					fixed: true,
					width: 280,
					maxHeight: window.innerHeight - 24,
					dropdownHeight: popup.scrollHeight + 2,
				});
				Object.assign(popup.style, {
					left: `${
						clamp2(
							rect.left + rect.width / 2 - p.width / 2,
							12,
							Math.max(12, window.innerWidth - p.width - 12),
						)
					}px`,
					top: `${p.top}px`,
					width: `${p.width}px`,
					maxHeight: `${p.maxHeight}px`,
				});
				popup.dataset.placement = p.above ? "above" : "below";
			};
			const observer2 = new ResizeObserver(position);
			observer2.observe(popup);
			window.addEventListener("resize", position);
			position();
			const outside = (event) => {
				if (!root.contains(event.target) && !event.target.closest(".dialkit-timeline-clip")) {
					closeEditor();
				}
			};
			const key = (event) => {
				if (event.key === "Escape" && !event.defaultPrevented) {
					event.preventDefault();
					closeEditor();
				}
			};
			document.addEventListener("pointerdown", outside);
			root.addEventListener("keydown", key);
			close.focus({ preventScroll: true });
			editor = {
				update() {
					root.dataset.theme = theme;
					renderer.update(rendererProps());
				},
				destroy() {
					observer2.disconnect();
					window.removeEventListener("resize", position);
					document.removeEventListener("pointerdown", outside);
					renderer.destroy();
					root.remove();
				},
			};
		}
		const stopValues = DialStore.subscribe(meta.id, render);
		const stopTransport = TimelineStore.subscribe(meta.id, transport);
		const observer = new ResizeObserver(render);
		observer.observe(ruler);
		render();
		return {
			update(next, nextTheme) {
				meta = next;
				theme = nextTheme;
				render();
			},
			closeEditor,
			destroy() {
				destroyed = true;
				gesture.destroy();
				clearTimeout(copyTimer);
				stopValues();
				stopTransport();
				observer.disconnect();
				closeEditor();
				presets.destroy();
				section.remove();
			},
		};
	}
	return __toCommonJS(vanilla_exports);
})();
// # sourceMappingURL=browser.global.js.map
