import { expect, test } from "bun:test";
import { aliasDocumentRoute, keyedDocumentRoute } from "./document-route-view";
import { documentRouteIdentity } from "./document-route-swap";
import type { DocumentRouteIdentity, DocumentRouteIdentitySource } from "./document-route-swap";

let parent = { owner: "org", page: "document", repository: "repo", slug: "original" } as const;
let child = {
	owner: "org",
	page: "child",
	repository: "repo",
	parentSlug: "renamed",
	childSlug: "child",
} as const;

test("a child of a canonically renamed parent retains its existing workspace owner", () => {
	let aliases = new Map<DocumentRouteIdentity, DocumentRouteIdentity>();
	let original = keyedDocumentRoute(parent, false, aliases);
	aliasDocumentRoute(aliases, { ...parent, slug: "renamed" }, original.key);
	expect(keyedDocumentRoute(child, false, aliases).key).toBe(original.key);
});

test("a direct child canonicalization and later parent rename retain the owner on return", () => {
	let aliases = new Map<DocumentRouteIdentity, DocumentRouteIdentity>();
	let direct = keyedDocumentRoute({ ...child, parentSlug: "original" }, false, aliases);
	aliasDocumentRoute(aliases, child, direct.key);
	expect(keyedDocumentRoute({ ...parent, slug: "renamed" }, false, aliases).key).toBe(direct.key);
	let latest = { ...child, parentSlug: "renamed-again", childSlug: "child-renamed" };
	aliasDocumentRoute(aliases, latest, direct.key);
	expect(keyedDocumentRoute(latest, false, aliases).key).toBe(direct.key);
	expect(keyedDocumentRoute({ ...parent, slug: latest.parentSlug }, false, aliases).key).toBe(
		direct.key,
	);
	let other: DocumentRouteIdentitySource = { ...parent, slug: "unrelated" };
	expect(keyedDocumentRoute(other, false, aliases).key).toBe(documentRouteIdentity(other));
});

test("a complete child alias takes precedence over its parent's fallback alias", () => {
	let aliases = new Map<DocumentRouteIdentity, DocumentRouteIdentity>();
	let parentKey = documentRouteIdentity(parent);
	let childKey = documentRouteIdentity({ ...child, childSlug: "original-child" });
	aliasDocumentRoute(aliases, { ...parent, slug: child.parentSlug }, parentKey);
	aliases.set(documentRouteIdentity(child), childKey);
	expect(keyedDocumentRoute(child, false, aliases).key).toBe(childKey);
});
