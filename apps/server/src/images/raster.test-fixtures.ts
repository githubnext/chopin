import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

export function fixture(name: string): Uint8Array {
	return new Uint8Array(
		readFileSync(new URL(`../../../../e2e/fixtures/${name}`, import.meta.url)),
	);
}

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

function u32(...values: number[]): Uint8Array {
	let out = new Uint8Array(values.length * 4);
	values.forEach((value, index) => new DataView(out.buffer).setUint32(index * 4, value));
	return out;
}

export function apng(width: number, height: number): Uint8Array {
	let frame = (sequence: number) =>
		chunk(
			"fcTL",
			join([
				u32(sequence, width, height, 0, 0),
				new Uint8Array([0, 1, 0, 10, 0, 0]),
			]),
		);
	let data = pixels(width, height);
	return join([
		new Uint8Array(SIGNATURE),
		header(width, height),
		chunk("acTL", u32(2, 0)),
		frame(0),
		chunk("IDAT", data),
		frame(1),
		chunk("fdAT", join([u32(2), data])),
		chunk("IEND", new Uint8Array()),
	]);
}
