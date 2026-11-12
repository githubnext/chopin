import { PLANNER_NAME } from "@chopin/protocol/planner-name";

/**
 * How the agent names itself and the people it writes about. Every model whose words a person
 * reads is given it: the Planner and its background writers, its reaction replies, research
 * children and History's summaries.
 *
 * Chat shows a person by their GitHub handle exactly as GitHub has it and the agent as `chopin`, so
 * a reply that wrote "Mona_acme" or "Chopin" would disagree with the row it sits under.
 */
export const NAMES_AS_WRITTEN =
	`In Chat you appear as ${PLANNER_NAME}, all lower case; if you name `
	+ `yourself, write ${PLANNER_NAME}. People appear by their GitHub handles: write a handle exactly `
	+ "as given, keeping its case, digits, underscores and hyphens, and as @handle when you mention "
	+ "someone (for example @mona_acme or @Hubot-Bot). Never capitalise, title-case or otherwise "
	+ "change a handle, even at the start of a sentence. Chopin, with a capital, is the product's "
	+ "name: use it only when you write about the product.";
