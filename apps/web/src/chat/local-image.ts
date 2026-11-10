export type LocalImageFetch = (url: string, init: RequestInit) => Promise<Response>;

type Raster = {
	type: string;
	named: readonly string[];
	is(head: Uint8Array): boolean;
};

function text(head: Uint8Array, offset: number, expected: string): boolean {
	return head.length >= offset + expected.length
		&& [...expected].every((letter, index) => head[offset + index] === letter.charCodeAt(0));
}

function starts(head: Uint8Array, expected: number[]): boolean {
	return head.length >= expected.length && expected.every((value, index) => head[index] === value);
}

function big(head: Uint8Array, offset: number): number {
	return ((head[offset] ?? 0) * 0x1000000) + ((head[offset + 1] ?? 0) << 16)
		+ ((head[offset + 2] ?? 0) << 8) + (head[offset + 3] ?? 0);
}

function little(head: Uint8Array, offset: number, length: number): number {
	let value = 0;
	for (let index = length - 1; index >= 0; index--) {
		value = value * 256 + (head[offset + index] ?? 0);
	}
	return value;
}

function avif(head: Uint8Array): boolean {
	if (!text(head, 4, "ftyp")) return false;
	let end = Math.min(big(head, 0), head.length);
	for (let offset = 8; offset + 4 <= end; offset += offset === 8 ? 8 : 4) {
		if (text(head, offset, "avif") || text(head, offset, "avis")) return true;
	}
	return false;
}

const RASTERS: readonly Raster[] = [
	{
		type: "image/png",
		named: ["image/png", "image/apng", "image/x-png"],
		is: head => starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	},
	{
		type: "image/jpeg",
		named: ["image/jpeg", "image/jpg", "image/pjpeg"],
		is: head => starts(head, [0xff, 0xd8, 0xff]),
	},
	{
		type: "image/gif",
		named: ["image/gif"],
		is: head => text(head, 0, "GIF87a") || text(head, 0, "GIF89a"),
	},
	{
		type: "image/webp",
		named: ["image/webp"],
		is: head => text(head, 0, "RIFF") && text(head, 8, "WEBP"),
	},
	{ type: "image/avif", named: ["image/avif"], is: avif },
	{
		type: "image/bmp",
		named: ["image/bmp", "image/x-bmp", "image/x-ms-bmp"],
		is: head => text(head, 0, "BM") && [12, 40, 52, 56, 64, 108, 124].includes(little(head, 14, 4)),
	},
	{
		type: "image/x-icon",
		named: ["image/x-icon", "image/vnd.microsoft.icon", "image/ico"],
		is: head => starts(head, [0, 0, 1, 0]) && little(head, 4, 2) > 0,
	},
];

export const RASTER_TYPE_NAMES: readonly string[] = RASTERS.flatMap(raster => raster.named);

const HEAD_BYTES = 64;

/**
 * Whoever writes a message chooses its image addresses, so one on this site is read with no
 * credentials, and drawn only if the bytes are the raster image the answer says they are.
 */
export async function loadLocalImage(
	address: string,
	{ base, fetcher = fetch, signal }: {
		base: string;
		fetcher?: LocalImageFetch;
		signal?: AbortSignal;
	},
): Promise<Blob> {
	let response = await fetcher(new URL(address, base).href, {
		credentials: "omit",
		headers: { accept: "image/*" },
		mode: "same-origin",
		referrerPolicy: "no-referrer",
		signal,
	});
	let named = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
	let declared = RASTERS.find(raster => raster.named.includes(named));
	if (!response.ok || !declared) {
		await response.body?.cancel();
		throw new Error(
			response.ok
				? `The address answered ${named || "no type"}, not an image.`
				: `The address answered ${response.status}.`,
		);
	}
	let body = await response.blob();
	let head = new Uint8Array(await body.slice(0, HEAD_BYTES).arrayBuffer());
	if (!declared.is(head)) throw new Error(`The address's bytes are not ${declared.type}.`);
	return new Blob([body], { type: declared.type });
}
