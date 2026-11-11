type Node = {
	type: string;
	alt?: string | null;
	identifier?: string;
	title?: string | null;
	url?: string;
	value?: string;
	data?: { hName?: string; hProperties?: Record<string, string> };
	children?: Node[];
};

let isImage = (node: Node) => node.type === "image";

let isLink = (node: Node) => node.type === "link" || node.type === "linkReference";

let hasImage = (node: Node): boolean => isImage(node) || !!node.children?.some(hasImage);

let isVisible = (node: Node): boolean =>
	node.children ? node.children.some(isVisible) : !!node.value?.trim();

function definitions(node: Node, found = new Map<string, Node>()): Map<string, Node> {
	let key = node.type === "definition" ? node.identifier?.toUpperCase() : undefined;
	if (key !== undefined && !found.has(key)) found.set(key, node);
	node.children?.forEach(child => definitions(child, found));
	return found;
}

function resolveImageReferences(tree: Node): void {
	let found = definitions(tree);
	let walk = (node: Node) => {
		if (!node.children) return;
		node.children = node.children.map(child => {
			let definition = child.type === "imageReference"
				? found.get(child.identifier?.toUpperCase() ?? "")
				: undefined;
			if (!definition) {
				walk(child);
				return child;
			}
			return { type: "image", alt: child.alt, title: definition.title, url: definition.url ?? "" };
		});
	};
	walk(tree);
}

function around(node: Node): Node[] {
	if (!node.children || !hasImage(node)) return [node];
	let out: Node[] = [];
	let run: Node[] = [];
	let close = () => {
		if (run.length) out.push({ ...node, children: run });
		run = [];
	};
	for (let piece of node.children.flatMap(around)) {
		if (isImage(piece)) {
			close();
			out.push(piece);
		} else {
			run.push(piece);
		}
	}
	close();
	return out;
}

function lift(node: Node): void {
	if (!node.children) return;
	node.children = node.children.flatMap(child => {
		lift(child);
		if (!isLink(child) || !hasImage(child)) return [child];
		let pieces = around(child).filter(piece => isImage(piece) || isVisible(piece));
		if (pieces.some(piece => !isImage(piece))) return pieces;
		let label = pieces.find(piece => piece.alt)?.alt ?? child.url ?? "";
		return [...pieces, { ...child, children: [{ type: "text", value: label }] }];
	});
}

/** Lifts images out of links, which would otherwise wrap the image's own buttons and swallow its click. */
export function imagesOutOfLinksRemarkPlugin() {
	return (tree: Node) => {
		resolveImageReferences(tree);
		lift(tree);
	};
}

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
	let last: Node | undefined;
	for (let child of node.children) {
		if (child.type === "definition") {
			blocks.push(child);
		} else if (last && isImageOnly(last) && isImageOnly(child)) {
			last.children = [...last.children!, ...child.children!];
		} else {
			blocks.push(child);
			last = child;
		}
	}
	blocks.forEach(gather);
	node.children = galleries(blocks);
}

export function imageGalleriesRemarkPlugin() {
	return (tree: Node) => {
		resolveImageReferences(tree);
		gather(tree);
	};
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
