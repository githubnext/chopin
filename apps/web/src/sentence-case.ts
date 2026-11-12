import { PLANNER_NAME } from "@chopin/editor/people";

const FIRST_LETTER = new RegExp(`^(?!${PLANNER_NAME}\\b)[a-z]`);

/**
 * A sentence's first letter in capitals, as interface copy wants, unless the sentence begins with
 * the agent's name, which keeps its lower case wherever it stands. Tooltips apply the same rule in
 * `icon-tooltip.tsx`, which loads on its own before the page's other code.
 */
export function sentenceCase(text: string): string {
	return text.replace(FIRST_LETTER, letter => letter.toUpperCase());
}
