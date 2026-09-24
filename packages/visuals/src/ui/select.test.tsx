import { Select as SelectPrimitive } from "@base-ui/react/select";
import { expect, test } from "bun:test";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

test("delegates selection callbacks and focus return to the Base UI Select root", () => {
	expect(Select).toBe(SelectPrimitive.Root);
});

test("renders an authoritative trigger and value contract with disabled state", () => {
	let markup = renderToStaticMarkup(
		<Select
			defaultValue="active"
			items={[
				{ label: "Active documents", value: "active" },
				{ label: "Archived documents", value: "archived" },
			]}
		>
			<SelectTrigger data-slot="ignored" disabled>
				<SelectValue data-slot="ignored" />
			</SelectTrigger>
		</Select>,
	);

	expect(markup).toContain("<button");
	expect(markup).toContain('data-slot="select-trigger"');
	expect(markup).toContain('data-slot="select-value"');
	expect(markup).not.toContain('data-slot="ignored"');
	expect(markup).toContain("disabled");
	expect(markup).toContain('aria-haspopup="listbox"');
});

test("owns popup, listbox, item, and checkmark slots", () => {
	let content = SelectContent({
		children: <SelectItem value="active">Active documents</SelectItem>,
	});
	expect(isValidElement(content)).toBe(true);

	let positioner = content.props.children;
	let popup = positioner.props.children;
	let listbox = popup.props.children[1];
	expect(popup.props["data-slot"]).toBe("select-popup");
	expect(listbox.props["data-slot"]).toBe("select-listbox");

	let item = SelectItem({ children: "Active documents", "data-slot": "ignored", value: "active" });
	let checkmark = item.props.children[1];
	expect(item.props["data-slot"]).toBe("select-item");
	expect(checkmark.props["data-slot"]).toBe("select-checkmark");
});

test("styles bounded trigger, popup, items, selection, and disabled states", async () => {
	let css = await Bun.file(new URL("./select.css", import.meta.url)).text();
	let styles = await Bun.file(new URL("../styles.css", import.meta.url)).text();

	expect(styles).toContain('@import "./ui/select.css";');
	expect(css).toContain(".cv-select-trigger");
	expect(css).toContain("max-width: 100%;");
	expect(css).toContain("max-width: var(--available-width, calc(100vw - 1rem));");
	expect(css).toContain(".cv-select-popup");
	expect(css).toContain(".cv-select-item");
	expect(css).not.toContain("outline: none");
	expect(css).toContain("[data-selected]");
	expect(css).toContain("[data-disabled]");
	expect(css).not.toMatch(/#[\da-f]{3,8}|(?:oklch|rgb|hsl)\(/i);
});
