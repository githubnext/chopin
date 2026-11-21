import { expect, test } from "bun:test";
import { buildingWords, machineRecipes } from "./machine-sandbox";

test("connect says each image it builds, and that the Planner's is built now so the first document's Planner starts at once", () => {
	let recipes = (plannerInstall?: string) => [
		...machineRecipes({
			command: ["my-agent", "--acp"],
			install: ["npm install -g my-agent"],
			...plannerInstall
				? { plannerCommand: ["my-planner"], plannerInstall: [plannerInstall] }
				: {},
		}).values(),
	];
	expect(buildingWords(recipes())).toBe(
		"Building my-agent's image for its microVMs (a minute or two, once).",
	);
	let [agent, planner] = recipes("npm install -g my-planner");
	expect(buildingWords([agent!])).toBe(
		"Building my-agent's image for its microVMs (a minute or two, once).",
	);
	expect(buildingWords([planner!])).toBe(
		"Building the Planner's image (my-planner) for its microVMs (a minute or two, once, so the "
			+ "first document's Planner starts at once).",
	);
	// A Planner command that starts the agent's own program runs from the agent's image.
	expect(
		buildingWords([
			...machineRecipes({
				command: ["node", "agent.mjs"],
				install: ["true"],
				plannerCommand: ["node", "planner.mjs"],
				plannerInstall: ["true"],
			}).values(),
		]),
	).toBe(
		"Building one image for node and the Planner (node), whose installs are the same, for their "
			+ "microVMs (a minute or two, once, so the first document's Planner starts at once).",
	);
	expect(buildingWords(recipes("npm install -g my-agent"))).toBe(
		"Building one image for my-agent and the Planner (my-planner), whose installs are the same, "
			+ "for their microVMs (a minute or two, once, so the first document's Planner starts at "
			+ "once).",
	);
});
