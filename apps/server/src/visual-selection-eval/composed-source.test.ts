import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { loadComposedCases } from "./composed-source";

function hash(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

test("loads only the three pinned passage spans and rejects changed source bytes", async () => {
	let root = await mkdtemp(join(tmpdir(), "chopin-composed-source-"));
	try {
		let proposal = "## Heading\n\nBody line\n";
		let control = JSON.stringify({ cutoff: "2024-01-01", events: [{ body: "One short claim." }] });
		await writeFile(join(root, "proposal.md"), proposal);
		await writeFile(join(root, "control.json"), control);
		let cases = [
			...["first", "second"].map(id => ({
				id,
				cluster: id,
				input: { documentTitle: id, heading: "Heading", passage: proposal.trim() },
				passageSha256: hash(proposal.trim()),
				source: {
					path: "proposal.md",
					sha256: hash(proposal),
					snapshot: "fixture",
					cutoff: "fixture",
					segments: [{
						firstLine: 1,
						lastLine: 3,
						startByte: 0,
						endByte: Buffer.byteLength(proposal),
					}],
					adaptation: "none",
				},
			})),
			{
				id: "control",
				cluster: "control",
				input: {
					documentTitle: "control",
					heading: "Issue opening",
					passage: "One short claim.",
				},
				passageSha256: hash("One short claim."),
				source: {
					path: "control.json",
					sha256: hash(control),
					snapshot: "fixture",
					cutoff: "2024-01-01",
					jsonPointer: "/events/0/body",
					startByteInBody: 0,
					endByteInBody: Buffer.byteLength("One short claim."),
					adaptation: "none",
				},
			},
		];
		let path = join(root, "manifest.json");
		await writeFile(path, JSON.stringify({ version: 1, cases }));
		expect((await loadComposedCases(path, root)).map(item => item.id))
			.toEqual(["first", "second", "control"]);
		await writeFile(join(root, "proposal.md"), proposal.replace("Body", "Other"));
		expect(loadComposedCases(path, root)).rejects.toThrow("Source hash changed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
