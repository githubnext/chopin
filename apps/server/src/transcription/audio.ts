/**
 * What audio is, from its bytes. Only a recording a browser makes (WebM, Ogg, MP4) or a plain WAV
 * or MP3 is sent to the transcription provider; anything else is refused, whatever it is called.
 */

export type AudioType = "audio/webm" | "audio/ogg" | "audio/wav" | "audio/mp4" | "audio/mpeg";

function at(bytes: Uint8Array, offset: number, text: string): boolean {
	return bytes.length >= offset + text.length
		&& [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

export function sniffAudio(bytes: Uint8Array): AudioType | undefined {
	if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
		return "audio/webm";
	}
	if (at(bytes, 0, "OggS")) return "audio/ogg";
	if (at(bytes, 0, "RIFF") && at(bytes, 8, "WAVE")) return "audio/wav";
	if (at(bytes, 4, "ftyp")) return "audio/mp4";
	if (at(bytes, 0, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) {
		return "audio/mpeg";
	}
	return undefined;
}

const EXTENSIONS: Record<AudioType, string> = {
	"audio/webm": "webm",
	"audio/ogg": "ogg",
	"audio/wav": "wav",
	"audio/mp4": "m4a",
	"audio/mpeg": "mp3",
};

export function audioFileName(type: AudioType): string {
	return `dictation.${EXTENSIONS[type]}`;
}
