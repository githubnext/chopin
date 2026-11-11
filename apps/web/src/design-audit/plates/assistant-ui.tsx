import { GlobeIcon, SparklesIcon, XIcon } from "lucide-react";
import { useState } from "react";

import {
	ComposerCommandItem,
	ComposerMenu,
	ComposerPersonItem,
} from "@/components/assistant-ui/elements/composer";
import { createDirectiveText } from "@/components/assistant-ui/elements/directive-text";
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

const MENTION = {
	parse: () => [{ kind: "mention" as const, type: "agent", label: "Chopin", id: "chopin" }],
};
/** The chip as Directive text draws it for a mention, and with the control the patch lets it hold. */
const MentionChip = createDirectiveText(MENTION, { iconMap: { agent: SparklesIcon } });
const RemovableChip = createDirectiveText(MENTION, {
	iconMap: { agent: SparklesIcon },
	trailing: () => <XIcon />,
});

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
				<div>
					<StateLabel>Mentions menu</StateLabel>
					<div className="design-audit-aui-menu">
						<ComposerMenu open>
							<ComposerPersonItem active person={{ name: "Chopin", role: "agent" }} />
							{/* The avatar slot the patch adds, drawn here as a plain node. */}
							<ComposerPersonItem
								active={false}
								person={{ name: "ana", role: "human", avatar: <span aria-hidden="true">A</span> }}
							/>
							<ComposerPersonItem active={false} person={{ name: "Overview", role: "H1" }} />
						</ComposerMenu>
					</div>
				</div>
				<div>
					<StateLabel>Slash commands menu</StateLabel>
					<div className="design-audit-aui-menu">
						<ComposerMenu open>
							<ComposerCommandItem
								active
								command={{
									name: "research",
									description: "Search the web for this document",
									icon: GlobeIcon,
								}}
							/>
							<ComposerCommandItem
								active={false}
								command={{ name: "skill:notes", description: "Draft notes", icon: SparklesIcon }}
							/>
						</ComposerMenu>
					</div>
				</div>
				<div>
					<StateLabel>Mention chip, and with a trailing control</StateLabel>
					<div className="design-audit-aui-chips">
						<MentionChip text=":agent[Chopin]" />
						<RemovableChip text=":agent[Chopin]" />
					</div>
				</div>
			</div>
		</AuditPlate>
	);
}
