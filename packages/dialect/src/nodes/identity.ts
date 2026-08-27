import { createState } from "lexical";

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Stable identity shared by identified dialect nodes. */
export const idState = createState("plan-id", { parse: text });
