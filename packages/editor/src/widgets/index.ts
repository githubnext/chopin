/**
 * Wires the document model to its rendering.
 *
 * `@chopin/dialect` stays headless so the server can use it, so decorator nodes
 * call out to whatever the UI registered. Importing this module is what makes
 * plan widgets render at all.
 */

import { setRenderer } from "@chopin/dialect";

import { renderImage } from "./image";
import { renderQuestionnaire } from "./questionnaire";

import type { ImageNode, QuestionnaireNode } from "@chopin/dialect";

let registered = false;

/** Idempotent: importing this from several entry points must not double-register. */
export function register(): void {
	if (registered) return;
	registered = true;

	setRenderer<ImageNode>("plan-image", renderImage);
	setRenderer<QuestionnaireNode>("plan-questionnaire", renderQuestionnaire);
}

export { CalloutPlugin } from "./callout";
export { QuestionnaireCard } from "./questionnaire";
export type { QuestionnaireCardProps } from "./questionnaire";
export { PreviewPlugin } from "./render-blocks";
export { TabsPlugin } from "./tabs";
