import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Face, FACE_RADIUS_CLASS, FACE_RING_CLASS, faceCorner } from "./face";
import { faceSources, nextPhoto, photoShown, photoSource } from "./face-photo";
import { rememberAvatars, setFaceProfiles } from "./people";

test("names static cover-ring classes for every supported surface", () => {
	expect(FACE_RING_CLASS).toEqual({
		ground: "ring-2 ring-ground",
		page: "ring-2 ring-page",
	});
});

test("an overlapping header face uses the header surface for its cover ring", () => {
	let markup = renderToStaticMarkup(
		createElement(Face, { handle: "maggie", ring: "ground" }),
	);

	expect(markup).toContain("ring-2 ring-ground");
});

test("corner radius scales with size", () => {
	expect(FACE_RADIUS_CLASS[faceCorner(18)]).toBe("rounded-sm");
	expect(FACE_RADIUS_CLASS[faceCorner(24)]).toBe("rounded-md");
});

test("a named tooltip suppresses the native title", () => {
	let titled = renderToStaticMarkup(createElement(Face, { handle: "maggie" }));
	let quiet = renderToStaticMarkup(createElement(Face, { handle: "maggie", titled: false }));
	expect(titled).toContain('title="maggie"');
	expect(quiet).not.toContain("title=");
});

const STORED = "https://avatars.githubusercontent.com/u/4242?v=4";

test("a person whose GitHub picture is known is shown it, not the guess from their login", () => {
	rememberAvatars([{ login: "mona_acme", avatarUrl: STORED }]);

	let known = renderToStaticMarkup(createElement(Face, { handle: "mona_acme", size: 24 }));
	expect(known).toContain(`src="${STORED}"`);
	expect(known).not.toContain("github.com/mona_acme.png");

	let stranger = renderToStaticMarkup(createElement(Face, { handle: "stranger_acme", size: 24 }));
	expect(stranger).toContain('src="https://github.com/stranger_acme.png?size=48"');
});

test("a known picture is found whatever the casing of the login", () => {
	rememberAvatars([{ login: "Lisa_Acme", avatarUrl: STORED }]);
	let markup = renderToStaticMarkup(createElement(Face, { handle: "lisa_acme" }));
	expect(markup).toContain(`src="${STORED}"`);
});

test("a demo actor keeps its roster picture and never reaches GitHub", () => {
	setFaceProfiles([{ id: "demo:lily", name: "Lily", avatar: "/demo/lily.svg" }]);
	try {
		rememberAvatars([{ login: "demo:lily", avatarUrl: STORED }, {
			login: "demo:felix",
			avatarUrl: STORED,
		}]);
		let lily = renderToStaticMarkup(createElement(Face, { handle: "demo:lily" }));
		expect(lily).toContain('src="/demo/lily.svg"');
		expect(lily).not.toContain(STORED);
		let felix = renderToStaticMarkup(createElement(Face, { handle: "demo:felix" }));
		expect(felix).not.toContain("<img");
	} finally {
		setFaceProfiles([]);
	}
});

test("a picture that will not load gives way to the guess from the login, then to the initial", () => {
	let sources = faceSources("nora_acme", 24, STORED);
	expect(sources).toEqual([STORED, "https://github.com/nora_acme.png?size=48"]);

	let photo = { failed: [] as readonly string[] };
	expect(photoSource(sources, photo)).toBe(STORED);

	photo = nextPhoto(photo, { kind: "failed", source: STORED });
	expect(photoSource(sources, photo)).toBe("https://github.com/nora_acme.png?size=48");

	photo = nextPhoto(photo, { kind: "failed", source: "https://github.com/nora_acme.png?size=48" });
	expect(photoSource(sources, photo)).toBeUndefined();
	expect(photoShown(photo, undefined)).toBe(false);
});

test("a picture learned after the guess was tried is tried in its turn, and a loaded one is shown", () => {
	let guess = "https://github.com/ivy_acme.png?size=48";
	let photo = nextPhoto({ failed: [] }, { kind: "failed", source: guess });
	// The cache learned the stored URL later: it is the first source again, not yet failed.
	let sources = faceSources("ivy_acme", 24, STORED);
	expect(photoSource(sources, photo)).toBe(STORED);

	photo = nextPhoto(photo, { kind: "loaded", source: STORED });
	expect(photoShown(photo, photoSource(sources, photo))).toBe(true);
	// Another source in its place is not shown until it has loaded itself.
	expect(photoShown(photo, guess)).toBe(false);
});
