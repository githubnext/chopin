import { limits } from "@chopin/dialect";

/** A label the dialect accepts, or `undefined` when nothing usable was typed. */
export function tabLabel(raw: string): string | undefined {
	let label = raw.replace(/\s+/g, " ").trim().slice(0, limits.MAX_TAB_LABEL).trim();
	return label || undefined;
}

/** "Tab N" for the next position, skipping any number already in use. */
export function newTabLabel(labels: string[]): string {
	let taken = new Set(labels.map(label => label.trim().toLowerCase()));
	let number = labels.length + 1;
	while (taken.has(`tab ${number}`)) number++;
	return `Tab ${number}`;
}

/** Index, among the tabs that remain, of the one that takes a removed tab's place. */
export function successor(count: number, removed: number): number {
	return Math.max(0, Math.min(removed, count - 2));
}

export type StripAction =
	| { type: "select"; index: number }
	| { type: "rename" }
	| { type: "remove" };

/** What a key does on a focused tab. Authoring keys apply only when the document is editable. */
export function stripKey(
	key: string,
	position: number,
	count: number,
	editable: boolean,
): StripAction | undefined {
	switch (key) {
		case "ArrowRight":
			return { type: "select", index: (position + 1) % count };
		case "ArrowLeft":
			return { type: "select", index: (position - 1 + count) % count };
		case "Home":
			return { type: "select", index: 0 };
		case "End":
			return { type: "select", index: count - 1 };
		case "Enter":
		case "F2":
			return editable ? { type: "rename" } : undefined;
		case "Delete":
			return editable && count > 1 ? { type: "remove" } : undefined;
	}
	return undefined;
}
