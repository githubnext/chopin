/**
 * How many leading blocks a callout keeps visible before the rest fold away.
 *
 * Node state rather than a callout property, so it collaborates and serializes
 * like the callout's title without changing the node class. 0 never folds.
 */

import { createState } from "lexical";

import { MAX_CALLOUT_FOLD } from "../limits";

export const calloutFoldState = createState("plan-fold", {
	parse: (value: unknown): number =>
		Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_CALLOUT_FOLD
			? value as number
			: 0,
});
