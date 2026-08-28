import { CheckIcon, ChevronIcon, LoaderIcon, PlusIcon, WarningIcon } from "@chopin/icons";

import { AuditPlate, StateLabel } from "./frame";

import type { ReactNode } from "react";

const STATES = ["Default", "Hover", "Active", "Focus", "Disabled"] as const;

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
				<StateSample key={state} state={state}>
					<button
						className={`btn btn-md ${className}`}
						data-audit-state={state.toLowerCase()}
						disabled={state === "Disabled"}
						type="button"
					>
						{label}
					</button>
				</StateSample>
			))}
		</div>
	);
}

export function Controls() {
	return (
		<>
			<AuditPlate
				description="Two text sizes and one square icon size across every hierarchy and state."
				item="buttons"
				title="Buttons"
			>
				<div className="design-audit-button-families">
					<div>
						<h4>Primary</h4>
						<ButtonRow className="btn-primary" label="Create document" />
					</div>
					<div>
						<h4>Secondary</h4>
						<ButtonRow className="btn-secondary" label="Cancel" />
					</div>
					<div>
						<h4>Ghost</h4>
						<ButtonRow className="btn-ghost" label="Learn more" />
					</div>
					<div>
						<h4>Destructive</h4>
						<ButtonRow className="btn-destructive" label="Delete document" />
					</div>
					<div className="design-audit-button-sizes">
						<StateSample state="Medium · 32px high · 12px sides">
							<button className="btn btn-md btn-primary" type="button">Medium</button>
						</StateSample>
						<StateSample state="Small · 24px high · 8px sides">
							<button className="btn btn-sm btn-secondary" type="button">Small</button>
						</StateSample>
						<StateSample state="Busy">
							<button aria-busy="true" className="btn btn-md btn-primary" disabled type="button">
								<span aria-hidden="true" className="design-audit-busy-mark" />Saving
							</button>
						</StateSample>
					</div>
				</div>
			</AuditPlate>

			<AuditPlate
				description="The shared 28px square control with a 14px glyph and 7px inset."
				item="icon-buttons"
				title="Icon buttons"
			>
				<div className="design-audit-control-grid">
					{STATES.map(state => (
						<StateSample key={state} state={state}>
							<button
								aria-label="Add document"
								className="btn btn-icon btn-ghost"
								data-audit-state={state.toLowerCase()}
								disabled={state === "Disabled"}
								type="button"
							>
								<PlusIcon aria-hidden="true" size={14} />
							</button>
						</StateSample>
					))}
				</div>
			</AuditPlate>

			<AuditPlate description="Inline navigation and action links." item="links" title="Links">
				<div className="design-audit-control-grid">
					{STATES.map(state => (
						<StateSample key={state} state={state}>
							<a
								aria-disabled={state === "Disabled" ? true : undefined}
								className="design-audit-link"
								data-audit-state={state.toLowerCase()}
								href={state === "Disabled" ? undefined : "#links"}
							>
								Read the document
							</a>
						</StateSample>
					))}
				</div>
			</AuditPlate>

			<AuditPlate description="Text, selection, and multiline inputs." item="fields" title="Fields">
				<div className="design-audit-field-grid">
					<label htmlFor="audit-field-default">
						Default<input
							className="field"
							defaultValue="Document title"
							id="audit-field-default"
						/>
					</label>
					<label htmlFor="audit-field-focus">
						Focus<input
							className="field"
							data-audit-state="focus"
							defaultValue="Focused title"
							id="audit-field-focus"
						/>
					</label>
					<label htmlFor="audit-field-disabled">
						Disabled<input
							className="field"
							defaultValue="Unavailable"
							disabled
							id="audit-field-disabled"
						/>
					</label>
					<label htmlFor="audit-field-invalid">
						Error<input
							aria-invalid="true"
							className="field"
							defaultValue=""
							id="audit-field-invalid"
						/>
					</label>
					<label htmlFor="audit-field-readonly">
						Read only<input
							className="field"
							defaultValue="Stored title"
							id="audit-field-readonly"
							readOnly
						/>
					</label>
					<label htmlFor="audit-field-select">
						Select<select className="field" defaultValue="active" id="audit-field-select">
							<option value="active">Active documents</option>
							<option value="archived">Archived documents</option>
						</select>
					</label>
					<label className="design-audit-field-wide" htmlFor="audit-field-textarea">
						Textarea<textarea
							className="field"
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
						<input className="choice-control" type="checkbox" />Unchecked
					</label>
					<label>
						<input className="choice-control" defaultChecked type="checkbox" />Checked
					</label>
					<label>
						<input className="choice-control" disabled type="checkbox" />Disabled
					</label>
					<label>
						<input
							className="choice-control"
							defaultChecked
							name="audit-radio"
							type="radio"
						/>Selected
					</label>
					<label>
						<input className="choice-control" name="audit-radio" type="radio" />Unselected
					</label>
				</div>
				<div aria-label="Documents" className="design-audit-selection-list" role="listbox">
					<div role="option">Architecture notes</div>
					<div aria-selected="true" role="option">
						<CheckIcon aria-hidden="true" size={14} />Design system audit
					</div>
					<div aria-disabled="true" role="option">Archived proposal</div>
				</div>
			</AuditPlate>

			<AuditPlate
				description="Destination and authored-content tab treatments."
				item="tabs"
				title="Tabs"
			>
				<div className="design-audit-tab-specimens">
					<div>
						<StateLabel>Selected · focus · disabled</StateLabel>
						<div aria-label="Document views" className="design-audit-tabs" role="tablist">
							<button aria-selected="true" role="tab" type="button">Document</button>
							<button aria-selected="false" data-audit-state="focus" role="tab" type="button">
								Decisions <span>3</span>
							</button>
							<button aria-selected="false" disabled role="tab" type="button">Unavailable</button>
						</div>
					</div>
					<div className="design-audit-tab-overflow">
						<StateLabel>Overflow</StateLabel>
						<div
							aria-label="Overflowing document views"
							className="design-audit-tabs"
							role="tablist"
						>
							<button aria-selected="true" role="tab" type="button">Document</button>
							<button aria-selected="false" role="tab" type="button">Resolved decisions</button>
							<button aria-selected="false" role="tab" type="button">Resolved comments</button>
						</div>
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
						<StateLabel>Open · focus · disabled</StateLabel>
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
				description="Closed trigger and open list selection."
				item="dropdowns"
				title="Dropdowns"
			>
				<div className="design-audit-dropdown-row">
					<button
						aria-expanded="false"
						className="field design-audit-dropdown-trigger"
						type="button"
					>
						Active documents<ChevronIcon aria-hidden="true" className="rotate-90" size={14} />
					</button>
					<div className="design-audit-dropdown-open">
						<button
							aria-expanded="true"
							className="field design-audit-dropdown-trigger"
							type="button"
						>
							Active documents<ChevronIcon aria-hidden="true" className="rotate-90" size={14} />
						</button>
						<div
							aria-label="Document collection"
							className="design-audit-dropdown-list"
							role="listbox"
						>
							<div aria-selected="true" role="option">
								<CheckIcon aria-hidden="true" size={14} />Active documents
							</div>
							<div role="option">Archived documents</div>
						</div>
					</div>
					<div className="design-audit-dropdown-open">
						<StateLabel>Loading</StateLabel>
						<button
							aria-busy="true"
							className="field design-audit-dropdown-trigger"
							disabled
							type="button"
						>
							Loading documents<LoaderIcon aria-hidden="true" />
						</button>
					</div>
					<div className="design-audit-dropdown-open">
						<StateLabel>Error</StateLabel>
						<button
							aria-invalid="true"
							className="field design-audit-dropdown-trigger"
							type="button"
						>
							Documents unavailable<WarningIcon aria-hidden="true" />
						</button>
						<span className="design-audit-dropdown-error" role="alert">
							Could not load documents.
						</span>
					</div>
				</div>
			</AuditPlate>
		</>
	);
}
