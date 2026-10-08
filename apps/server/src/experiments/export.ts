import type { Dataset, Scalar } from "@chopin/experiment";

export function datasetCsv(dataset: Dataset): string {
	let cell = (value: Scalar) => {
		let text = value === null ? "" : String(value);
		if (typeof value === "string" && /^[=+@\-\t\r]/.test(text)) text = `'${text}`;
		return `"${text.replaceAll('"', '""')}"`;
	};
	return [
		dataset.columns.map(column => cell(column.label)).join(","),
		...dataset.rows.map(row =>
			dataset.columns.map(column => cell(row.values[column.key])).join(",")
		),
	]
		.join("\r\n");
}
