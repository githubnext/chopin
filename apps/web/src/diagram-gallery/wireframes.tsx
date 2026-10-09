import { parseWireframe } from "@chopin/diagrams/wireframe";
import { Wireframe } from "@chopin/diagrams/wireframe/view";
import { StaticPlanEditor } from "@chopin/editor/static";

const IMPLEMENTATION_WIREFRAME = `panel "Implementation"
  header
    button "Approve and build this plan" primary
  text "Build on Laptop · 4f2a9c01" muted
  disclosure "0 of 2 tasks complete" open
    card
      badge "queued"
      title "Parse wireframe fences"
      text "Bounded parser in packages/diagrams."
      list
        - Unknown kinds report a line number`;

const TASK_GRAPH = `panel "Tasks"
  row flow
    card
      badge "done" tone=success
      title "Parse fences"
      text "Bounded DSL parser" muted
    stack
      card
        badge "in progress" tone=warning
        title "Editor preview"
        text "Lazy view, light and dark" muted
      card
        badge "ready"
        title "Server validation"
        text "Reject new invalid fences" muted
    card #prompt
      badge "blocked" tone=danger
      title "Planner prompt"
      text "Teach the DSL" muted
  note "Waits on server validation" -> #prompt`;

const SETTINGS = `panel "Repository settings"
  row
    nav vertical active=1
      - General
      - Members
      - Planner
      - Danger zone
    stack
      tabs active=1
        - Profile
        - Access
        - Webhooks
      input "Repository name" value="chopin"
      input #search placeholder="Search members"
      divider
      row
        image "Social preview" #preview
        stack
          title "Social preview"
          text "Shown when a document is shared. Uses the README image if none is set." muted
          row
            button "Upload"
            button "Remove"
      divider
      header
        button "Cancel"
        button "Save changes" primary
  note "Replaces the free-text member field" -> #search
  note "Optional; falls back to the README" -> #preview`;

const INVALID = `panel "Implementation"
  header
    buton "Approve and build this plan" primary
  text "Build on Laptop · 4f2a9c01" muted`;

const SAMPLES = [
	["implementation", "Implementation panel", IMPLEMENTATION_WIREFRAME],
	["tasks", "Task graph", TASK_GRAPH],
	["settings", "Settings layout", SETTINGS],
] as const;

const DOCUMENT = `## Implementation

The panel keeps approval at the top so the build step is the first thing a reviewer sees. Tasks fold away once the run starts.

\`\`\`wireframe
${IMPLEMENTATION_WIREFRAME}
\`\`\`

Each task card mirrors the implementation graph; nothing here is clickable yet.

\`\`\`wireframe
${INVALID}
\`\`\`
`;

function Sample({ source }: { source: string }) {
	let parsed = parseWireframe(source);
	if (!parsed.ok) throw new Error(`Gallery wireframe is invalid: ${parsed.problems[0]?.message}`);
	return <Wireframe wireframe={parsed.wireframe} />;
}

export function WireframeSpecimen() {
	return (
		<section
			aria-labelledby="wireframe-heading"
			className="diagram-gallery-section"
			id="wireframes"
		>
			<div className="diagram-gallery-section-heading">
				<div>
					<p className="diagram-gallery-kicker">Wireframe fences</p>
					<h2 id="wireframe-heading">Interface sketches</h2>
				</div>
				<p>
					Hairline blueprints drawn from a wireframe fence. The second fence in the document does
					not parse, so it stays code.
				</p>
			</div>
			<div className="diagram-gallery-document plan" data-wireframe-document="">
				<StaticPlanEditor source={DOCUMENT} />
			</div>
			<div className="diagram-gallery-wireframes">
				{SAMPLES.map(([id, name, source]) => (
					<article className="diagram-gallery-feature" data-wireframe-sample={id} key={id}>
						<div className="diagram-gallery-feature-heading">
							<h3>{name}</h3>
						</div>
						<Sample source={source} />
					</article>
				))}
				<article className="diagram-gallery-feature" data-wireframe-sample="narrow">
					<div className="diagram-gallery-feature-heading">
						<h3>Narrow column</h3>
						<code>23.4375rem</code>
					</div>
					<div className="diagram-gallery-wireframe-narrow">
						<Sample source={SETTINGS} />
						<Sample source={TASK_GRAPH} />
					</div>
				</article>
			</div>
		</section>
	);
}
