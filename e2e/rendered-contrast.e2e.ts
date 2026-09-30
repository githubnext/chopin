import { expect, test } from "@playwright/test";

import { textContrast } from "./rendered-contrast";

test("contrast measurement composites nested opacity and shadow-root surfaces", async ({ page }) => {
	await page.setContent(`
		<body style="background: white">
			<p id="opaque" style="color: black">Opaque text</p>
			<div style="opacity: .5">
				<p id="half" style="color: black">Half-opacity text</p>
				<div style="opacity: .5"><p id="quarter" style="color: black">Quarter text</p></div>
			</div>
			<div id="host" style="background: black"></div>
		</body>
	`);
	await page.locator("#host").evaluate(element => {
		let shadow = element.attachShadow({ mode: "open" });
		let text = document.createElement("span");
		text.id = "shadow";
		text.style.color = "white";
		text.textContent = "Shadow text";
		shadow.append(text);
	});
	expect(await textContrast(page.locator("#opaque"))).toBeCloseTo(21, 2);
	expect(await textContrast(page.locator("#half"))).toBeCloseTo(3.976, 2);
	expect(await textContrast(page.locator("#quarter"))).toBeCloseTo(1.834, 2);
	expect(await textContrast(page.locator("#shadow"))).toBeCloseTo(21, 2);
});
