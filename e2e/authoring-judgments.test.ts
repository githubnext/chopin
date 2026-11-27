import { expect, test } from "bun:test";

import { ROOT } from "./servers";

let code = `
import { openDecisions } from "./apps/server/src/conversation-plan/decisions";
import { checkPlannerReply } from "./apps/server/src/chat/reply-policy";
let decide = await openDecisions({ decisionsModel: "typesafe/jev-latest" });
let signal = new AbortController().signal;
if (!await checkPlannerReply("Done.", decide, signal)) throw new Error("Factual reply refused");
if (await checkPlannerReply("Which option should we use?", decide, signal)) {
  throw new Error("Plain input request was permitted");
}
console.log("authoring-fixtures-ready");
`;

test.each(["./e2e/jev.ts", "./e2e/initiative-preload.ts"])(
	"%s serves real reply-policy judgment through fake HTTP with AGENT=off",
	async preload => {
		let child = Bun.spawn([process.execPath, "--no-env-file", "--preload", preload, "-e", code], {
			cwd: ROOT,
			env: {
				...process.env,
				AGENT: "off",
				JEV_API_KEY: "e2e-jev-only",
				TYPESAFE_API_KEY: "",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		let [exit, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
		expect(stdout.trim()).toBe("authoring-fixtures-ready");
	},
	30_000,
);
