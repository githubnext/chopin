export const AT = "2026-09-25T10:00:00.000Z";

export function card(trigger: string, kind: "refine" | "suggest" = "refine") {
	return { kind, target: "W1", trigger };
}
