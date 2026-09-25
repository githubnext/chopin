import { toHex } from "@chopin/color";
import {
	ColorPopover,
	Sparkline,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@chopin/visuals";
import { useState } from "react";

import { CHOPIN_LIGHT_HUES } from "./color-fixture";
import { AuditPlate } from "./frame";

import type { Oklch, Purpose } from "@chopin/color";
import type { ContrastOption } from "@chopin/visuals";
import type { CSSProperties } from "react";

const GRAY = CHOPIN_LIGHT_HUES.find(hue => hue.name === "gray")!.swatches;
const INITIAL = GRAY.find(swatch => swatch.step === "450")!.value;

const BACKGROUNDS: readonly ContrastOption[] = [
	{ id: "page", label: "Page", value: { l: 1, c: 0, h: 0 } },
	{ id: "ground", label: "Ground", value: GRAY.find(swatch => swatch.step === "150")!.value },
	{ id: "inset", label: "Inset", value: GRAY.find(swatch => swatch.step === "100")!.value },
];

const ROWS = [
	{ document: "Quarterly plan", values: [8, 6, 7, 4], edits: 24 },
	{ document: "Research notes", values: [2, 4, 3, 7], edits: 18 },
	{ document: "Launch brief", values: [5, 5, 5, 5], edits: 12 },
] as const;

export function ColorControls() {
	let [value, setValue] = useState<Oklch>(INITIAL);
	let [purpose, setPurpose] = useState<Purpose>("graphic");
	let [against, setAgainst] = useState("page");
	let previewStyle = { "--color-neutral-graphic": toHex(value) } as CSSProperties;

	return (
		<AuditPlate item="color-popover" title="Color popover">
			<div className="design-audit-color-layout">
				<ColorPopover
					contrast={{
						against,
						onAgainstChange: setAgainst,
						onPurposeChange: setPurpose,
						options: BACKGROUNDS,
						purpose,
					}}
					onChange={setValue}
					previous={INITIAL}
					title="Gray 450"
					value={value}
				/>
				<section aria-label="Sparkline preview" className="design-audit-color-preview">
					<header>
						<h4>Document activity</h4>
					</header>
					<Table aria-label="Document activity preview" style={previewStyle}>
						<TableHeader>
							<TableRow>
								<TableHead scope="col">Document</TableHead>
								<TableHead scope="col">Activity</TableHead>
								<TableHead scope="col">Edits</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{ROWS.map(row => (
								<TableRow key={row.document}>
									<TableCell>{row.document}</TableCell>
									<TableCell>
										<Sparkline
											label={`${row.document} activity`}
											tone="neutral"
											values={row.values}
										/>
									</TableCell>
									<TableCell>{row.edits}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</section>
			</div>
		</AuditPlate>
	);
}
