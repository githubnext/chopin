import { ChatImage, RefusedImage } from "./image";
import { ImageGallery } from "./image-gallery";
import { galleryItems } from "./image-state";

import type { Chat } from "@chopin/protocol";

export function TurnImages(
	{ images, refused }: {
		images: readonly Chat.Image[] | undefined;
		refused: readonly Chat.ImageRefusal[] | undefined;
	},
) {
	let count = images?.length ?? 0;
	if (count > 1) return <ImageGallery images={images!} refused={refused} />;
	return (
		<>
			{galleryItems(count, refused).map((item, position) =>
				item.kind === "refused"
					? <RefusedImage key={position} reason={item.reason} />
					: <ChatImage image={images![0]!} key={position} />
			)}
		</>
	);
}
