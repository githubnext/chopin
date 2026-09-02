import { lexicalTheme } from "@mdxeditor/editor";

export const PLAN_LEXICAL_THEME = {
	...lexicalTheme,
	collaboration: {
		cursor: "plan-cursor",
		cursorName: "plan-cursor-name",
		selection: "plan-cursor-selection",
		selectionBg: "plan-cursor-selection-bg",
	},
	tableCellSelected: "plan-cell-selected",
	tableSelection: "plan-table-selecting",
};
