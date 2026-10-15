import { LoaderIcon, PlusIcon } from "@chopin/icons";
import { useRef } from "react";
import { StaticPlanEditor } from "@chopin/editor/static";

import { SidebarAccount } from "../account-menu";
import { RepositoryOptions } from "../add-project-dialog";
import { BuildGlyph } from "../build-plan-button";
import { DecisionViewControl } from "../decision-view-control";
import { IconButton } from "../icon-button";
import { AuditPlate, StateLabel } from "./frame";

import type * as Api from "../api";
import type { ComponentProps, ReactNode } from "react";

const TABS = [
	'<Tabs id="01K0N4W3B7P27CBAEC7A8C8WF0">',
	'<Tab id="01K0N4W3B7P27CBAEC7A8C8WF1" label="macOS">',
	"",
	"Run the installer, then open the app from Applications.",
	"",
	"</Tab>",
	'<Tab id="01K0N4W3B7P27CBAEC7A8C8WF2" label="Web">',
	"",
	"Open the document in any current browser.",
	"",
	"</Tab>",
	'<Tab id="01K0N4W3B7P27CBAEC7A8C8WF3" label="A longer label">',
	"",
	"A third tab with a longer label.",
	"",
	"</Tab>",
	"</Tabs>",
].join("\n") + "\n";

/** Each state is the production rule itself, reached through `data-force-state`. */
const STATES = [
	{ label: "Default" },
	{ force: "hover", label: "Hover" },
	{ force: "active", label: "Active" },
	{ force: "focus", label: "Focus" },
	{ disabled: true, label: "Disabled" },
] as const satisfies readonly { disabled?: true; force?: string; label: string }[];

const BUILDING = <BuildGlyph look={{ done: 2, kind: "building", total: 5 }} />;

// The document view switcher in the states the live title bar gives it.
const VIEW_SPECIMENS: {
	label: string;
	props: Partial<ComponentProps<typeof DecisionViewControl>>;
}[] = [
	{ label: "Document selected, 3 unanswered", props: { unanswered: 3 } },
	{ label: "Decisions selected", props: { unanswered: 3, view: "decisions" } },
	{ label: "No unanswered decisions", props: {} },
	{
		label: "Planner writing the document",
		props: { documentActivity: "writing", view: "decisions" },
	},
	{ label: "New document changes", props: { documentActivity: "unseen", view: "decisions" } },
	{ label: "Build not ready", props: { buildEnabled: false } },
	{ label: "Build ready, building", props: { buildEnabled: true, buildGlyph: BUILDING } },
	{
		label: "Build selected",
		props: { buildEnabled: true, buildGlyph: BUILDING, view: "build" },
	},
	{
		label: "Build linked to the hovered capsule",
		props: { buildEnabled: true, buildGlyph: BUILDING, buildHot: true },
	},
];

const AUDIT_USER = { avatarUrl: "", id: "audit-user", login: "MaggieAppleton" };

const AUDIT_REPOSITORIES: Api.Repository[] = ["chopin", "design-notes", "editor-lab"].map(name => ({
	defaultBranch: "main",
	fullName: `githubnext/${name}`,
	id: `R_${name}`,
	name,
	owner: "githubnext",
	permissions: { admin: false, pull: true, push: true },
	private: false,
	url: `https://github.com/githubnext/${name}`,
}));

/** The live palette listbox as Add project shows it: one repository already added and not offered. */
function SelectionList() {
	let input = useRef<HTMLInputElement>(null);
	return (
		<div className="navigation-modal-content navigation-palette">
			<div className="navigation-palette-list">
				<RepositoryOptions
					addedIds={new Set(["R_design-notes"])}
					input={input}
					onChoose={() => {}}
					query="githubnext"
					repositories={AUDIT_REPOSITORIES}
				/>
			</div>
		</div>
	);
}

function StateSample({ children, state }: { children: ReactNode; state: string }) {
	return (
		<div className="design-audit-control-state">
			<StateLabel>{state}</StateLabel>
			<div>{children}</div>
		</div>
	);
}

function ButtonRow(
	{ className, label }: { className: string; label: string },
) {
	return (
		<div className="design-audit-control-grid">
			{STATES.map(state => (
				<StateSample key={state.label} state={state.label}>
					<button
						className={`btn btn-md ${className}`}
						data-force-state={"force" in state ? state.force : undefined}
						disabled={"disabled" in state}
						type="button"
					>
						{label}
					</button>
				</StateSample>
			))}
		</div>
	);
}

const ICON_BUTTONS = [
	{ label: "Ghost", recipe: {} },
	{ label: "Nested in a hovered row", recipe: { tone: "nested" } },
	{ label: "Compact", recipe: { glyph: "compact", size: "compact" } },
] as const;

/** Icon buttons have no pressed fill; hover and focus share one. */
const ICON_STATES = STATES.filter(state => state.label !== "Active");

/** Links have no pressed or disabled treatment in the app. */
const LINK_STATES = STATES.filter(state => !("disabled" in state) && state.label !== "Active");

export function Controls() {
	return (
		<>
			<AuditPlate
				description="Two text sizes and one square icon size across every hierarchy and state."
				item="buttons"
				title="Buttons"
			>
				<div className="design-audit-button-families">
					<div data-audit-sample="primary">
						<h4>Primary</h4>
						<ButtonRow className="btn-primary" label="Create document" />
					</div>
					<div data-audit-sample="secondary">
						<h4>Secondary</h4>
						<ButtonRow className="btn-secondary" label="Cancel" />
					</div>
					<div>
						<h4>Outline</h4>
						<ButtonRow className="btn-outline" label="Retry" />
					</div>
					<div className="design-audit-danger-actions" data-audit-sample="danger-outline">
						<h4>Outline on a danger surface</h4>
						<ButtonRow className="btn-outline-danger" label="Retry" />
					</div>
					<div data-audit-sample="ghost">
						<h4>Ghost</h4>
						<ButtonRow className="btn-ghost" label="Learn more" />
					</div>
					<div data-audit-sample="destructive">
						<h4>Destructive</h4>
						<ButtonRow className="btn-destructive" label="Delete document" />
					</div>
					<div className="design-audit-button-sizes" data-audit-sample="sizes">
						<StateSample state="Medium: 32px high, 12px sides">
							<button className="btn btn-md btn-primary" type="button">Medium</button>
						</StateSample>
						<StateSample state="Small: 24px high, 8px sides">
							<button className="btn btn-sm btn-secondary" type="button">Small</button>
						</StateSample>
						<StateSample state="Busy">
							<button aria-busy="true" className="btn btn-md btn-primary" disabled type="button">
								<LoaderIcon aria-hidden="true" data-button-loader="" />Saving
							</button>
						</StateSample>
					</div>
				</div>
			</AuditPlate>

			<AuditPlate
				description="The shared IconButton in its tones and sizes."
				item="icon-buttons"
				title="Icon buttons"
			>
				<div className="design-audit-button-families">
					{ICON_BUTTONS.map(({ label, recipe }) => (
						<div key={label}>
							<h4>{label}</h4>
							<div className="design-audit-control-grid">
								{ICON_STATES.map(state => (
									<StateSample key={state.label} state={state.label}>
										<IconButton
											{...recipe}
											aria-label="Add document"
											data-force-state={"force" in state ? state.force : undefined}
											disabled={"disabled" in state}
										>
											<PlusIcon aria-hidden="true" />
										</IconButton>
									</StateSample>
								))}
							</div>
						</div>
					))}
				</div>
			</AuditPlate>

			<AuditPlate
				description="Inline actions and links in running text."
				item="links"
				title="Links"
			>
				<div className="design-audit-control-grid">
					{LINK_STATES.map(state => (
						<StateSample key={state.label} state={state.label}>
							<a
								className="link text-sm"
								data-force-state={"force" in state ? state.force : undefined}
								href="#links"
							>
								Configure
							</a>
						</StateSample>
					))}
				</div>
			</AuditPlate>

			<AuditPlate description="Text and multiline inputs." item="fields" title="Fields">
				<div className="design-audit-field-grid">
					<label htmlFor="audit-field-default">
						Default<input
							className="field h-8 w-full px-2 text-sm"
							defaultValue="Document title"
							id="audit-field-default"
						/>
					</label>
					<label htmlFor="audit-field-focus">
						Focus<input
							className="field h-8 w-full px-2 text-sm"
							data-force-state="focus"
							defaultValue="Focused title"
							id="audit-field-focus"
						/>
					</label>
					<label htmlFor="audit-field-disabled">
						Disabled<input
							className="field h-8 w-full px-2 text-sm"
							defaultValue="Unavailable"
							disabled
							id="audit-field-disabled"
						/>
					</label>
					<label htmlFor="audit-field-invalid">
						Error<input
							aria-invalid="true"
							className="field h-8 w-full px-2 text-sm"
							defaultValue=""
							id="audit-field-invalid"
						/>
					</label>
					<label htmlFor="audit-field-readonly">
						Read only<input
							className="field h-8 w-full px-2 text-sm"
							defaultValue="Stored title"
							id="audit-field-readonly"
							readOnly
						/>
					</label>
					<label className="design-audit-field-wide" htmlFor="audit-field-textarea">
						Textarea<textarea
							className="min-h-16 min-w-0 resize-y field px-2 py-1 text-sm font-normal"
							defaultValue="Write a message to the room"
							id="audit-field-textarea"
							rows={3}
						/>
					</label>
				</div>
			</AuditPlate>

			<AuditPlate
				description="Checkboxes, radios, and list selection."
				item="selections"
				title="Choices and selections"
			>
				<div className="design-audit-choice-row">
					<label>
						<input className="choice-control size-4 shrink-0" type="checkbox" />Unchecked
					</label>
					<label>
						<input
							className="choice-control size-4 shrink-0"
							defaultChecked
							type="checkbox"
						/>Checked
					</label>
					<label>
						<input className="choice-control size-4 shrink-0" disabled type="checkbox" />Disabled
					</label>
					<label>
						<input
							className="choice-control size-4 shrink-0"
							defaultChecked
							name="audit-radio"
							type="radio"
						/>Selected
					</label>
					<label>
						<input
							className="choice-control size-4 shrink-0"
							name="audit-radio"
							type="radio"
						/>Unselected
					</label>
				</div>
				<SelectionList />
			</AuditPlate>

			<AuditPlate
				description="The real document view switcher and the real authored Tabs widget."
				item="tabs"
				title="Tabs"
			>
				<div className="flex flex-col gap-4">
					<div className="design-audit-tab-specimens">
						{VIEW_SPECIMENS.map(({ label, props }) => (
							<div key={label}>
								<StateLabel>{label}</StateLabel>
								<DecisionViewControl
									buildEnabled={props.buildEnabled}
									buildGlyph={props.buildGlyph}
									buildHot={props.buildHot}
									documentActivity={props.documentActivity}
									onView={() => {}}
									unanswered={props.unanswered ?? 0}
									view={props.view ?? "plan"}
								/>
							</div>
						))}
					</div>
					<div>
						<StateLabel>Authored tabs with the first tab selected</StateLabel>
						<StaticPlanEditor source={TABS} />
					</div>
				</div>
			</AuditPlate>

			<AuditPlate
				description="Open action menu with destructive separation."
				item="menus"
				title="Menus"
			>
				<div className="design-audit-menu-specimens">
					<div>
						<StateLabel>Closed</StateLabel>
						<button aria-expanded="false" className="btn btn-md btn-secondary" type="button">
							Document actions
						</button>
					</div>
					<div>
						<StateLabel>Open, focused and disabled</StateLabel>
						<div aria-label="Document actions" className="design-audit-menu" role="menu">
							<button role="menuitem" type="button">Rename document</button>
							<button data-audit-state="focus" role="menuitem" type="button">
								Archive document
							</button>
							<button disabled role="menuitem" type="button">Restore document</button>
							<button className="design-audit-menu-destructive" role="menuitem" type="button">
								Delete document
							</button>
						</div>
					</div>
				</div>
			</AuditPlate>

			<AuditPlate
				description="The sidebar account menu, closed and open."
				item="dropdowns"
				title="Dropdowns"
			>
				<div className="design-audit-dropdown-row">
					<div>
						<StateLabel>Closed</StateLabel>
						<div className="project-sidebar">
							<SidebarAccount onAccount={() => {}} user={AUDIT_USER} />
						</div>
					</div>
					<div>
						<StateLabel>Open</StateLabel>
						<div className="design-audit-account-open">
							<div className="project-sidebar">
								<SidebarAccount
									menu={{
										className: "is-open",
										closing: false,
										onDismiss() {},
										onShortcuts() {},
										onSignOut() {},
									}}
									menuId="design-audit-account-menu"
									onAccount={() => {}}
									user={AUDIT_USER}
								/>
							</div>
						</div>
					</div>
				</div>
			</AuditPlate>
		</>
	);
}
