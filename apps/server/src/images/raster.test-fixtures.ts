import { deflateSync } from "node:zlib";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, data: Uint8Array): Uint8Array {
	let out = new Uint8Array(12 + data.length);
	let view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
	return out;
}

function join(parts: Uint8Array[]): Uint8Array {
	let out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let at = 0;
	for (let part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

function header(width: number, height: number): Uint8Array {
	let data = new Uint8Array(13);
	let view = new DataView(data.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	data.set([8, 2, 0, 0, 0], 8);
	return chunk("IHDR", data);
}

function pixels(width: number, height: number): Uint8Array {
	return new Uint8Array(deflateSync(new Uint8Array(height * (1 + width * 3))));
}

export function bigPng(size: number, width = 40, height = 30): Uint8Array {
	let rest = join([
		new Uint8Array(SIGNATURE),
		header(width, height),
		chunk("IDAT", pixels(width, height)),
		chunk("IEND", new Uint8Array()),
	]);
	let filler = new Uint8Array(size - rest.length - 12);
	filler.set(new TextEncoder().encode("Comment\0"));
	return join([
		new Uint8Array(SIGNATURE),
		header(width, height),
		chunk("tEXt", filler),
		chunk("IDAT", pixels(width, height)),
		chunk("IEND", new Uint8Array()),
	]);
}
