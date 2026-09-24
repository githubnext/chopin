import type { ComponentProps } from "react";

import { semanticClasses } from "./semantic-tone";
import type { SemanticTone } from "./semantic-tone";

export type MiniBarsProps = Omit<ComponentProps<"svg">, "children" | "values"> & {
	label: string;
	tone?: SemanticTone;
	values: readonly number[];
};

const Svg = "svg";

export function MiniBars({
	className,
	label,
	tone = "neutral",
	values,
	...props
}: MiniBarsProps) {
	let visibleValues = values.filter(Number.isFinite).slice(-5);
	let maximum = Math.max(...visibleValues.map(value => Math.max(value, 0)), 0) || 1;
	let gap = visibleValues.length > 1 ? 2 : 0;
	let barWidth = visibleValues.length === 0
		? 0
		: (64 - gap * (visibleValues.length - 1)) / visibleValues.length;
	return (
		<Svg
			{...props}
			aria-label={label}
			className={semanticClasses("cv-mini-bars", className)}
			data-slot="mini-bars"
			data-tone={tone}
			preserveAspectRatio="none"
			role="img"
			viewBox="0 0 64 24"
		>
			{visibleValues.map((value, index) => {
				let height = Math.max(value, 0) / maximum * 20;
				let x = index * (barWidth + gap);
				let width = index === visibleValues.length - 1 ? 64 - x : barWidth;
				return (
					<rect
						height={height}
						key={`${index}-${value}`}
						rx="2"
						width={width}
						x={x}
						y={22 - height}
					/>
				);
			})}
		</Svg>
	);
}
