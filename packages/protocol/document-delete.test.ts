import { describe, expect, it } from "bun:test";

import { mayDeleteDocument } from "./document-delete";

describe("mayDeleteDocument", () => {
	let writer = { push: true, admin: false };
	let admin = { push: true, admin: true };
	let reader = { push: false, admin: false };

	it("lets the creator who can still write delete their document", () => {
		expect(mayDeleteDocument({ createdBy: "U_ana" }, writer, "U_ana")).toBe(true);
		expect(mayDeleteDocument({ createdBy: "U_ana" }, reader, "U_ana")).toBe(false);
	});

	it("lets a repository admin delete anyone's document", () => {
		expect(mayDeleteDocument({ createdBy: "U_ana" }, admin, "U_bo")).toBe(true);
		expect(mayDeleteDocument({ createdBy: "U_ana" }, { push: false, admin: true }, "U_bo"))
			.toBe(true);
	});

	it("leaves other writers to archive", () => {
		expect(mayDeleteDocument({ createdBy: "U_ana" }, writer, "U_bo")).toBe(false);
	});

	it("never deletes a child on its own", () => {
		let child = { createdBy: "U_ana", parentChannelId: "parent" };
		expect(mayDeleteDocument(child, admin, "U_ana")).toBe(false);
	});
});
