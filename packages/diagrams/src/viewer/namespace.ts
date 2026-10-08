/** Renderer fragments are trusted output, but their SVG definitions use fixed names. */
export function namespaceSvgIds(body: string, prefix: string): string {
	let ids = new Map<string, string>();
	let namespaced = body.replace(/(\s)id="([^"]+)"/g, (_match, space: string, id: string) => {
		let scoped = `${prefix}-${id}`;
		ids.set(id, scoped);
		return `${space}id="${scoped}"`;
	});

	namespaced = namespaced.replace(
		/url\(#([^)]+)\)/g,
		(match, id: string) => ids.has(id) ? `url(#${ids.get(id)})` : match,
	);
	namespaced = namespaced.replace(
		/(\s(?:href|xlink:href))="#([^"]+)"/g,
		(match, attr: string, id: string) => ids.has(id) ? `${attr}="#${ids.get(id)}"` : match,
	);
	namespaced = namespaced.replace(
		/(\saria-(?:labelledby|describedby))="([^"]+)"/g,
		(_match, attr: string, value: string) => {
			let refs = value.split(/\s+/).map((id) => ids.get(id) ?? id).join(" ");
			return `${attr}="${refs}"`;
		},
	);
	return namespaced;
}
