import type { ComponentPropsWithoutRef } from "react";

type AuthoritativeSlot = { "data-slot"?: string };

export type TableVariant = "plain" | "contained";
export type TableProps =
	& ComponentPropsWithoutRef<"table">
	& AuthoritativeSlot
	& { "data-variant"?: string; variant?: TableVariant };
export type TableHeaderProps = ComponentPropsWithoutRef<"thead"> & AuthoritativeSlot;
export type TableBodyProps = ComponentPropsWithoutRef<"tbody"> & AuthoritativeSlot;
export type TableFooterProps = ComponentPropsWithoutRef<"tfoot"> & AuthoritativeSlot;
export type TableRowProps = ComponentPropsWithoutRef<"tr"> & AuthoritativeSlot;
export type TableHeadProps = ComponentPropsWithoutRef<"th"> & AuthoritativeSlot;
export type TableCellProps = ComponentPropsWithoutRef<"td"> & AuthoritativeSlot;

function classes(base: string, className?: string) {
	return [base, className].filter(Boolean).join(" ");
}

function Table({
	className,
	"data-slot": _slot,
	"data-variant": _dataVariant,
	variant = "plain",
	...props
}: TableProps) {
	return (
		<div data-slot="table-container" className="cv-table-container" data-variant={variant}>
			<table
				{...props}
				className={classes("cv-table", className)}
				data-slot="table"
				data-variant={variant}
			/>
		</div>
	);
}

function TableHeader({ className, "data-slot": _slot, ...props }: TableHeaderProps) {
	return (
		<thead className={classes("cv-table-header", className)} data-slot="table-header" {...props} />
	);
}

function TableBody({ className, "data-slot": _slot, ...props }: TableBodyProps) {
	return (
		<tbody
			className={classes("cv-table-body", className)}
			data-slot="table-body"
			{...props}
		/>
	);
}

function TableFooter({ className, "data-slot": _slot, ...props }: TableFooterProps) {
	return (
		<tfoot className={classes("cv-table-footer", className)} data-slot="table-footer" {...props} />
	);
}

function TableRow({ className, "data-slot": _slot, ...props }: TableRowProps) {
	return <tr className={classes("cv-table-row", className)} data-slot="table-row" {...props} />;
}

function TableHead({ className, "data-slot": _slot, ...props }: TableHeadProps) {
	return <th className={classes("cv-table-head", className)} data-slot="table-head" {...props} />;
}

function TableCell({ className, "data-slot": _slot, ...props }: TableCellProps) {
	return <td className={classes("cv-table-cell", className)} data-slot="table-cell" {...props} />;
}

export { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow };
