import { createPi } from "@ai-sdk/harness-pi";
import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";

import { harnessContract } from "./contract";

if (process.env.RUN_PI_HARNESS_CONTRACT === "1") {
	harnessContract("pi", () => createPi(), createJustBashNetworkSandboxSession);
}
