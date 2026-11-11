type Node = {
	type: string;
	alt?: string | null;
	url?: string;
	value?: string;
	data?: { hName?: string; hProperties?: Record<string, string> };
	children?: Node[];
};

function lift(node: Node): void {
	if (!node.children) return;
	node.children = node.children.flatMap(child => {
		lift(child);
		if (child.type !== "link" || !child.children?.some(item => item.type === "image")) {
			return [child];
		}
		let images = child.children.filter(item => item.type === "image");
		let rest = child.children.filter(item => item.type !== "image");
		let label: Node[] = rest.length
			? rest
			: [{ type: "text", value: images.find(item => item.alt)?.alt ?? child.url ?? "" }];
		return [...images, { ...child, children: label }];
	});
}

/** Lifts images out of links, which would otherwise wrap the image's own buttons and swallow its click. */
export function imagesOutOfLinksRemarkPlugin() {
	return (tree: Node) => lift(tree);
}

let isImage = (node: Node) => node.type === "image";

let isSpace = (node: Node) => node.type === "break" || node.type === "text" && !node.value?.trim();

let isImageOnly = (node: Node) =>
	node.type === "paragraph" && !!node.children?.some(isImage)
	&& node.children.every(child => isImage(child) || isSpace(child));

function galleries(children: Node[]): Node[] {
	let out: Node[] = [];
	let run: Node[] = [];
	let gap: Node[] = [];
	let end = () => {
		out.push(
			...run.length > 1
				? [{ type: "imageGallery", data: { hName: "figure" }, children: run }]
				: run,
			...gap,
		);
		run = [];
		gap = [];
	};
	for (let child of children) {
		if (isImage(child)) {
			gap = run.length ? [] : gap;
			run.push(child);
		} else if (isSpace(child) && run.length) {
			gap.push(child);
		} else {
			end();
			out.push(child);
		}
	}
	end();
	return out;
}

function gather(node: Node): void {
	if (!node.children) return;
	let blocks: Node[] = [];
	for (let child of node.children) {
		let last = blocks.at(-1);
		if (last && isImageOnly(last) && isImageOnly(child)) {
			last.children = [...last.children!, ...child.children!];
		} else {
			blocks.push(child);
		}
	}
	blocks.forEach(gather);
	node.children = galleries(blocks);
}

export function imageGalleriesRemarkPlugin() {
	return (tree: Node) => gather(tree);
}

function markImageBlocks(node: Node): void {
	node.children?.forEach(markImageBlocks);
	if (
		(node.type === "paragraph" || node.type === "heading")
		&& node.children?.some(child => child.type === "image" || child.type === "imageGallery")
	) {
		node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataChatImageBlock: "" } };
	}
}

/** Marks a paragraph or heading that holds an image, which a `p` may not: Chat draws it as a `div`. */
export function imageBlocksRemarkPlugin() {
	return (tree: Node) => markImageBlocks(tree);
}
