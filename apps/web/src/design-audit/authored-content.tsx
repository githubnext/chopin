import { ResearchCard, ResearchComposer } from "@chopin/editor";
import { StaticPlanEditor } from "@chopin/editor/static";

import { AuditPlate, StateLabel } from "./frame";

import type { Research } from "@chopin/protocol";

let callouts = [
	'<Callout id="01K0N4W3B7P27CBAEC7A8C8WEA" type="note" title="Note">',
	"",
	"A neutral detail that supports the surrounding prose.",
	"",
	"</Callout>",
	"",
	'<Callout id="01K0N4W3B7P27CBAEC7A8C8WEB" type="tip" title="Tip">',
	"",
	"A useful shortcut or recommended next step.",
	"",
	"</Callout>",
	"",
	'<Callout id="01K0N4W3B7P27CBAEC7A8C8WEC" type="warning" title="Warning">',
	"",
	"A condition that needs attention before continuing.",
	"",
	"</Callout>",
	"",
	'<Callout id="01K0N4W3B7P27CBAEC7A8C8WED" type="danger" title="Danger">',
	"",
	"An action with serious or irreversible consequences.",
	"",
	"</Callout>",
].join("\n") + "\n";

let code = [
	"```",
	"Plain text keeps its authored appearance.",
	"```",
	"",
	'```typescript title="tokens.ts"',
	"export const spacing = { compact: 8, comfortable: 12 };",
	"```",
	"",
	"```css collapsed",
	".button { padding-inline: var(--space-3); }",
	"```",
].join("\n") + "\n";

let diff = [
	"```diff",
	"--- a/button.css",
	"+++ b/button.css",
	"@@ -1 +1 @@",
	"-padding-inline: 8px;",
	"+padding-inline: 12px;",
	"```",
	"",
	"```diff",
	"This is temporarily invalid patch content.",
	"```",
].join("\n") + "\n";

let diagram = [
	"```mermaid",
	"flowchart LR",
	"  Tokens --> Controls",
	"  Controls --> Surfaces",
	"  Surfaces --> Documents",
	"```",
	"",
	"```mermaid",
	"this is not a valid diagram",
	"```",
].join("\n") + "\n";

let formula = [
	"Inline spacing can be described as $s_n = 4n$ pixels.",
	"",
	"$$",
	"c = \\sqrt{a^2 + b^2}",
	"$$",
].join("\n") + "\n";

let images = [
	"![Loaded image](https://avatars.githubusercontent.com/u/9919?s=160&v=4)",
	"",
	"![Unavailable image](https://invalid.example.invalid/design-audit.png)",
	"",
	"![](https://avatars.githubusercontent.com/u/9919?s=80&v=4)",
].join("\n") + "\n";

let table = [
	"| Component | Default | Active |",
	"| :-- | :-- | :-- |",
	"| Button | Secondary | Brand |",
	"| Icon | 16px tertiary | 16px brand |",
	"| Row | Page | Selected wash |",
].join("\n") + "\n";

let timestamp = "2026-08-28T10:00:00.000Z";

function request(
	stage: Research.RequestStage,
): Research.RequestView {
	let base: Research.RequestViewBase = {
		channelId: "audit-channel",
		createdAt: timestamp,
		id: `audit-research-${stage}`,
		question: "Which interaction patterns should the design system standardize?",
		sources: [],
		updatedAt: timestamp,
	};
	if (stage === "failed") {
		return { ...base, error: "The source search timed out.", stage, state: "failed" };
	}
	if (stage === "cancelled") return { ...base, stage, state: "cancelled" };
	if (stage === "ready") {
		return {
			...base,
			child: {
				id: "audit-research-child",
				slug: "design-system-patterns",
				sourceCount: 8,
				summary: "A comparison of durable interaction patterns.",
				title: "Design system interaction patterns",
			},
			stage,
			state: "completed",
		};
	}
	return { ...base, stage, state: stage === "queued" ? "pending" : "running" };
}

function EditorPlate(
	{ description, item, source, title }: {
		description: string;
		item: string;
		source: string;
		title: string;
	},
) {
	return (
		<AuditPlate description={description} item={item} title={title}>
			<StaticPlanEditor source={source} />
		</AuditPlate>
	);
}

function ResearchSpecimens() {
	let stages: Research.RequestStage[] = [
		"queued",
		"searching",
		"writing",
		"failed",
		"cancelled",
		"ready",
	];
	return (
		<AuditPlate
			description="Question entry and every durable request lifecycle state."
			item="research"
			title="Research"
		>
			<div className="design-audit-research-composer">
				<StateLabel>Question</StateLabel>
				<ResearchComposer
					onCancel={() => {}}
					onChange={() => {}}
					onSubmit={() => {}}
					question="Where does the current interface drift from its shared tokens?"
				/>
			</div>
			<div className="design-audit-research-grid">
				{stages.map(stage => (
					<div key={stage}>
						<StateLabel>{stage}</StateLabel>
						<ResearchCard
							onCancel={() => {}}
							onOpen={() => {}}
							onRemove={() => {}}
							onRetry={() => {}}
							request={request(stage)}
						/>
					</div>
				))}
			</div>
		</AuditPlate>
	);
}

export function AuthoredContent() {
	return (
		<>
			<EditorPlate
				description="Note, tip, warning, and danger treatments from the real callout renderer."
				item="callouts"
				source={callouts}
				title="Callouts"
			/>
			<ResearchSpecimens />
			<EditorPlate
				description="Plain, named, and collapsed fences with derived syntax previews."
				item="code"
				source={code}
				title="Code blocks"
			/>
			<EditorPlate
				description="Valid patch rendering and the invalid-source fallback."
				item="diff"
				source={diff}
				title="Diff blocks"
			/>
			<EditorPlate
				description="Rendered Mermaid output beside a deliberately invalid source."
				item="diagram"
				source={diagram}
				title="Diagrams"
			/>
			<EditorPlate
				description="Inline and block formulae rendered through KaTeX."
				item="formula"
				source={formula}
				title="Formulae"
			/>
			<EditorPlate
				description="Loaded, unavailable, and deliberately empty-alt image states."
				item="image"
				source={images}
				title="Images"
			/>
			<EditorPlate
				description="The editor table, with alignment and overflow behavior visible."
				item="table"
				source={table}
				title="Tables"
			/>
		</>
	);
}
