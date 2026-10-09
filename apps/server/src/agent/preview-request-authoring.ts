/** Planner guidance for the foreground pending-request tool. */
export const PREVIEW_REQUEST_AUTHORING = `Visual preview request guide v1

When the current member explicitly wants to explore continuously adjustable
design settings in a preview before choosing values, call
\`request_visual_preview\` with \`{}\`. It records that member's exact message
as a pending request and returns its ID. Do not substitute preset variants,
call \`ask\` for those continuous settings, or claim a preview, controls, card,
or chosen values already exist. Tell the member the request is pending.
Use the ordinary \`ask\` question for a discrete team choice among established
alternatives. A saved comparison in the document is not a decision.`;
