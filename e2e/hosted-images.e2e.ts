import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { authenticate, content, expect, ready, test } from "./room";

// 1536x1024 WebP drawn for the refund plan example.
const PICTURE = readFileSync(new URL("./fixtures/the-cap.webp", import.meta.url));
const ALT = "The cap is a balance of 100.";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const HEADERS = [
	"content-type",
	"content-length",
	"cache-control",
	"content-security-policy",
	"content-disposition",
	"x-content-type-options",
];

type Result = { isError: boolean; value: Record<string, unknown> };

/** A readable record of every request, without credentials, for review. */
function journal() {
	let lines = ["# Hosted image requests", ""];
	let headers = (source: (name: string) => string | null | undefined) =>
		HEADERS.flatMap(name => {
			let value = source(name);
			return value == null ? [] : [`  - \`${name}: ${value}\``];
		});
	return {
		step(title: string) {
			lines.push(`## ${title}`, "");
		},
		tool(actor: string, name: string, summary: string, status: number, result: Result) {
			lines.push(
				`- \`POST /mcp\` \`tools/call ${name}\` as ${actor} (${summary}) -> HTTP ${status}`,
				`  - isError: ${result.isError}`,
				`  - structuredContent: \`${JSON.stringify(result.value)}\``,
				"",
			);
		},
		fetch(
			actor: string,
			path: string,
			status: number,
			source: (name: string) => string | null | undefined,
			body?: string,
		) {
			lines.push(`- \`GET ${path}\` as ${actor} -> HTTP ${status}`, ...headers(source));
			if (body) lines.push(`  - body: ${body}`);
			lines.push("");
		},
		text: () => lines.join("\n"),
	};
}

test("an uploaded picture renders for a reader of its document and nobody else", async ({ baseURL, browser, page }) => {
	let origin = baseURL!;
	let suffix = crypto.randomUUID();
	let author = `image-author-${suffix}`;
	let reader = `score-reader-${suffix}`;
	let outsider = `score-outsider-${suffix}`;
	let log = journal();

	let call = async (
		handle: string,
		actor: string,
		name: string,
		arguments_: Record<string, unknown>,
		summary: string,
	): Promise<Result> => {
		let response = await fetch(`${origin}/mcp`, {
			method: "POST",
			headers: {
				authorization: `Bearer ghu_e2e_${handle}_1`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: arguments_ },
			}),
		});
		expect(response.status).toBe(200);
		let { result } = await response.json();
		let outcome = { isError: result.isError === true, value: result.structuredContent };
		log.tool(actor, name, summary, response.status, outcome);
		return outcome;
	};
	let upload = (handle: string, actor: string, bytes: Uint8Array, mimeType: string) =>
		call(
			handle,
			actor,
			"upload_image",
			{ id: created.value.id, data: Buffer.from(bytes).toString("base64"), mimeType },
			`${bytes.byteLength} bytes declared ${mimeType}`,
		);

	// 1. The author signs in and creates a document.
	log.step("1. Create the document");
	await authenticate(page, author, origin);
	let created = await call(author, "author (push)", "create_document", {
		idempotencyKey: `hosted-images-${suffix}`,
		repository: "octo-org/score",
		baseBranch: "main",
		baseCommit: "0000000000000000000000000000000000000000",
		title: `Hosted images ${suffix.slice(0, 8)}`,
		brief: {
			goal: "Show the refund cap",
			constraints: [],
			settledDecisions: [],
			openQuestions: [],
			repositoryFindings: [],
		},
		plan: "# Refund cap\n\nRefunds stop at the cap.\n",
	}, "octo-org/score");
	expect(created.isError).toBe(false);

	// 2. Uploading returns a content-addressed path, and the same one again.
	log.step("2. Upload the picture twice");
	let first = await upload(author, "author (push)", PICTURE, "image/webp");
	expect(first.isError).toBe(false);
	let path = first.value.path as string;
	expect(path).toMatch(/^\/images\/[0-9a-f]{64}\.webp$/);
	expect(path).toBe(`/images/${createHash("sha256").update(PICTURE).digest("hex")}.webp`);
	expect(first.value.markdown).toBe(`![](${path})`);
	let second = await upload(author, "author (push)", PICTURE, "image/webp");
	expect(second).toEqual(first);

	// 3. The document accepts the hosted path.
	log.step("3. Place the picture in the document");
	let markdown = `![${ALT}](${path})`;
	let updated = await call(author, "author (push)", "update_document", {
		id: created.value.id,
		revision: created.value.revision,
		plan: `# Refund cap\n\nRefunds stop at the cap.\n\n${markdown}\n`,
		idempotencyKey: `hosted-images-${suffix}-picture`,
	}, `revision ${created.value.revision}`);
	expect(updated.isError).toBe(false);
	expect(updated.value.issues).toBeUndefined();
	expect(updated.value.source).toContain(markdown);

	// 4. The author's browser loads it in the document.
	log.step("4. Open the document in the browser");
	await page.setViewportSize({ width: 1440, height: 1000 });
	let loaded = page.waitForResponse(response => new URL(response.url()).pathname === path);
	await page.goto(created.value.url as string);
	await ready(page);
	let image = content(page).getByRole("img", { name: ALT, exact: true });
	await expect(image).toBeVisible();
	await expect(image).toHaveAttribute("src", path);
	let response = await loaded;
	log.fetch(
		"the author's browser loading the <img>",
		path,
		response.status(),
		name => response.headers()[name],
	);
	expect(response.status()).toBe(200);
	await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth))
		.toBe(1536);
	await image.scrollIntoViewIfNeeded();
	let screenshot = test.info().outputPath("screenshot-document.png");
	await page.screenshot({ path: screenshot });
	await test.info().attach("screenshot-document", { path: screenshot, contentType: "image/png" });

	// 5. The author's session fetches the exact bytes with restrictive headers.
	log.step("5. Fetch the picture with the author's session");
	let served = await page.request.get(path);
	let bytes = await served.body();
	log.fetch(
		"author (browser session)",
		path,
		served.status(),
		name => served.headers()[name],
		`${bytes.byteLength} bytes, identical to the fixture: ${bytes.equals(PICTURE)}`,
	);
	expect(served.status()).toBe(200);
	expect(served.headers()["content-type"]).toBe("image/webp");
	expect(served.headers()["x-content-type-options"]).toBe("nosniff");
	expect(served.headers()["cache-control"]).toBe("private, max-age=31536000, immutable");
	expect(served.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
	expect(bytes.equals(PICTURE)).toBe(true);

	// 6. Everyone else gets the same 404 as an unknown image.
	log.step("6. Fetch the picture without read access");
	let anonymous = await fetch(`${origin}${path}`);
	log.fetch(
		"a signed-out client (no cookie)",
		path,
		anonymous.status,
		name => anonymous.headers.get(name),
		JSON.stringify(await anonymous.text()),
	);
	expect(anonymous.status).toBe(404);

	let stranger = await browser.newContext({ baseURL: origin });
	try {
		let strangerPage = await stranger.newPage();
		await authenticate(strangerPage, outsider, origin);
		let session = await stranger.request.get("/api/session");
		log.fetch(
			"outsider (signed in, no access to octo-org/score)",
			"/api/session",
			session.status(),
			name => session.headers()[name],
		);
		expect(session.status()).toBe(200);
		let refused = await stranger.request.get(path);
		log.fetch(
			"outsider (signed in, no access to octo-org/score)",
			path,
			refused.status(),
			name => refused.headers()[name],
			JSON.stringify(await refused.text()),
		);
		expect(refused.status()).toBe(404);
	} finally {
		await stranger.close();
	}

	let unknown = `/images/${"0".repeat(64)}.webp`;
	let missing = await page.request.get(unknown);
	log.fetch(
		"author (browser session)",
		unknown,
		missing.status(),
		name => missing.headers()[name],
		JSON.stringify(await missing.text()),
	);
	expect(missing.status()).toBe(404);

	// 7. Uploads Chopin will not host.
	log.step("7. Refused uploads");
	let svg = await upload(author, "author (push)", new TextEncoder().encode(SVG), "image/svg+xml");
	expect(svg).toEqual({ isError: true, value: { code: "unsupported-type" } });
	let mismatch = await upload(author, "author (push)", PICTURE, "image/png");
	expect(mismatch).toEqual({ isError: true, value: { code: "signature-mismatch" } });
	let forbidden = await upload(reader, "reader (pull, no push)", PICTURE, "image/webp");
	expect(forbidden).toEqual({ isError: true, value: { code: "repository-forbidden" } });

	let record = test.info().outputPath("http-log.md");
	await writeFile(record, log.text());
	await test.info().attach("http-log", { path: record, contentType: "text/markdown" });
});
