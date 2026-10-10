import type { PreviewDefinition } from "../../skills/building-app-previews/assets/controls";
export let definition: PreviewDefinition = {
	controls: [
		{ type: "number", id: "spacing", label: "Spacing", unit: "px", min: 12, max: 40, step: 1 },
		{ type: "color", id: "accent", label: "Accent" },
	],
	baseline: { spacing: 24, accent: "#476b55" },
};
