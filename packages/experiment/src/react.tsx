import { Component, lazy, Suspense, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { barChartLoadingHeight, lineChartLoadingHeight } from "@chopin/diagrams/chart-frame";
import type { DiagramProps } from "@chopin/diagrams/react";
import "@chopin/diagrams/styles.css";
import { initialState, selectedRows } from "./index";
import type { Result, Scalar, View, ViewState } from "./index";

function text(value: Scalar | undefined) {
	return value === null || value === undefined ? "—" : String(value);
}

const DeferredDiagram = lazy(() =>
	import("@chopin/diagrams/react").then(({ Diagram }) => ({ default: Diagram }))
);

type BarData = ReadonlyArray<readonly [string, number]>;

function ChartPlaceholder(
	{ barData, unit, failed }: { barData?: BarData; unit: string; failed?: boolean },
) {
	let ref = useRef<HTMLDivElement>(null);
	let [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		let element = ref.current;
		if (!element) return;
		let measure = () => setWidth(element.clientWidth);
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	// This package is outside the web Tailwind scan; reserve inline dimensions.
	let height = barData && width > 0
		? barChartLoadingHeight(barData, unit, width)
		: lineChartLoadingHeight;
	return (
		<div
			ref={ref}
			role={failed ? undefined : "status"}
			className="flex flex-col items-center justify-center gap-2 text-sm text-text-secondary"
			style={{ minHeight: height }}
		>
			{failed
				? (
					<>
						<p role="alert" className="m-0">Chart could not load.</p>
						<button
							type="button"
							className="btn btn-sm btn-outline"
							onClick={() => location.reload()}
						>
							Reload page
						</button>
					</>
				)
				: "Loading chart…"}
		</div>
	);
}

class ChartBoundary extends Component<
	{ children: ReactNode; barData?: BarData; unit: string },
	{ failed: boolean }
> {
	override state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("[experiment] could not render chart:", error, info.componentStack);
	}

	override render(): ReactNode {
		if (this.state.failed) {
			return <ChartPlaceholder barData={this.props.barData} unit={this.props.unit} failed />;
		}
		return this.props.children;
	}
}

function Chart(
	{ spec, title, barData, unit }: Pick<DiagramProps, "spec" | "title"> & {
		barData?: BarData;
		unit: string;
	},
) {
	return (
		<ChartBoundary barData={barData} unit={unit}>
			<Suspense
				fallback={<ChartPlaceholder barData={barData} unit={unit} />}
			>
				<DeferredDiagram spec={spec} title={title} />
			</Suspense>
		</ChartBoundary>
	);
}

export function ExperimentView(
	{ result, view, state = initialState(view), onChange, disabled = false }: {
		result: Result;
		view: View;
		state?: ViewState;
		disabled?: boolean;
		onChange?: (field: string, values: Scalar[]) => void;
	},
) {
	let dataset = result.datasets.find(item => item.key === view.datasetKey)!;
	let rows = useMemo(() => selectedRows(dataset, state), [dataset, state]);
	let unit = dataset.columns.find(item => item.key === view.valueColumn)?.unit ?? "";
	let plotted = rows.filter(row => typeof row.values[view.valueColumn ?? ""] === "number").slice(
		0,
		40,
	);
	let barData: Array<[string, number]> = plotted.map(row => [
		text(row.values[view.categoryColumn!]),
		row.values[view.valueColumn!] as number,
	]);
	let spec = view.kind === "line-chart"
		? {
			type: "line",
			title: view.title,
			unit,
			x: plotted.map(row => text(row.values[view.categoryColumn!])),
			series: [{
				name: unit || view.title,
				values: plotted.map(row => row.values[view.valueColumn!]),
			}],
		}
		: {
			type: "bar",
			title: view.title,
			unit,
			data: barData,
		};
	return (
		<section aria-label={view.title} className="flex min-w-0 flex-col gap-3">
			<h3 className="m-0 text-sm font-semibold">{view.title}</h3>
			<p className="m-0 text-xs text-text-secondary">
				{dataset.basis} · {rows.length} observations · {dataset.method}
			</p>
			<div className="flex flex-wrap gap-3">
				{view.filterColumns.map(key => {
					let column = dataset.columns.find(item => item.key === key)!;
					let choices = [...new Set(dataset.rows.map(row => JSON.stringify(row.values[key])))];
					let chosen = state.fields[`filter:${key}`]?.values[0];
					return (
						<label key={key} className="flex flex-col gap-1 text-xs text-text-secondary">
							{column.label}
							<select
								aria-label={`Filter ${column.label}`}
								className="min-w-0 field px-2 py-1 text-sm font-normal text-text-primary"
								disabled={disabled || !onChange}
								value={chosen === undefined ? "all" : JSON.stringify(chosen)}
								onChange={event =>
									onChange?.(
										`filter:${key}`,
										event.target.value === "all" ? [] : [JSON.parse(event.target.value)],
									)}
							>
								<option value="all">All</option>
								{choices.map(value => (
									<option key={value} value={value}>{text(JSON.parse(value))}</option>
								))}
							</select>
						</label>
					);
				})}
			</div>
			{(view.kind === "bar-chart" || view.kind === "line-chart") && plotted.length > 0 && (
				<Chart
					spec={spec}
					title={view.title}
					barData={view.kind === "bar-chart" ? barData : undefined}
					unit={unit}
				/>
			)}
			{rows.length > 40 && (view.kind === "bar-chart" || view.kind === "line-chart") && (
				<p className="text-xs text-text-secondary">
					Chart shows the first 40 numeric observations. The table contains all matching rows.
				</p>
			)}
			<div className="max-h-96 max-w-full overflow-auto">
				<table className="w-full text-left text-sm">
					<caption className="sr-only">{dataset.title}</caption>
					<thead>
						<tr>
							<th className="p-2">Choice</th>
							{dataset.columns.map(column => (
								<th key={column.key} className="p-2">
									{column.label}
									{column.unit ? ` (${column.unit})` : ""}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map(row => (
							<tr key={row.key}>
								<td className="p-2">
									<button
										type="button"
										className="btn btn-sm btn-ghost"
										disabled={disabled || !onChange}
										aria-label={`Select ${
											text(row.values[view.categoryColumn ?? dataset.columns[0].key])
										}`}
										aria-pressed={state.fields.selection?.values.includes(row.key) ?? false}
										onClick={() => onChange?.("selection", [row.key])}
									>
										{state.fields.selection?.values.includes(row.key) ? "Selected" : "Select"}
									</button>
								</td>
								{dataset.columns.map(column => (
									<td key={column.key} className="p-2">{text(row.values[column.key])}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
				{rows.length === 0 && <p role="status" className="text-sm">No matching observations.</p>}
			</div>
		</section>
	);
}
