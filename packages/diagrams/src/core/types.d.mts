export type DiagramTypeInfo = {
	name: string;
	family: string;
	schema?: string;
	defaultMotion?: string;
	renderer: {
		render(spec: unknown, options: unknown): unknown;
	};
};

export const TYPES: Record<string, DiagramTypeInfo>;
export const ALIASES: Record<string, [string, string?, Record<string, unknown>?]>;
