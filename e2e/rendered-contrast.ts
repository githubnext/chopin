import type { Locator } from "@playwright/test";

/** Text on flat surfaces, including ancestor opacity and shadow-root hosts. */
export async function textContrast(locator: Locator): Promise<number> {
	return locator.evaluate(element => {
		let canvas = document.createElement("canvas");
		canvas.width = canvas.height = 1;
		let context = canvas.getContext("2d", { willReadFrequently: true })!;
		type Color = [number, number, number, number];
		let color = (value: string): Color => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = value;
			context.fillRect(0, 0, 1, 1);
			let bytes = context.getImageData(0, 0, 1, 1).data;
			return [bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]! / 255];
		};
		let over = (front: Color, back: Color): Color => {
			let alpha = front[3] + back[3] * (1 - front[3]);
			if (!alpha) return [0, 0, 0, 0];
			return [
				...front.slice(0, 3).map((value, index) =>
					(value * front[3] + back[index]! * back[3] * (1 - front[3])) / alpha
				),
				alpha,
			] as Color;
		};
		let foreground = color(getComputedStyle(element).color);
		let background: Color = [0, 0, 0, 0];
		for (let node: Element | null = element; node;) {
			let style = getComputedStyle(node);
			if (style.backgroundImage !== "none") throw new Error("Contrast requires a flat surface");
			let surface = color(style.backgroundColor);
			foreground = over(foreground, surface);
			background = over(background, surface);
			foreground[3] *= Number(style.opacity);
			background[3] *= Number(style.opacity);
			let root = node.getRootNode();
			node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
		}
		let luminance = (sample: Color) => {
			let channels = over(sample, [255, 255, 255, 1]).slice(0, 3).map(value => {
				let channel = value / 255;
				return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
			});
			return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
		};
		let a = luminance(foreground);
		let b = luminance(background);
		return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
	});
}
