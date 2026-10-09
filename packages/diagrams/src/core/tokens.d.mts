type DiagramTextRole = "label" | "sub" | "tag" | "edge";
type DiagramTextProperty =
	| "font-size"
	| "line-height"
	| "font-weight"
	| "font-family"
	| "tracking"
	| "text-transform";

export const diagramTypographyVariables: Readonly<
	Record<`--diagram-${DiagramTextRole}-${DiagramTextProperty}`, string>
>;
