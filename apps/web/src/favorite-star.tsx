import { StarIcon } from "@chopin/icons";

import "./favorite-star.css";

import type { KeyboardEvent } from "react";

/**
 * The favorite machine's star, a toggle of its own: filled on the person's favorite, which
 * Automatic prefers, and an outline that sets it on any other machine. Its name says what pressing
 * it does. In the machine menu it sits over its row's right end; on a touch screen its target
 * reaches 44px.
 */
export function FavoriteStar(
	{ label, favorite, onToggle, menu = false, touch = false, onKeyDown }: {
		label: string;
		favorite: boolean;
		onToggle: () => void;
		/** In the machine menu, over the right end of the machine's row. */
		menu?: boolean;
		touch?: boolean;
		onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
	},
) {
	return (
		<button
			aria-label={favorite ? `Remove ${label} as favorite` : `Favorite ${label}`}
			aria-pressed={favorite}
			className={menu ? "favorite-star machine-menu-star" : "favorite-star"}
			data-favorite={favorite || undefined}
			data-star=""
			data-touch={touch || undefined}
			onClick={onToggle}
			onKeyDown={onKeyDown}
			type="button"
		>
			<StarIcon aria-hidden="true" filled={favorite} size={14} />
		</button>
	);
}
