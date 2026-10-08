export type SchemaIssue = { at: string; msg: string };

export function validate(
	schema: unknown,
	value: unknown,
	root?: unknown,
	path?: string,
	out?: SchemaIssue[],
): SchemaIssue[];
