import { fittedBarLayout, nativeBarLayout } from "./core/render/charts/fitted-bar-layout.mjs";
import { niceDomain } from "./core/render/charts/scale.mjs";

// The single-series line viewBox is 248px fitted or 316px native. The viewer
// controls add 40px, so this midpoint limits either shift to 34px.
export const lineChartLoadingHeight = 322;

/** Height of a single-series bar chart while its drawing module loads. */
export function barChartLoadingHeight(data, unit, width) {
	const values = data.map(([, value]) => value);
	const details = {
		spec: {},
		cats: data.map(([label]) => label),
		series: [{ values }],
		dom: niceDomain(Math.min(...values), Math.max(...values)),
		unit,
		width,
	};
	const native = nativeBarLayout(details);
	if (native.width <= width) return native.height + 40;
	const layout = fittedBarLayout(details);
	// The SVG viewBox has an 8px bottom margin; the viewer's controls occupy 40px.
	return layout.height + 8 + 40;
}
