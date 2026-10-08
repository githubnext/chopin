import { sha256, verifyBundle } from "../../apps/server/src/visual-preview/policy";
import { revisionDigest } from "../../apps/server/src/visual-decisions/revision";

import type { TrustedPreviewArtifact } from "../../apps/server/src/visual-preview/descriptor";
import type { VisualDecision } from "../../packages/protocol";

type Fixture = {
	definition: VisualDecision.Definition;
	artifact: TrustedPreviewArtifact;
	csp: string;
};

let built: Promise<Fixture[]> | undefined;

async function script(entry: string) {
	let result = await Bun.build({
		entrypoints: [new URL(entry, import.meta.url).pathname],
		target: "browser",
		minify: true,
	});
	if (!result.success || result.outputs.length !== 1) {
		throw new Error("Fixture preview build failed");
	}
	return await result.outputs[0]!.text();
}

function fixture(
	ref: string,
	title: string,
	requestId: string,
	controls: VisualDecision.Control[],
	baseline: VisualDecision.Values,
	markup: string,
	styles: string,
	javascript: string,
): Fixture {
	let html =
		`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style></head><body>${markup}<script type="module">${javascript}</script></body></html>`;
	let bytes = new TextEncoder().encode(html);
	let digest = `sha256:${sha256(bytes)}`;
	let bundle = verifyBundle(bytes, digest);
	let base: Omit<VisualDecision.Definition, "definitionRevision"> = {
		schema: "visual-decision@1",
		title,
		requestId,
		artifact: { ref, digest },
		controls,
		baseline,
	};
	let definition: VisualDecision.Definition = { ...base, definitionRevision: revisionDigest(base) };
	let origin = process.env.VISUAL_PREVIEW_ORIGIN ?? "http://localhost:8841";
	return {
		definition,
		artifact: {
			bytes,
			url: `${origin}/bundles/${bundle.sha256}/bundle.html`,
		},
		csp: bundle.csp,
	};
}

async function fixtures() {
	return built ??= (async () => {
		let [billing, profile] = await Promise.all([script("./billing.ts"), script("./profile.ts")]);
		return [
			fixture(
				"fixture-billing-card",
				"Billing card",
				"fixture-billing-request",
				[
					{
						type: "number",
						id: "cardSpacing",
						label: "Card spacing",
						unit: "px",
						min: 8,
						max: 24,
						step: 4,
					},
					{ type: "color", id: "accentColor", label: "Accent colour" },
				],
				{ cardSpacing: 16, accentColor: "#246B78" },
				'<div class="wrap"><div id="billing-card" class="card"><p class="eyebrow">Studio plan</p><h1>One clear price</h1><p>Everything a small team needs to start.</p><strong id="billing-price"></strong><button type="button">Choose plan</button></div></div>',
				`body{margin:0;font:14px/1.5 system-ui;background:#f6f5f1;color:#1d2929}.wrap{padding:22px}.card{--accent:#246B78;max-width:320px;margin:auto;background:white;border:1px solid #d9e1df;border-radius:16px;box-shadow:0 8px 30px #182c2912;padding:16px}.card[data-spacing="8"]{padding:8px}.card[data-spacing="12"]{padding:12px}.card[data-spacing="16"]{padding:16px}.card[data-spacing="20"]{padding:20px}.card[data-spacing="24"]{padding:24px}.eyebrow{color:var(--accent);font-size:12px;text-transform:uppercase;letter-spacing:.08em;font-weight:700}h1{font-size:23px;line-height:1.2;margin:6px 0 10px}p{margin:0 0 12px}strong{display:block;font-size:22px;margin:16px 0}button{background:var(--accent);color:white;border:0;border-radius:6px;padding:8px 14px;font:inherit}`,
				billing,
			),
			fixture(
				"fixture-profile-banner",
				"Profile banner",
				"fixture-profile-request",
				[
					{
						type: "number",
						id: "cornerRadius",
						label: "Corner radius",
						unit: "px",
						min: 0,
						max: 20,
						step: 5,
					},
					{ type: "color", id: "surfaceColor", label: "Surface colour" },
				],
				{ cornerRadius: 10, surfaceColor: "#E6E8D9" },
				'<div class="wrap"><div id="profile-banner" class="banner"><div class="avatar" aria-hidden="true">AL</div><div><h1>Alex Lee</h1><p>Product designer</p><small id="profile-caption"></small></div></div></div>',
				`body{margin:0;font:14px/1.5 system-ui;background:#f5f4f1;color:#252b25}.wrap{padding:22px}.banner{--surface:#E6E8D9;max-width:360px;margin:auto;display:flex;gap:16px;align-items:center;padding:20px;background:var(--surface);border:1px solid #d5d8d0}.banner[data-radius="0"]{border-radius:0}.banner[data-radius="5"]{border-radius:5px}.banner[data-radius="10"]{border-radius:10px}.banner[data-radius="15"]{border-radius:15px}.banner[data-radius="20"]{border-radius:20px}.avatar{width:56px;height:56px;flex:none;border-radius:50%;display:grid;place-items:center;background:#394c48;color:white;font-weight:700}h1{font-size:18px;margin:0 0 2px}p{margin:0 0 4px}small{color:#52615a}`,
				profile,
			),
		];
	})();
}

export async function fixtureVisualDefinitions(): Promise<VisualDecision.Definition[]> {
	return (await fixtures()).map(item => item.definition);
}

export async function verifyFixtureArtifact(artifact: { ref: string; digest: string }) {
	return (await fixtures()).some(item =>
		item.definition.artifact.ref === artifact.ref
		&& item.definition.artifact.digest === artifact.digest
	);
}

export async function fixtureResolver(ref: string): Promise<TrustedPreviewArtifact | undefined> {
	return (await fixtures()).find(item => item.definition.artifact.ref === ref)?.artifact;
}

export async function fixtureByDigest(digest: string): Promise<Fixture | undefined> {
	return (await fixtures()).find(item => item.definition.artifact.digest === digest);
}
