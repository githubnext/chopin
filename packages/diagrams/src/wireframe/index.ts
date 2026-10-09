export {
	describeWireframePart,
	describeWireframeProblem,
	wireframeCallouts,
	wireframeLabel,
	wireframeName,
} from "./outline";
export type { WireframeCallout } from "./outline";
export { parseWireframe, resolveWireframeTarget } from "./parse";
export { printWireframe } from "./print";
export {
	isWireframeKind,
	MAX_WIREFRAME_DEPTH,
	MAX_WIREFRAME_ID,
	MAX_WIREFRAME_LABEL,
	MAX_WIREFRAME_NODES,
	MAX_WIREFRAME_PROBLEMS,
	MAX_WIREFRAME_SOURCE_BYTES,
	WIREFRAME_KINDS,
} from "./schema";
export type {
	Wireframe,
	WireframeItem,
	WireframeKind,
	WireframeKindSpec,
	WireframeNode,
	WireframeProblem,
	WireframeResult,
	WireframeSpan,
	WireframeValue,
} from "./schema";
