import type { ComponentProps } from "react";

import { semanticClasses } from "./semantic-tone";
import type { SemanticTone } from "./semantic-tone";

export type SparklineProps = Omit<ComponentProps<"svg">, "children" | "values"> & {
	label: string;
	tone?: SemanticTone;
	values: readonly number[];
};

type Point = { x: number; y: number };
const Svg = "svg";

function linePoints(values: readonly number[]): Point[] {
	let minimum = Infinity;
	let maximum = -Infinity;
	for (let value of values) {
		if (value < minimum) minimum = value;
		if (value > maximum) maximum = value;
	}
	let scale = Math.max(Math.abs(minimum), Math.abs(maximum), 1);
	let normalizedMinimum = minimum / scale;
	let span = maximum / scale - normalizedMinimum;
	let indexes: number[];
	if (values.length <= 144) {
		indexes = values.map((_, index) => index);
	} else {
		// Two extrema per viewBox column retain narrow peaks without an unbounded SVG path.
		indexes = [0];
		for (let bucket = 0; bucket < 72; bucket++) {
			let start = Math.floor(bucket * values.length / 72);
			let end = Math.floor((bucket + 1) * values.length / 72);
			let low = start;
			let high = start;
			for (let index = start + 1; index < end; index++) {
				if (values[index]! < values[low]!) low = index;
				if (values[index]! > values[high]!) high = index;
			}
			for (let index of low < high ? [low, high] : [high, low]) {
				if (index !== indexes.at(-1)) indexes.push(index);
			}
		}
		if (indexes.at(-1) !== values.length - 1) indexes.push(values.length - 1);
	}
	return indexes.map(index => ({
		x: index * (72 / (values.length - 1)),
		y: 30 - (values[index]! / scale - normalizedMinimum) / span * 28,
	}));
}

function towards(from: Point, to: Point, distance: number): Point {
	let length = Math.hypot(to.x - from.x, to.y - from.y);
	let ratio = Math.min(distance, length / 2) / length;
	return {
		x: from.x + (to.x - from.x) * ratio,
		y: from.y + (to.y - from.y) * ratio,
	};
}

function coordinate(value: number): string {
	return String(Number(value.toFixed(3)));
}

function roundedPath(values: readonly number[]): string {
	if (values.every(value => value === values[0])) return "M 0 16 L 72 16";

	let points = linePoints(values);
	let commands = [`M ${coordinate(points[0]!.x)} ${coordinate(points[0]!.y)}`];
	for (let index = 1; index < points.length - 1; index++) {
		let previous = points[index - 1]!;
		let point = points[index]!;
		let next = points[index + 1]!;
		let before = towards(point, previous, 2);
		let after = towards(point, next, 2);
		commands.push(
			`L ${coordinate(before.x)} ${coordinate(before.y)}`,
			`Q ${coordinate(point.x)} ${coordinate(point.y)} ${coordinate(after.x)} ${
				coordinate(after.y)
			}`,
		);
	}
	let last = points.at(-1)!;
	commands.push(`L ${coordinate(last.x)} ${coordinate(last.y)}`);
	return commands.join(" ");
}

export function Sparkline({
	className,
	label,
	tone = "neutral",
	values,
	...props
}: SparklineProps) {
	let finiteValues = values.filter(Number.isFinite);

	return (
		<Svg
			{...props}
			aria-label={label}
			className={semanticClasses("cv-sparkline", className)}
			data-slot="sparkline"
			data-tone={tone}
			preserveAspectRatio="none"
			role="img"
			viewBox="0 0 72 32"
		>
			{finiteValues.length === 1 ? <circle cx="36" cy="16" r="1.5" /> : null}
			{finiteValues.length > 1 ? <path d={roundedPath(finiteValues)} /> : null}
		</Svg>
	);
}
