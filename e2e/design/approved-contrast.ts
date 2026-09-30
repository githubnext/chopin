import typography from "./approved-contrast/typography.json";
import badge from "./approved-contrast/badge.json";
import buttons_primary from "./approved-contrast/buttons-primary.json";
import buttons_secondary from "./approved-contrast/buttons-secondary.json";
import buttons_ghost from "./approved-contrast/buttons-ghost.json";
import buttons_destructive from "./approved-contrast/buttons-destructive.json";
import buttons_sizes from "./approved-contrast/buttons-sizes.json";
import fields from "./approved-contrast/fields.json";
import chat from "./approved-contrast/chat.json";
import callouts from "./approved-contrast/callouts.json";
import code from "./approved-contrast/code.json";
import table from "./approved-contrast/table.json";

// Maggie approved these named roles on 29 September 2026; see apps/web/DESIGN.md.
// Each entry records its approval role and exact measured finding. Never auto-refresh failures.
let findings: Record<string, Record<string, { approvedRole: string; finding: unknown }[]>> = {
	"typography": typography,
	"badge": badge,
	"buttons-primary": buttons_primary,
	"buttons-secondary": buttons_secondary,
	"buttons-ghost": buttons_ghost,
	"buttons-destructive": buttons_destructive,
	"buttons-sizes": buttons_sizes,
	"fields": fields,
	"chat": chat,
	"callouts": callouts,
	"code": code,
	"table": table,
};

export function approvedContrast(name: string, project: string): unknown[] {
	let specimen = findings[name];
	if (!specimen) return [];
	let approved = specimen[project];
	if (!approved) throw new Error(`No reviewed contrast decision for viewport: ${project}`);
	return approved.map(entry => entry.finding);
}
