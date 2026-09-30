import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

let root = resolve(import.meta.dir, "..");
let tag = `chopin-design:${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
let mounts = ["e2e/design/snapshots", "e2e/test-results/design", "e2e/playwright-report/design"];
for (let directory of mounts) mkdirSync(resolve(root, directory), { recursive: true });

function docker(args: string[]) {
	let result = spawnSync("docker", args, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

docker(["build", "--platform=linux/amd64", "-f", "e2e/design/Dockerfile", "-t", tag, "."]);
// No host ports or shared databases: Vite and Chromium share this disposable container.
// Only reviewed baselines and diagnostic reports cross the container boundary.
docker([
	"run",
	"--rm",
	"--init",
	"--platform=linux/amd64",
	"--shm-size=1g",
	...mounts.flatMap(directory => ["-v", `${resolve(root, directory)}:/work/${directory}`]),
	tag,
	"bun",
	"run",
	"design:test",
	...process.argv.slice(2),
]);
