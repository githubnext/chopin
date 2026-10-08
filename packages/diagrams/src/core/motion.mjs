// Motion: renderers tag elements with data-sc-step="N" (1..MAX_STEPS) and a
// motion role class; this stylesheet turns those into CSS animations.
// Rules: CSS only, no layout changes, reduced-motion / print / .sc-still all
// show the settled end frame, and the whole reveal fits in ~6.5s.

export const MAX_STEPS = 12;
export const PRESETS = ["none", "reveal", "trace", "step", "loop"];

// Family defaults for motion:"auto".
export const FAMILY_DEFAULT = {
	graph: "trace",
	lanes: "trace",
	structure: "reveal",
	chart: "reveal",
};

export function resolvePreset(motion, family) {
	if (!motion || motion === "auto") return FAMILY_DEFAULT[family] || "reveal";
	return motion;
}

// Map arbitrary depths (0..n) onto 1..MAX_STEPS preserving order.
export function compressSteps(depths) {
	const uniq = [...new Set(depths)].sort((a, b) => a - b);
	const n = uniq.length;
	const map = new Map();
	uniq.forEach((d, i) => {
		map.set(d, n <= MAX_STEPS ? i + 1 : 1 + Math.round((i * (MAX_STEPS - 1)) / (n - 1)));
	});
	return depths.map((d) => map.get(d));
}

// Timing: stagger shrinks with more steps so the reveal stays short.
export function timing(preset, steps) {
	const s = Math.max(1, steps);
	const stagger = preset === "step"
		? Math.min(700, Math.round(6000 / s))
		: Math.min(420, Math.round(5200 / s));
	return { stagger, enter: preset === "step" ? 420 : 520, draw: Math.min(640, stagger + 200) };
}

export function motionVars(preset, steps) {
	const t = timing(preset, steps);
	return `--sc-stagger:${t.stagger}ms;--sc-enter:${t.enter}ms;--sc-draw:${t.draw}ms;--sc-settle:${
		(steps + 1) * t.stagger + t.draw
	}ms`;
}

export const MOTION_CSS = `
@keyframes sc-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes sc-fade{from{opacity:0}to{opacity:1}}
@keyframes sc-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes sc-grow-y{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes sc-grow-x{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes sc-wipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
@keyframes sc-wipe-down{from{clip-path:inset(0 0 100% 0)}to{clip-path:inset(0 0 0 0)}}
@keyframes sc-pop{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:scale(1)}}
@keyframes sc-token{from{offset-distance:0%;opacity:0}8%{opacity:1}92%{opacity:1}to{offset-distance:100%;opacity:0}}
@keyframes sc-pulse{0%,100%{stroke-opacity:1}50%{stroke-opacity:.35}}
.e-token{display:none}
@media (prefers-reduced-motion: no-preference){
.sc-svg[data-sc-motion]:not(.sc-still) [data-sc-step]{--d:calc(var(--step) * var(--sc-stagger))}
.sc-svg[data-sc-motion]:not(.sc-still) .sc-node[data-sc-step],
.sc-svg[data-sc-motion]:not(.sc-still) .sc-enter[data-sc-step]{animation:sc-in var(--sc-enter) cubic-bezier(.2,.7,.2,1) var(--d) both}
.sc-svg[data-sc-motion]:not(.sc-still) .sc-edge[data-sc-step]{animation:sc-fade 240ms ease-out var(--d) both}
.sc-svg[data-sc-motion]:not(.sc-still) .sc-edge[data-sc-step] .e-head,
.sc-svg[data-sc-motion]:not(.sc-still) .sc-edge[data-sc-step] .e-glyph,
.sc-svg[data-sc-motion]:not(.sc-still) .sc-edge[data-sc-step] .e-label-g{animation:sc-fade 200ms ease-out calc(var(--d) + var(--sc-draw) * .8) both}
.sc-svg:is([data-sc-motion="trace"],[data-sc-motion="loop"]):not(.sc-still) .sc-edge[data-sc-step] .e-line.sc-draw{stroke-dasharray:1;animation:sc-draw var(--sc-draw) cubic-bezier(.4,0,.2,1) var(--d) both}
.sc-svg[data-sc-motion]:not(.sc-still) .sc-grow-y[data-sc-step]{transform-box:fill-box;transform-origin:50% 100%;animation:sc-grow-y var(--sc-enter) cubic-bezier(.2,.7,.2,1) var(--d) both}
.sc-svg[data-sc-motion]:not(.sc-still) .sc-grow-x[data-sc-step]{transform-box:fill-box;transform-origin:0 50%;animation:sc-grow-x var(--sc-enter) cubic-bezier(.2,.7,.2,1) var(--d) both}
.sc-svg[data-sc-motion]:not(.sc-still) .sc-wipe[data-sc-step]{animation:sc-wipe var(--sc-draw) cubic-bezier(.4,0,.2,1) var(--d) both}
.sc-svg[data-sc-motion]:not(.sc-still) .sc-wipe-down[data-sc-step]{animation:sc-wipe-down var(--sc-draw) cubic-bezier(.4,0,.2,1) var(--d) both}
.sc-svg[data-sc-motion]:not(.sc-still) .sc-pop[data-sc-step]{transform-box:fill-box;transform-origin:50% 50%;animation:sc-pop var(--sc-enter) cubic-bezier(.2,.9,.3,1.2) var(--d) both}
.sc-svg[data-sc-motion]:not(.sc-still) .sc-fade[data-sc-step]{animation:sc-fade var(--sc-enter) ease-out var(--d) both}
.sc-svg:is([data-sc-motion="trace"],[data-sc-motion="loop"]):not(.sc-still) .e-token{display:inline;offset-rotate:0deg;animation:sc-token var(--tok-dur,1800ms) linear calc(var(--sc-settle) + var(--tok-delay,0ms)) infinite both}
.sc-svg[data-sc-motion]:not(.sc-still) .k-change .n-box{animation:sc-pulse 1.6s ease-in-out var(--sc-settle) 3}
}
@media print{.sc-svg *{animation:none!important}.e-token{display:none!important}}
.sc-still .e-token{display:none}
.e-token{fill:var(--sc-accent)}
.ek-link .e-token,.e-token.t-link{fill:var(--sc-link)}
`;
