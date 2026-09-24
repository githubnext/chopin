import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from "@chopin/visuals";
import type {
	TableBodyProps,
	TableCaptionProps,
	TableCellProps,
	TableFooterProps,
	TableHeaderProps,
	TableHeadProps,
	TableProps,
	TableRowProps,
} from "@chopin/visuals";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

test("exports the complete native presentation table API", () => {
	let table: TableProps = { variant: "contained" };
	let header: TableHeaderProps = {};
	let body: TableBodyProps = {};
	let footer: TableFooterProps = {};
	let row: TableRowProps = {};
	let head: TableHeadProps = { scope: "col" };
	let cell: TableCellProps = { headers: "status" };
	let caption: TableCaptionProps = {};

	expect([
		Table,
		TableHeader,
		TableBody,
		TableFooter,
		TableRow,
		TableHead,
		TableCell,
		TableCaption,
	].every(component => typeof component === "function")).toBe(true);
	expect(table.variant).toBe("contained");
	expect([header, body, footer, row, head, cell, caption]).toHaveLength(7);
});

test(
	"renders native table elements with authoritative slots and forwarded semantic attributes",
	() => {
		let markup = renderToStaticMarkup(
			<Table
				aria-label="Deployment activity"
				className="custom-table"
				data-example="activity"
				data-slot="ignored-table"
				data-variant="plain"
				id="activity-table"
				variant="contained"
			>
				<TableCaption className="custom-caption" data-slot="ignored-caption">
					Deployment activity by environment
				</TableCaption>
				<TableHeader className="custom-header" data-slot="ignored-header">
					<TableRow className="custom-row" data-slot="ignored-row">
						<TableHead data-slot="ignored-head" id="environment" scope="col">
							Environment
						</TableHead>
						<TableHead id="status" scope="col">
							Status
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody className="custom-body" data-slot="ignored-body">
					<TableRow>
						<TableCell data-slot="ignored-cell" headers="environment">
							Production
						</TableCell>
						<TableCell headers="status">Healthy</TableCell>
					</TableRow>
				</TableBody>
				<TableFooter className="custom-footer" data-slot="ignored-footer">
					<TableRow>
						<TableCell colSpan={2}>2 environments</TableCell>
					</TableRow>
				</TableFooter>
			</Table>,
		);

		expect(markup.startsWith('<div data-slot="table-container"')).toBe(true);
		expect(markup).toContain('<table aria-label="Deployment activity"');
		expect(markup).toContain('class="cv-table custom-table"');
		expect(markup).toContain('data-example="activity"');
		expect(markup).toContain('data-slot="table"');
		expect(markup).not.toContain('data-slot="ignored-table"');
		expect(markup).toContain('data-variant="contained"');
		expect(markup).not.toContain('data-variant="plain"');
		expect(markup).toContain('id="activity-table"');
		expect(markup).toContain(
			'<caption class="cv-table-caption custom-caption" data-slot="table-caption"',
		);
		expect(markup).toContain(
			'<thead class="cv-table-header custom-header" data-slot="table-header"',
		);
		expect(markup).toContain('<tbody class="cv-table-body custom-body" data-slot="table-body"');
		expect(markup).toContain(
			'<tfoot class="cv-table-footer custom-footer" data-slot="table-footer"',
		);
		expect(markup).toContain('<tr class="cv-table-row custom-row" data-slot="table-row"');
		expect(markup).toContain(
			'<th class="cv-table-head" data-slot="table-head" id="environment" scope="col"',
		);
		expect(markup).toContain(
			'<td class="cv-table-cell" data-slot="table-cell" headers="environment"',
		);
		expect(markup).toContain('colSpan="2"');
		for (let ignored of ["caption", "header", "body", "footer", "row", "head", "cell"]) {
			expect(markup).not.toContain(`data-slot="ignored-${ignored}"`);
		}
	},
);

test("defaults to plain and supports the contained presentation variant", () => {
	let plain = renderToStaticMarkup(<Table />);
	let contained = renderToStaticMarkup(<Table variant="contained" />);

	expect(plain).toContain('data-slot="table"');
	expect(plain).toContain('data-variant="plain"');
	expect(contained).toContain('data-slot="table"');
	expect(contained).toContain('data-variant="contained"');
});

test("uses the existing type and colour tokens in a horizontal overflow container", async () => {
	let css = await Bun.file(new URL("./table.css", import.meta.url)).text();
	let styles = await Bun.file(new URL("../styles.css", import.meta.url)).text();

	expect(styles).toContain('@import "./ui/table.css";');
	expect(css).toContain("max-width: 100%;");
	expect(css).toContain("overflow-x: auto;");
	expect(css).toContain("width: 100%;");
	expect(css).toContain("border-collapse: collapse;");
	expect(css).toContain("font-size: var(--text-sm);");
	expect(css).toContain("line-height: var(--text-sm--line-height);");
	expect(css).toContain("color: var(--color-text-primary);");
	expect(css).toContain("color: var(--color-text-secondary);");
	expect(css).toContain("border-color: var(--color-edge);");
	expect(css).not.toMatch(/#[\da-f]{3,8}|(?:oklch|rgb|hsl)\(/i);
});
