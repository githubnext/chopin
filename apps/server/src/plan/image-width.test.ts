import { describe, expect, it } from "bun:test";
import { $getRoot, $isElementNode } from "lexical";
import * as Y from "yjs";

import { $isImageNode, parse, serialize } from "@chopin/dialect";
import { peer } from "../testing/peer";
import * as room from "./room";

const HOSTED = `/images/${"a".repeat(64)}.png`;
const IMAGE = `<Image src="${HOSTED}" alt="Chart" width="320" />\n`;
const ID = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const ID2 = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const ID3 = "01K0N4W3B7P27CBAEC7A8C8WEA";

describe("durable image widths", () => {
	it("passes the server semantic roundtrip for standalone, inline, and nested images", () => {
		for (
			let source of [
				IMAGE,
				`Before ${IMAGE.trim()} after.\n`,
				`${IMAGE.trim()} after.\n`,
				`Before ${IMAGE}`,
				`<Callout id="${ID}" type="note">\n\n${IMAGE}\nCaption.\n\n</Callout>\n`,
				`<Columns id="${ID}">\n<Column id="${ID2}">\n\n${IMAGE}\nCaption.\n\n</Column>\n`
				+ `<Column id="${ID3}">\n\nOther.\n\n</Column>\n</Columns>\n`,
			]
		) {
			expect(() => room.validate(serialize(parse(source)))).not.toThrow();
		}
	});

	it("accepts a resize through Yjs, restores its journal, and reopens its checkpoint", async () => {
		let server = await room.create(IMAGE);
		let client = peer();
		let checkpoint = room.sync(server);
		let restored: room.Document | undefined;
		let reopened: room.Document | undefined;
		try {
			Y.applyUpdate(client.doc, checkpoint, "remote");
			await room.settle();
			let vector = Y.encodeStateVector(client.doc);
			client.editor.update(() => {
				let paragraph = $getRoot().getFirstChild();
				let image = $isElementNode(paragraph) ? paragraph.getFirstChild() : null;
				if (!$isImageNode(image)) throw new Error("missing image");
				image.setWidth(640);
			}, { discrete: true });
			let update = Y.encodeStateAsUpdate(client.doc, vector);
			expect((await room.apply(server, [update])).ok).toBe(true);
			let output = IMAGE.replace('width="320"', 'width="640"');
			expect(room.project(server)).toBe(output);
			restored = await room.restore(server.epoch, checkpoint, IMAGE, [{
				epoch: server.epoch,
				update,
			}]);
			expect(room.project(restored)).toBe(output);
			reopened = await room.restore(restored.epoch, room.sync(restored), output, []);
			expect(room.project(reopened)).toBe(output);
		} finally {
			client.doc.destroy();
			server.doc.destroy();
			restored?.doc.destroy();
			reopened?.doc.destroy();
		}
	});

	it("refuses invalid peer-controlled width state and rebuilds the previous image", async () => {
		for (let width of [-1, 1.5, 4097, "320px", null]) {
			let server = await room.create(IMAGE);
			let client = peer();
			let rebuilt: room.Document | undefined;
			try {
				Y.applyUpdate(client.doc, room.sync(server), "remote");
				await room.settle();
				let key = "";
				client.editor.getEditorState().read(() => {
					let paragraph = $getRoot().getFirstChild();
					let image = $isElementNode(paragraph) ? paragraph.getFirstChild() : null;
					if (!$isImageNode(image)) throw new Error("missing image");
					key = image.getKey();
				});
				let shared = client.binding.collabNodeMap.get(key)?.getSharedType();
				if (!(shared instanceof Y.XmlElement)) throw new Error("missing image shared type");
				let state: unknown = shared.getAttribute("__state");
				if (!(state instanceof Y.Map)) throw new Error("missing image state");
				let vector = Y.encodeStateVector(client.doc);
				state.set("plan-image-width", width);
				let outcome = await room.apply(server, [Y.encodeStateAsUpdate(client.doc, vector)]);
				expect(outcome).toMatchObject({ ok: false, issues: ["bad-attribute-value"] });
				rebuilt = await room.rebuild(server);
				expect(room.project(rebuilt)).toBe(IMAGE);
			} finally {
				client.doc.destroy();
				server.doc.destroy();
				rebuilt?.doc.destroy();
			}
		}
	});
});
