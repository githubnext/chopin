import { z } from "zod";

export const limits = {
	resultBytes: 1024 * 1024,
	report: 128 * 1024,
	rows: 4096,
	columns: 32,
	datasets: 8,
	views: 16,
	evidence: 8,
	text: 64 * 1024,
	brief: 8000,
	context: 256 * 1024,
} as const;

let key = z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
	.refine(value => !["constructor", "prototype", "__proto__"].includes(value));
let label = z.string().trim().min(1).max(200);
export const scalarSchema = z.union([
	z.string().max(2000),
	z.number().finite(),
	z.boolean(),
	z.null(),
]);
export type Scalar = z.infer<typeof scalarSchema>;
export const sourceSchema = z.object({
	repositoryId: z.string().min(1).max(200),
	repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(200),
	commit: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/),
	branch: z.string().min(1).max(255).optional(),
}).strict();
export type Source = z.infer<typeof sourceSchema>;

export const datasetSchema = z.object({
	key,
	title: label,
	columns: z.array(
		z.object({
			key,
			label,
			type: z.enum(["string", "number", "boolean", "timestamp"]),
			unit: z.string().max(40).optional(),
			nullable: z.boolean().optional(),
		}).strict(),
	).min(1).max(limits.columns),
	rows: z.array(
		z.object({
			key,
			values: z.record(key, scalarSchema),
		}).strict(),
	).max(limits.rows),
	method: z.string().max(4000),
	basis: z.enum(["observed", "derived", "simulated", "qualitative"]),
	sources: z.array(
		z.object({
			label,
			capturedAt: z.iso.datetime(),
			query: z.string().max(4000).optional(),
			url: z.url().max(2048).refine(value => new URL(value).protocol === "https:").optional(),
		}).strict(),
	).max(20),
}).strict();
export type Dataset = z.infer<typeof datasetSchema>;

export const viewSchema = z.object({
	key,
	title: label,
	kind: z.enum(["table", "metric-comparison", "bar-chart", "line-chart"]),
	datasetKey: key,
	categoryColumn: key.optional(),
	valueColumn: key.optional(),
	filterColumns: z.array(key).max(8),
}).strict();
export type View = z.infer<typeof viewSchema>;

export const resultSchema = z.object({
	schemaVersion: z.literal(1),
	report: z.string().trim().min(1).max(limits.report),
	datasets: z.array(datasetSchema).max(limits.datasets),
	views: z.array(viewSchema).max(limits.views),
	evidence: z.array(
		z.object({
			key,
			title: label,
			format: z.enum(["plain", "csv", "json", "diff"]),
			text: z.string().max(limits.text),
		}).strict(),
	).max(limits.evidence),
	provenance: z.object({
		environment: z.string().max(4000),
		checks: z.array(z.string().max(2000)).max(40),
		limitations: z.array(z.string().max(2000)).max(40),
	}).strict(),
}).strict();
export type Result = z.infer<typeof resultSchema>;

export class ExperimentError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "ExperimentError";
	}
}

export function canonical(value: unknown): string {
	return JSON.stringify(
		value,
		(_key, item) =>
			item && typeof item === "object" && !Array.isArray(item)
				? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]]))
				: item,
	);
}

export function parseResult(input: unknown): Result {
	let encoded: string;
	try {
		encoded = JSON.stringify(input);
	} catch {
		throw new ExperimentError("invalid-result", "Result must be JSON.");
	}
	if (!encoded || new TextEncoder().encode(encoded).length > limits.resultBytes) {
		throw new ExperimentError("invalid-result", "Result exceeds the byte limit.");
	}
	let parsed = resultSchema.safeParse(input);
	if (!parsed.success) throw new ExperimentError("invalid-result", parsed.error.message);
	let result = parsed.data;
	let unique = (values: string[], name: string) => {
		if (new Set(values).size !== values.length) {
			throw new ExperimentError("invalid-result", `Duplicate ${name}.`);
		}
	};
	unique(result.datasets.map(item => item.key), "dataset keys");
	unique(result.views.map(item => item.key), "view keys");
	unique(result.evidence.map(item => item.key), "evidence keys");
	for (let dataset of result.datasets) {
		unique(dataset.columns.map(item => item.key), "column keys");
		unique(dataset.rows.map(item => item.key), "row keys");
		for (let row of dataset.rows) {
			if (Object.keys(row.values).length !== dataset.columns.length) {
				throw new ExperimentError("invalid-result", `Row ${row.key} has unexpected columns.`);
			}
			for (let column of dataset.columns) {
				let value = row.values[column.key];
				let valid = value === null
					? column.nullable === true
					: column.type === "timestamp"
					? typeof value === "string" && z.iso.datetime().safeParse(value).success
					: typeof value === column.type;
				if (!Object.hasOwn(row.values, column.key) || !valid) {
					throw new ExperimentError("invalid-result", `Invalid ${column.key} in row ${row.key}.`);
				}
			}
		}
	}
	for (let view of result.views) {
		let dataset = result.datasets.find(item => item.key === view.datasetKey);
		if (!dataset) throw new ExperimentError("invalid-result", "View references a missing dataset.");
		unique(view.filterColumns, "filter columns");
		for (
			let column of [...view.filterColumns, ...(view.categoryColumn ? [view.categoryColumn] : [])]
		) {
			if (!dataset.columns.some(item => item.key === column)) {
				throw new ExperimentError("invalid-result", `Unknown view column ${column}.`);
			}
		}
		if (
			view.valueColumn
			&& !dataset.columns.some(item => item.key === view.valueColumn && item.type === "number")
		) {
			throw new ExperimentError("invalid-result", "A value column must be numeric.");
		}
		if (view.kind !== "table" && (!view.categoryColumn || !view.valueColumn)) {
			throw new ExperimentError(
				"invalid-result",
				"A chart or comparison needs category and value columns.",
			);
		}
		if (
			view.kind === "line-chart"
			&& !dataset.columns.some(item =>
				item.key === view.categoryColumn && (item.type === "timestamp" || item.type === "number")
			)
		) {
			throw new ExperimentError(
				"invalid-result",
				"A line chart needs an ordered numeric or timestamp axis.",
			);
		}
	}
	return result;
}

export const requestSchema = z.object({
	id: z.string().uuid(),
	documentId: z.string().uuid(),
	brief: z.string().min(1).max(limits.brief).refine(value => value.trim().length > 0),
	source: sourceSchema,
	context: z.string().max(limits.context),
	requester: z.string().min(1).max(200),
	authorizer: z.string().min(1).max(200),
}).strict();
export type RunInput = z.infer<typeof requestSchema>;

export type ViewState = {
	revision: number;
	fields: Record<string, { revision: number; values: Scalar[] }>;
};
export type SelectionPatch = {
	mutationId: string;
	expected: Record<string, number>;
	set: Record<string, Scalar[]>;
};

export function initialState(view: View): ViewState {
	return {
		revision: 0,
		fields: Object.fromEntries([...view.filterColumns.map(key => `filter:${key}`), "selection"]
			.map(key => [key, { revision: 0, values: [] }])),
	};
}

export function selectedRows(dataset: Dataset, state: ViewState): Dataset["rows"] {
	return dataset.rows.filter(row =>
		Object.entries(state.fields).every(([key, field]) =>
			!key.startsWith("filter:") || !field.values.length
			|| field.values.some(value => value === row.values[key.slice(7)])
		)
	);
}

export const capabilities = {
	version: 1,
	limits,
	resultSchema: z.toJSONSchema(resultSchema, { unrepresentable: "any" }),
	instructions:
		"Return captured evidence. Use observed, derived, simulated or qualitative accurately. "
		+ "All views reference typed dataset columns. Explain units, sampling, checks and limitations. "
		+ "Never include credentials. Submit only bounded data; no UI code or executable expressions.",
};
