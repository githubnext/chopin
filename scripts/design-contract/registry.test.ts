import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { designProblems } from "../check-design.mjs";
import {
	applyPatch,
	parsePatch,
	RECORDED_DIRECTORY,
	RECORDED_MANIFEST,
	sha256,
	verifyRecordedSources,
} from "./registry.mjs";
import { scan } from "./scan";

/** What `shadcn add` writes for a button: shadcn's utilities, a class spread and a prop spread. */
let copied = `import { cva } from "class-variance-authority";
import { cn } from "cn";
const buttonVariants = cva("rounded-xl bg-primary shadow-xs duration-100 ease-in text-[13px]");
export function Button({ className, ...props }) {
	return <button className={cn(buttonVariants({ className }))} {...props} />;
}
`;
let FILE = `${RECORDED_DIRECTORY}/ui/button.tsx`;
let version = "shadcn-ui/ui@0123456abcdef";

function entry(file = FILE, content = copied, over: Record<string, unknown> = {}) {
	return {
		file,
		registry: "@shadcn",
		item: "button",
		version,
		sha256: sha256(content),
		...over,
	};
}

function fixture(
	files: Record<string, string>,
	manifest: unknown,
	check: (root: string) => void,
) {
	let root = mkdtempSync(join(tmpdir(), "chopin-recorded-"));
	try {
		mkdirSync(join(root, "apps/web"), { recursive: true });
		mkdirSync(join(root, "packages/visuals"), { recursive: true });
		for (let [path, value] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), value);
		}
		if (manifest !== undefined) {
			mkdirSync(join(root, RECORDED_DIRECTORY), { recursive: true });
			writeFileSync(
				join(root, RECORDED_MANIFEST),
				typeof manifest === "string" ? manifest : JSON.stringify(manifest),
			);
		}
		check(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

let scanned = (findings: unknown[]) => ({ status: 2, stdout: JSON.stringify(findings) });
let record = (...files: ReturnType<typeof entry>[]) => ({ schemaVersion: 1, files });

describe("recorded third-party source", () => {
	test("a recorded copy is accepted whole, and the same source anywhere else is not", () => {
		fixture({ [FILE]: copied, "apps/web/src/button.tsx": copied }, record(entry()), root => {
			let result = scan(root);
			expect(result.recorded.errors).toEqual([]);
			expect([...result.recorded.files]).toEqual([FILE]);
			let findings = result.findings.map(finding => finding.file);
			expect(findings.length).toBeGreaterThan(0);
			expect(new Set(findings)).toEqual(new Set(["apps/web/src/button.tsx"]));
		});
	});

	test("without a record the copy is held to every rule", () => {
		fixture({ [FILE]: copied }, undefined, root => {
			let result = scan(root);
			expect(result.findings.some(finding => finding.file === FILE)).toBe(true);
			expect(result.recorded.errors.join("\n")).toContain("not in");
		});
	});

	test("editing a recorded file by one character loses the acceptance and says why", () => {
		fixture({ [FILE]: copied.replace("rounded-xl", "rounded-2xl") }, record(entry()), root => {
			let result = scan(root);
			expect(result.recorded.files.size).toBe(0);
			expect(result.recorded.errors.join("\n")).toContain("no longer matches its record");
			expect(result.recorded.errors.join("\n")).toContain("@shadcn/button");
			expect(result.findings.some(finding => finding.file === FILE)).toBe(true);
		});
	});

	test("hand-written code cannot hide in the recorded directory", () => {
		let handWritten = `${RECORDED_DIRECTORY}/mine.tsx`;
		fixture({ [FILE]: copied, [handWritten]: copied }, record(entry()), root => {
			let result = scan(root);
			expect(result.recorded.errors.join("\n")).toContain(`${handWritten} is in`);
			expect(result.findings.some(finding => finding.file === handWritten)).toBe(true);
		});
	});

	test("a recorded file that is gone, recorded twice or from an unknown place is an error", () => {
		fixture(
			{},
			record(entry()),
			root => expect(verifyRecordedSources(root).errors.join("\n")).toContain("recorded"),
		);
		fixture(
			{ [FILE]: copied },
			record(entry(), entry()),
			root => expect(verifyRecordedSources(root).errors.join("\n")).toContain("twice"),
		);
		fixture(
			{ [FILE]: copied },
			record(entry(FILE, copied, { registry: "@acme" })),
			root =>
				expect(verifyRecordedSources(root).errors.join("\n")).toContain("registry other than"),
		);
	});

	test("every record names its item, an upstream version and a hash", () => {
		for (
			let change of [
				{ item: "" },
				{ item: "Button" },
				{ version: "latest" },
				{ version: undefined },
				{ sha256: "abc" },
				{ file: "packages/ui/button.tsx" },
				{ file: "apps/web/src/../../secret.tsx" },
			]
		) {
			fixture({ [FILE]: copied }, record(entry(FILE, copied, change)), root => {
				let result = verifyRecordedSources(root);
				expect(result.files.size).toBe(0);
				expect(result.errors.length).toBeGreaterThan(0);
			});
		}
	});

	test("a malformed manifest fails closed", () => {
		fixture({ [FILE]: copied }, "{", root => {
			let result = scan(root);
			expect(result.recorded.errors.join("\n")).toContain("not valid JSON");
			expect(result.findings.some(finding => finding.file === FILE)).toBe(true);
		});
		fixture(
			{ [FILE]: copied },
			{ schemaVersion: 2, files: [] },
			root => expect(verifyRecordedSources(root).errors.join("\n")).toContain("schemaVersion"),
		);
	});

	test("a generated Tailwind layer must come from the Tailwind that is installed", () => {
		let layer = `${RECORDED_DIRECTORY}/geometry.css`;
		let tailwind = (value: string) =>
			entry(layer, ":root{}", {
				registry: "tailwindcss",
				item: "theme.css",
				version: `tailwindcss@${value}`,
			});
		let files = {
			[layer]: ":root{}",
			"apps/web/node_modules/tailwindcss/package.json": JSON.stringify({ version: "4.3.0" }),
		};
		fixture(
			files,
			record(tailwind("4.3.0")),
			root => expect(verifyRecordedSources(root).errors).toEqual([]),
		);
		fixture(
			files,
			record(tailwind("4.2.0")),
			root => expect(verifyRecordedSources(root).errors.join("\n")).toContain("generate it again"),
		);
	});

	test("a file outside the directory but inside src is recorded the same way", () => {
		let utils = "apps/web/src/lib/utils.ts";
		let content = 'export { cn } from "cn";\n';
		fixture(
			{ [utils]: content },
			record(entry(utils, content, { item: "utils" })),
			root => expect([...verifyRecordedSources(root).files]).toEqual([utils]),
		);
	});
});

describe("Impeccable accepts recorded files only", () => {
	let root = resolve(import.meta.dir, "../..");
	let finding = (file: string) => ({
		antipattern: "side-tab",
		file: join(root, file),
		snippet: "border-l-4",
	});
	let baseline = { schemaVersion: 1, findings: [] };

	test("a finding in a recorded file is not new, and the same finding elsewhere is", () => {
		let accepted = new Set([FILE]);
		let results = scanned([finding(FILE), finding("apps/web/src/chat/chat.tsx")]);
		expect(designProblems(results, baseline, root, accepted)).toEqual({
			changes: ["NEW side-tab in apps/web/src/chat/chat.tsx: border-l-4 (1)"],
			count: 1,
		});
		expect(designProblems(results, baseline, root).changes).toHaveLength(2);
	});

	test("a baseline entry for a file that is now recorded is stale", () => {
		let entry = {
			rule: "side-tab",
			file: FILE,
			snippet: "border-l-4",
			count: 1,
			reason: "Old.",
		};
		expect(
			designProblems(
				scanned([finding(FILE)]),
				{ schemaVersion: 1, findings: [entry] },
				root,
				new Set([
					FILE,
				]),
			).changes,
		).toEqual([`STALE baseline side-tab in ${FILE}: border-l-4`]);
	});
});

/** What the registry wrote, one attribute to a line as prettier does, and what a patch may do to it. */
let ROW = `import { cn } from "cn";

export function Row({ label, ...props }) {
	return (
		<li
			data-slot="row"
			className={cn("flex gap-2 px-3", props.className)}
			{...props}
		>
			{label}
		</li>
	);
}
`;
let ROW_FILE = `${RECORDED_DIRECTORY}/assistant-ui/elements/row.tsx`;

/** A real unified diff with its reasons, as `record-registry-sources.ts --patch` writes it. */
function diffOf(pristine: string, patched: string, reasons: string[]): string {
	let root = mkdtempSync(join(tmpdir(), "chopin-diff-"));
	try {
		writeFileSync(join(root, "a"), pristine);
		writeFileSync(join(root, "b"), patched);
		let diff = spawnSync("diff", ["-U3", "-L", "a/row.tsx", "-L", "b/row.tsx", "a", "b"], {
			cwd: root,
			encoding: "utf8",
		}).stdout;
		let index = 0;
		return diff.replace(/^(@@ .* @@).*$/gm, (_, header) => `${header} ${reasons[index++] ?? ""}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function patched(
	change: (source: string) => string,
	reasons = ["Reason: a leading slot so a row can show who sent it"],
	check: (root: string, result: ReturnType<typeof verifyRecordedSources>) => void,
) {
	let after = change(ROW);
	let patch = diffOf(ROW, after, reasons);
	fixture(
		{
			[ROW_FILE]: after,
			[`${ROW_FILE}.patch`]: patch,
		},
		record({
			...entry(ROW_FILE, ROW, { registry: "@assistant-ui", item: "elements-row" }),
			patch: `${ROW_FILE}.patch`,
			patchSha256: sha256(patch),
		} as ReturnType<typeof entry>),
		root => check(root, verifyRecordedSources(root)),
	);
}

let ADD_SLOT = (source: string) =>
	source.replace("({ label, ...props })", "({ label, lead, ...props })")
		.replace("\t\t\t{...props}\n", '\t\t\t{...props}\n\t\t\tdata-lead={lead ? "" : undefined}\n')
		.replace("\t\t\t{label}\n", "\t\t\t{lead}\n\t\t\t{label}\n");

describe("a recorded patch to a copied file", () => {
	test("is accepted as the registry's file plus exactly the patch, and the copy is held to nothing else", () => {
		patched(ADD_SLOT, [
			"Reason: a leading slot for the sender",
			"Reason: a data attribute for the slot",
			"Reason: the slot itself",
		], (root, result) => {
			expect(result.errors).toEqual([]);
			expect([...result.files]).toEqual([ROW_FILE]);
			expect(scan(root).findings.filter(finding => finding.file === ROW_FILE)).toEqual([]);
		});
	});

	test("round-trips: undoing it gives back the registry's bytes, and applying it again the patched file", () => {
		let after = ADD_SLOT(ROW);
		let parsed = parsePatch(diffOf(ROW, after, ["Reason: one", "Reason: two", "Reason: three"]));
		expect(parsed.error).toBeUndefined();
		expect(applyPatch(after, parsed.hunks, "new").text).toBe(ROW);
		expect(applyPatch(ROW, parsed.hunks, "old").text).toBe(after);
		expect(applyPatch(ROW, parsed.hunks, "new").error).toContain("no longer applies");
	});

	test("fails once the file is not the registry's plus the patch: a changed line, or a new registry copy", () => {
		let after = ADD_SLOT(ROW);
		let patch = diffOf(ROW, after, [
			"Reason: the slot",
			"Reason: the attribute",
			"Reason: the child",
		]);
		let manifest = record({
			...entry(ROW_FILE, ROW, { registry: "@assistant-ui", item: "elements-row" }),
			patch: `${ROW_FILE}.patch`,
			patchSha256: sha256(patch),
		} as ReturnType<typeof entry>);
		// Edited by hand beyond the patch.
		fixture(
			{ [ROW_FILE]: after.replace("{label}", "{label} {label}"), [`${ROW_FILE}.patch`]: patch },
			manifest,
			root => {
				let result = verifyRecordedSources(root);
				expect(result.files.size).toBe(0);
				expect(result.errors.join("\n")).toContain("no longer applies");
			},
		);
		// The registry's file changed under the patch (a copy with --overwrite, and no re-apply).
		fixture(
			{ [ROW_FILE]: ROW, [`${ROW_FILE}.patch`]: patch },
			manifest,
			root => expect(verifyRecordedSources(root).errors.join("\n")).toContain("no longer applies"),
		);
		// The registry's bytes are not the recorded ones.
		fixture(
			{ [ROW_FILE]: after, [`${ROW_FILE}.patch`]: patch },
			record({
				...entry(ROW_FILE, "other", { registry: "@assistant-ui", item: "elements-row" }),
				patch: `${ROW_FILE}.patch`,
				patchSha256: sha256(patch),
			} as ReturnType<typeof entry>),
			root => expect(verifyRecordedSources(root).errors.join("\n")).toContain("recorded hash"),
		);
	});

	test("needs its record: the patch's hash, its own file and no stray patch beside it", () => {
		let after = ADD_SLOT(ROW);
		let patch = diffOf(ROW, after, [
			"Reason: the slot",
			"Reason: the attribute",
			"Reason: the child",
		]);
		let base = entry(ROW_FILE, ROW, { registry: "@assistant-ui", item: "elements-row" });
		fixture(
			{ [ROW_FILE]: after, [`${ROW_FILE}.patch`]: patch },
			record({
				...base,
				patch: `${ROW_FILE}.patch`,
				patchSha256: sha256("another patch"),
			} as ReturnType<typeof entry>),
			root =>
				expect(verifyRecordedSources(root).errors.join("\n")).toContain(
					"no longer matches its record",
				),
		);
		fixture(
			{ [ROW_FILE]: after, [`${ROW_FILE}.patch`]: patch },
			record({
				...base,
				patch: `${RECORDED_DIRECTORY}/elsewhere.patch`,
				patchSha256: sha256(patch),
			} as ReturnType<typeof entry>),
			root => expect(verifyRecordedSources(root).errors.join("\n")).toContain("its patch must be"),
		);
		fixture(
			{ [FILE]: copied, [`${FILE}.patch`]: patch },
			record(entry()),
			root =>
				expect(verifyRecordedSources(root).errors.join("\n")).toContain(`${FILE}.patch is in`),
		);
	});

	test("may only add extension points: no reasonless hunk, class, style or edited string", () => {
		let reasons = ["Reason: the slot", "Reason: the attribute", "Reason: the child"];
		patched(
			ADD_SLOT,
			["", "Reason: the attribute", "Reason: the child"],
			(_, result) => expect(result.errors.join("\n")).toContain("needs a one-line reason"),
		);
		patched(
			source =>
				ADD_SLOT(source).replace(
					"\t\t\t{label}\n",
					"\t\t\t{label}\n\t\t\t<b className={lead} />\n",
				),
			reasons,
			(_, result) => expect(result.errors.join("\n")).toContain("adds styling"),
		);
		patched(
			source =>
				ADD_SLOT(source).replace("\t\t\t{label}\n", "\t\t\t{label}\n\t\t\t<b style={lead} />\n"),
			reasons,
			(_, result) => expect(result.errors.join("\n")).toContain("adds styling"),
		);
		patched(
			source => ADD_SLOT(source).replace('"flex gap-2 px-3"', '"flex gap-4 px-3"'),
			reasons,
			(_, result) => expect(result.errors.join("\n")).toContain("removes or changes a string"),
		);
		patched(
			source =>
				ADD_SLOT(source).replace(
					"\t\t\t{label}\n",
					'\t\t\t{label}\n\t\t\t<b data-note="p-4 rounded-xl" />\n',
				),
			reasons,
			(_, result) => expect(result.errors.join("\n")).toContain("could be classes"),
		);
	});
});
