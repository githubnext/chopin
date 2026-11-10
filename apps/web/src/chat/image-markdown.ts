type Node = {
	type: string;
	alt?: string | null;
	url?: string;
	value?: string;
	data?: { hProperties?: Record<string, string> };
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

function markImageBlocks(node: Node): void {
	node.children?.forEach(markImageBlocks);
	if (
		(node.type === "paragraph" || node.type === "heading")
		&& node.children?.some(child => child.type === "image")
	) {
		node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataChatImageBlock: "" } };
	}
}

/** Marks a paragraph or heading that holds an image, which a `p` may not: Chat draws it as a `div`. */
export function imageBlocksRemarkPlugin() {
	return (tree: Node) => markImageBlocks(tree);
}
