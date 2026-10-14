import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./servers";

export const RELEASE: string = JSON.parse(
	readFileSync(join(ROOT, "apps/connector/package.json"), "utf8"),
).version;
