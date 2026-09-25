import { maxChroma } from "@chopin/color";

import type { Oklch } from "@chopin/color";

export type ChromaGraphProps = { values: readonly Oklch[]; steps?: readonly string[] };
const Svg = "svg";

export function ChromaGraph({ values, steps }: ChromaGraphProps) {
	if (values.length < 2) return null;
	let maxima = values.map(value => maxChroma(value.l, value.h));
	let top = Math.max(0.01, ...maxima, ...values.map(value => value.c));
	let path = (numbers: readonly number[]) =>
		numbers.map((number, index) => {
			let x = (index / (numbers.length - 1)) * 232 + 4;
			let y = 80 - (number / top) * 72;
			return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
		}).join(" ");
	return (
		<div className="cv-chroma">
			<div aria-hidden="true" className="cv-chroma-legend">
				<span>Chroma</span>
				<span>
					<i className="cv-chroma-current-key" /> Current
				</span>
				<span>
					<i className="cv-chroma-max-key" /> Max
				</span>
			</div>
			<Svg aria-label={`Chroma across ${values.length} steps`} role="img" viewBox="0 0 240 88">
				<path className="cv-chroma-max" d={path(maxima)} strokeDasharray="4 4" />
				<path className="cv-chroma-current" d={path(values.map(value => value.c))} />
				{values.map((_, index) => (
					<text key={index} textAnchor="middle" x={(index / (values.length - 1)) * 232 + 4} y="87">
						{steps?.[index] ?? index + 1}
					</text>
				))}
			</Svg>
		</div>
	);
}
