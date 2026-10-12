import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PHONE_SIZE_QUERY, PRIMARY_COARSE_POINTER_QUERY } from "@chopin/editor/pointer";

import { hostedRoute } from "./hosted";
import { PhoneSkeleton } from "./phone-skeleton";

let html = await Bun.file(new URL("../index.html", import.meta.url)).text();
let css = await Bun.file(new URL("./phone-skeleton.css", import.meta.url)).text();

function normalized(markup: string): string {
	return markup
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/\s+/g, " ")
		.replace(/>\s+</g, "><")
		.replace(/\s+>/g, ">")
		.trim();
}

test("the static first-paint skeleton matches the React skeleton", () => {
	let match = /<div class="boot-skeleton">([\s\S]*)<\/div>\s*<\/div>\s*<script type="module"/.exec(
		html,
	);
	expect(match).not.toBeNull();
	expect(normalized(match![1]!)).toBe(renderToStaticMarkup(<PhoneSkeleton />));
});

test("the static skeleton shows for exactly the document routes", () => {
	let literal = /var documentRoute =\s*\/(.*)\/(\w*);/.exec(html);
	expect(literal).not.toBeNull();
	let pattern = new RegExp(literal![1]!, literal![2]);
	for (
		let path of [
			"/",
			"/documents/octo-org/score",
			"/documents/octo-org/score/",
			"/documents/octo-org/score/offline-sync",
			"/documents/octo-org/score/offline-sync/research",
			"/documents/octo-org/score/offline-sync/children/research",
			"/documents/octo-org/score/offline-sync/children/research/",
			"/channels/aaaaaaaa-0000-4000-8000-000000000001",
			"/channels/AAAAAAAA-0000-4000-8000-000000000001/",
			"/channels/not-a-channel",
			"/repositories/octo-org/score",
			"/connect",
		]
	) {
		let page = hostedRoute(path).page;
		expect([path, pattern.test(path)]).toEqual([
			path,
			page === "document" || page === "child" || page === "channel",
		]);
	}
});

test("the static skeleton shows on exactly the phone class", () => {
	// `isPhone`: a primary coarse pointer and either phone size, spelled as one media query list.
	let query = PHONE_SIZE_QUERY.split(", ")
		.map(size => `${PRIMARY_COARSE_POINTER_QUERY} and ${size}`)
		.join(", ");
	expect(css).toContain(`@media ${query} {\n\t:root[data-boot="document"] .boot-skeleton {`);
});
