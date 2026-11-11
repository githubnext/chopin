import { useState } from "react";

import {
	Composer,
	ComposerActions,
	ComposerAttachButton,
	ComposerBar,
	ComposerInput,
	ComposerModelTrigger,
	ComposerToolbar,
	ComposerVoiceButton,
} from "@/components/assistant-ui/elements/composer";
import {
	ModelSelectorContent,
	ModelSelectorRoot,
	ModelSelectorTrigger,
} from "@/components/assistant-ui/elements/model-selector";
import { modelOptions } from "../../chat/assistant-ui/model-options";
import { sendStop } from "../../chat/assistant-ui/send-stop";
import { SendStopButton } from "../../chat/assistant-ui/send-stop-button";
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

const NOTHING = { running: false, hasDraft: false, canSend: false, canStop: true };

/** The round button in each state Chat draws it in, by what Chat tells `sendStop`. */
const SEND_STOP = [
	{ label: "Send, nothing to send", input: NOTHING },
	{ label: "Send, a draft", input: { ...NOTHING, hasDraft: true, canSend: true } },
	{ label: "Stop, the Planner runs", input: { ...NOTHING, running: true } },
	{ label: "Send, may not stop", input: { ...NOTHING, running: true, canStop: false } },
	{
		label: "Send, queues a draft",
		input: { ...NOTHING, running: true, hasDraft: true, canSend: true },
	},
] as const;

const noop = () => {};

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
			description="Copied registry source, unmodified, with assistant-ui's own sizes and Chopin's colours: the model selector, and the composer's box, toolbar and round send and stop button."
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
			<div className="design-audit-aui">
				{SEND_STOP.map(({ label, input }) => (
					<div key={label}>
						<StateLabel>{label}</StateLabel>
						<SendStopButton
							busy={false}
							hasDraft={input.hasDraft}
							onClick={noop}
							state={sendStop(input)}
						/>
					</div>
				))}
			</div>
			<div className="design-audit-aui-shell">
				<StateLabel>The composer, as the element draws it</StateLabel>
				<Composer>
					<ComposerBar>
						<ComposerInput onChange={noop} placeholder="Ask anything" value="" />
						<ComposerToolbar>
							<ComposerActions>
								<ComposerAttachButton onClick={noop} />
								<ComposerModelTrigger model="Fable 5.1" onClick={noop} open={false} />
							</ComposerActions>
							<ComposerActions>
								<ComposerVoiceButton active={false} onClick={noop} />
								<SendStopButton
									busy={false}
									hasDraft={false}
									onClick={noop}
									state={sendStop(NOTHING)}
								/>
							</ComposerActions>
						</ComposerToolbar>
					</ComposerBar>
				</Composer>
			</div>
		</AuditPlate>
	);
}
