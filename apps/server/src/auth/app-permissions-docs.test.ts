import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");

/**
 * The GitHub App's repository permissions, as every guide that sets the App up lists them. Contents
 * and Pull requests are writable because machines push and open draft pull requests as their
 * owner; `machineGitHubToken` checks for both.
 */
const PERMISSIONS = [
	"Contents:        Read and write",
	"Pull requests:   Read and write",
	"Workflows:       Read and write",
	"Checks:          Read-only",
	"Commit statuses: Read-only",
	"Issues:          Read-only",
	"Metadata:        Read-only (automatic)",
].join("\n");

/** Every `text` block in `markdown` that lists Contents, the way the guides show permissions. */
function permissionBlocks(markdown: string) {
	return [...markdown.matchAll(/```text\n([\s\S]*?)\n```/g)]
		.map(match => match[1]!)
		.filter(block => block.startsWith("Contents:"));
}

test("every guide that sets up the GitHub App lists the same repository permissions", async () => {
	for (let file of ["README.md", "docs/authentication.md", "docs/self-hosting.md"]) {
		let blocks = permissionBlocks(await readFile(join(ROOT, file), "utf8"));
		expect({ file, blocks }).toEqual({ file, blocks: [PERMISSIONS] });
	}
});
