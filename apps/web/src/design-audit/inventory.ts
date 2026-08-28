export type AuditItem = {
	id: string;
	label: string;
	source: string;
	states: readonly string[];
	judgement?: string;
};

export type AuditGroup = {
	id: "foundations" | "controls" | "surfaces" | "authored-content";
	label: string;
	items: readonly AuditItem[];
};

const STATIC = ["default"] as const;
const INTERACTIVE = ["default", "hover", "active", "focus", "disabled"] as const;
const ASYNC = ["loading", "empty", "error", "ready"] as const;

export const AUDIT_INVENTORY: readonly AuditGroup[] = [
	{
		id: "foundations",
		label: "Foundations",
		items: [
			{ id: "colours", label: "Colour roles", source: "apps/web/src/theme.css", states: STATIC },
			{ id: "typography", label: "Typography", source: "apps/web/src/theme.css", states: STATIC },
			{ id: "spacing", label: "Spacing", source: "apps/web/src/theme.css", states: STATIC },
			{ id: "radii", label: "Radii", source: "apps/web/src/theme.css", states: STATIC },
			{ id: "shadows", label: "Elevation", source: "apps/web/src/theme.css", states: STATIC },
			{
				id: "icons",
				label: "Icons",
				source: "apps/web/src/assets/icons",
				states: ["default", "active", "disabled"],
				judgement: "Confirm the compact, default, and emphasis size roles.",
			},
		],
	},
	{
		id: "controls",
		label: "Controls",
		items: [
			{ id: "buttons", label: "Buttons", source: "apps/web/src/theme.css", states: INTERACTIVE },
			{
				id: "icon-buttons",
				label: "Icon buttons",
				source: "apps/web/src/theme.css",
				states: INTERACTIVE,
			},
			{ id: "links", label: "Links", source: "apps/web/src/theme.css", states: INTERACTIVE },
			{ id: "fields", label: "Fields", source: "apps/web/src/theme.css", states: INTERACTIVE },
			{
				id: "selections",
				label: "Choices and selections",
				source: "apps/web/src/theme.css",
				states: ["default", "selected", "focus", "disabled"],
			},
			{
				id: "tabs",
				label: "Tabs",
				source: "packages/editor/src/widgets/tabs.tsx",
				states: ["default", "selected", "focus", "overflow"],
			},
			{
				id: "menus",
				label: "Menus",
				source: "apps/web/src/document-actions-menu.tsx",
				states: ["closed", "open", "focus", "disabled"],
			},
			{
				id: "dropdowns",
				label: "Dropdowns",
				source: "apps/web/src/document-picker.tsx",
				states: ["closed", "open", "selected", "loading", "error"],
			},
		],
	},
	{
		id: "surfaces",
		label: "Application surfaces",
		items: [
			{
				id: "dialogs",
				label: "Dialogs",
				source: "apps/web/src/navigation-dialog.tsx",
				states: ["open", "busy", "destructive", "error"],
			},
			{
				id: "lists",
				label: "Lists",
				source: "apps/web/src/document-picker.tsx",
				states: ["default", "hover", "selected", "empty"],
			},
			{
				id: "navigation",
				label: "Navigation",
				source: "apps/web/src/project-sidebar.tsx",
				states: ["default", "current", "ancestor", "archived", "loading"],
			},
			{
				id: "chat",
				label: "Conversation",
				source: "apps/web/src/chat/chat.tsx",
				states: ["member", "planner", "tool", "busy", "error"],
			},
			{
				id: "identity",
				label: "Identity and collaboration",
				source: "packages/editor/src/face.tsx",
				states: ["avatar-loading", "editing-question"],
			},
			{
				id: "decisions",
				label: "Decisions",
				source: "packages/editor/src/decisions.tsx",
				states: ["unanswered", "answered", "resolved", "orphaned", "empty"],
			},
			{
				id: "resolved-comments",
				label: "Resolved comments",
				source: "packages/editor/src/comments.tsx",
				states: ["resolved", "deliberately-empty", "orphaned"],
			},
			{ id: "loading", label: "Loading", source: "apps/web/src/hosted.tsx", states: ASYNC },
			{
				id: "empty",
				label: "Empty states",
				source: "apps/web/src/repository-picker.tsx",
				states: ["first-use", "no-results", "unavailable"],
			},
			{
				id: "errors",
				label: "Errors",
				source: "apps/web/src/terminal-alert.tsx",
				states: ["inline", "terminal", "recoverable"],
			},
		],
	},
	{
		id: "authored-content",
		label: "Authored content",
		items: [
			{
				id: "callouts",
				label: "Callouts",
				source: "packages/editor/src/widgets/callout.tsx",
				states: ["note", "tip", "important", "warning", "danger", "focus"],
			},
			{
				id: "research",
				label: "Research",
				source: "packages/editor/src/widgets/research.tsx",
				states: ["question", "queued", "running", "failed", "cancelled", "ready"],
			},
			{
				id: "code",
				label: "Code blocks",
				source: "packages/editor/src/widgets/code-view.tsx",
				states: ["plain", "named", "collapsed", "editing"],
			},
			{
				id: "diff",
				label: "Diff blocks",
				source: "packages/editor/src/widgets/code-view.tsx",
				states: ["valid", "invalid", "collapsed"],
			},
			{
				id: "diagram",
				label: "Diagrams",
				source: "packages/editor/src/widgets/code-view.tsx",
				states: ["rendered", "source", "invalid"],
			},
			{
				id: "formula",
				label: "Formulae",
				source: "packages/editor/src/widgets/render-blocks.tsx",
				states: ["inline", "block", "source"],
			},
			{
				id: "image",
				label: "Images",
				source: "packages/editor/src/widgets/image.tsx",
				states: ["loaded", "unavailable", "missing-alt"],
			},
			{
				id: "table",
				label: "Tables",
				source: "packages/editor/src/table/chrome.tsx",
				states: ["default", "selected-cell", "toolbar", "overflow"],
			},
		],
	},
];
