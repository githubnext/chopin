/**
 * A file's type as Slack draws it: a rounded square in the type's colour, with its glyph in white.
 * The colours are Chopin's roles (`media.css`), never Slack's own; the glyphs are Chopin's icons.
 */

import {
	FileAudioIcon,
	FileCodeIcon,
	FileIcon,
	FileImageIcon,
	FilePdfIcon,
	FileSheetIcon,
	FileTextIcon,
	FileVideoIcon,
	FileZipIcon,
	SlidesIcon,
} from "@chopin/icons";

import type { IconProps } from "@chopin/icons";
import type { ReactElement } from "react";
import type { FileKind } from "./layout";

const GLYPHS: Record<FileKind, (props: IconProps) => ReactElement> = {
	pdf: FilePdfIcon,
	document: FileTextIcon,
	spreadsheet: FileSheetIcon,
	slides: SlidesIcon,
	code: FileCodeIcon,
	text: FileTextIcon,
	archive: FileZipIcon,
	image: FileImageIcon,
	video: FileVideoIcon,
	audio: FileAudioIcon,
	generic: FileIcon,
};

export function FileKindIcon({ kind }: { kind: FileKind }) {
	let Glyph = GLYPHS[kind];
	return (
		<span aria-hidden="true" className="chat-file-icon" data-file-kind={kind}>
			<Glyph size={24} />
		</span>
	);
}
