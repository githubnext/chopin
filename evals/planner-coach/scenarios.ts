import { readFileSync } from "node:fs";
import { hash } from "./sanitize";
import type { Scenario } from "./types";

let bytes = readFileSync(new URL("./scenarios.json.freeze", import.meta.url));
export const scenarioHash = hash(bytes);
const FREEZE_HASH = "b6f1ea734a850f0145d3ff55301f05545c767e7ec614ca6dc15802d49e91ecdf";
if (scenarioHash !== FREEZE_HASH) throw new Error("Planner coaching scenario freeze changed");
let frozen = JSON.parse(bytes.toString("utf8")) as {
	version: string;
	repository: Record<string, string>;
	cases: Scenario[];
};
if (frozen.version !== "planner-coach-synthetic-v1" || frozen.cases.length !== 11) {
	throw new Error("Unrecognized Planner coaching cohort");
}
export const scenarios = frozen.cases;
export const repositoryFiles = frozen.repository;

export function select(ids: string[]): Scenario[] {
	if (ids.length === 1 && ids[0] === "all") return scenarios;
	return ids.map(id => {
		let item = scenarios.find(candidate => candidate.id === id);
		if (!item) throw new Error(`Unknown case ${id}`);
		return item;
	});
}
