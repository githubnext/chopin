import { createRefineTools } from "./scoped-refine-tool";
import { createDirectTools } from "./scoped-revise-tool";
import { createProseTools } from "./scoped-prose-tool";

export function createScopedTools() {
	return { ...createRefineTools(), ...createDirectTools(), ...createProseTools() };
}
