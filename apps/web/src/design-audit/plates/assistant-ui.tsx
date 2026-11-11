import { useState } from "react";

import {
	ModelSelectorContent,
	ModelSelectorRoot,
	ModelSelectorTrigger,
} from "@/components/assistant-ui/elements/model-selector";
import { modelOptions } from "../../chat/assistant-ui/model-options";
import { AuditPlate, StateLabel } from "../frame";

import type { Chat } from "@chopin/protocol";

/** The shape of what a document's agent reports, which is all the element is given. */
const CATALOG: Chat.ModelCatalog = {
	models: [
		{
			id: "gpt-5",
			name: "GPT-5",
			description: "Strongest reasoning",
			thinkingLevels: ["low", "medium", "high"],
		},
		{
			id: "claude-sonnet-4",
			name: "Claude Sonnet 4",
			description: "Careful writing",
			thinkingLevels: ["low", "high"],
		},
		{ id: "gpt-5-mini", name: "GPT-5 mini", description: "Quick drafts" },
	],
};

const SPECIMENS = [
	{ label: "Outline, default", variant: "outline", size: "default" },
	{ label: "Outline, small", variant: "outline", size: "sm" },
	{ label: "Outline, large", variant: "outline", size: "lg" },
	{ label: "Ghost", variant: "ghost", size: "default" },
	{ label: "Muted", variant: "muted", size: "default" },
] as const;

/**
 * Copied assistant-ui elements, drawn as assistant-ui draws them: the model selector from the
 * registry, unmodified, driven by Chopin's own catalogue through props. `e2e/design` measures it.
 */
export function AssistantUiPlate() {
	let models = modelOptions(CATALOG);
	let [model, setModel] = useState("gpt-5");
	let [effort, setEffort] = useState("medium");
	return (
		<AuditPlate
			description="Copied registry source, unmodified, with assistant-ui's own sizes and Chopin's colours."
			item="assistant-ui"
			title="assistant-ui elements"
		>
			<div className="design-audit-aui">
				{SPECIMENS.map(({ label, variant, size }) => (
					<div key={label}>
						<StateLabel>{label}</StateLabel>
						<ModelSelectorRoot
							effort={effort}
							models={models}
							onEffortChange={setEffort}
							onValueChange={setModel}
							value={model}
						>
							<ModelSelectorTrigger size={size} variant={variant} />
							<ModelSelectorContent searchable />
						</ModelSelectorRoot>
					</div>
				))}
			</div>
		</AuditPlate>
	);
}
