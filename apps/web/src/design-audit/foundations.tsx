import { AuditPlate } from "./frame";
import { IconCatalogue } from "./icons";

const COLOURS = [
	["Page", "--color-page"],
	["Ground", "--color-ground"],
	["Inset", "--color-inset"],
	["Selected", "--color-selected"],
	["Primary text", "--color-text-primary"],
	["Secondary text", "--color-text-secondary"],
	["Tertiary text", "--color-text-tertiary"],
	["Quaternary text", "--color-text-quaternary"],
	["Brand", "--color-brand"],
	["Brand hover", "--color-brand-hover"],
	["Brand wash", "--color-brand-wash"],
	["Success", "--color-success"],
	["Success wash", "--color-success-wash"],
	["Warning", "--color-warning"],
	["Warning wash", "--color-warning-wash"],
	["Destructive", "--color-destructive"],
	["Destructive wash", "--color-destructive-wash"],
] as const;

const TYPE = [
	["Chrome and labels", "13px / 20px line-height", "--text-sm", "--text-sm--line-height"],
	["Document prose", "15px / 22px line-height", "--text-base", "--text-base--line-height"],
	["Subheading", "17px / 27px line-height", "--text-lg", "--text-lg--line-height"],
	["Section heading", "24px / 30px line-height", "--text-xl", "--text-xl--line-height"],
	["Document title", "32px / 38px line-height", "--text-2xl", "--text-2xl--line-height"],
] as const;

const SPACING = [2, 4, 6, 8, 12, 16, 24, 32] as const;

const RADII = [
	["Small", "--radius-sm"],
	["Medium", "--radius-md"],
	["Large", "--radius-lg"],
	["Extra large", "--radius-xl"],
] as const;

const SHADOWS = [
	["Resting", "--shadow-resting"],
	["Raised", "--shadow-raised"],
	["Overlay", "--shadow-overlay"],
] as const;

export function Foundations() {
	return (
		<>
			<AuditPlate
				item="colours"
				title="Colour roles"
				description="Semantic roles on the light system."
			>
				<div className="design-audit-swatch-grid">
					{COLOURS.map(([label, token]) => (
						<figure key={token}>
							<span style={{ background: `var(${token})` }} />
							<figcaption>
								<strong>{label}</strong>
								<code>{token}</code>
							</figcaption>
						</figure>
					))}
				</div>
			</AuditPlate>
			<AuditPlate
				item="typography"
				title="Typography"
				description="The complete five-rung type scale."
			>
				<div className="design-audit-type-stack">
					{TYPE.map(([label, measurement, size, lineHeight]) => (
						<div key={size} style={{ fontSize: `var(${size})`, lineHeight: `var(${lineHeight})` }}>
							<div className="design-audit-type-label">
								<span>{label}</span>
								<code>{measurement}</code>
							</div>
							<strong>Several people and a Planner share one document.</strong>
						</div>
					))}
				</div>
			</AuditPlate>
			<AuditPlate
				item="spacing"
				title="Spacing"
				description="Common intervals on the four-pixel base scale."
			>
				<div className="design-audit-spacing-scale">
					{SPACING.map(value => (
						<div key={value}>
							<code>{value}px</code>
							<span style={{ width: value }} />
						</div>
					))}
				</div>
			</AuditPlate>
			<AuditPlate
				item="radii"
				title="Radii"
				description="Four roles from controls to the document page."
			>
				<div className="design-audit-token-row">
					{RADII.map(([label, token]) => (
						<figure key={token}>
							<span style={{ borderRadius: `var(${token})` }} />
							<figcaption>{label}</figcaption>
						</figure>
					))}
				</div>
			</AuditPlate>
			<AuditPlate
				item="shadows"
				title="Elevation"
				description="Resting, raised, and overlay depth roles."
			>
				<div className="design-audit-token-row">
					{SHADOWS.map(([label, token]) => (
						<figure key={token}>
							<span style={{ boxShadow: `var(${token})` }} />
							<figcaption>{label}</figcaption>
						</figure>
					))}
				</div>
			</AuditPlate>
			<AuditPlate
				item="icons"
				title="Icons"
				description="Every local SVG and Phosphor glyph currently used by the interface."
			>
				<IconCatalogue />
			</AuditPlate>
		</>
	);
}
