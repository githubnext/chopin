import { useMemo } from "react";
import { Diagram } from "@chopin/diagrams/react";
import "@chopin/diagrams/styles.css";
import { initialState, selectedRows } from "./index";
import type { Result, Scalar, View, ViewState } from "./index";

function text(value: Scalar | undefined) {
	return value === null || value === undefined ? "—" : String(value);
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
			data: plotted.map(
				row => [text(row.values[view.categoryColumn!]), row.values[view.valueColumn!]],
			),
		};
	return (
		<section aria-label={view.title} className="flex min-w-0 flex-col gap-3">
			<h3 className="text-base font-semibold">{view.title}</h3>
			<p className="text-xs text-text-secondary">
				{dataset.basis} · {rows.length} observations · {dataset.method}
			</p>
			<div className="flex flex-wrap gap-3">
				{view.filterColumns.map(key => {
					let column = dataset.columns.find(item => item.key === key)!;
					let choices = [...new Set(dataset.rows.map(row => JSON.stringify(row.values[key])))];
					let chosen = state.fields[`filter:${key}`]?.values[0];
					return (
						<label key={key} className="flex flex-col gap-1 text-sm">
							{column.label}
							<select
								aria-label={`Filter ${column.label}`}
								className="rounded-md border p-2"
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
				<Diagram spec={spec} title={view.title} />
			)}
			{rows.length > 40 && (view.kind === "bar-chart" || view.kind === "line-chart") && (
				<p className="text-xs text-text-secondary">
					Chart shows the first 40 numeric observations. The table contains all matching rows.
				</p>
			)}
			<div className="max-h-96 overflow-auto">
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
