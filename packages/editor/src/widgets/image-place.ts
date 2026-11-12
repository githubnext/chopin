import { createContext } from "react";

/**
 * Where an image is, for the image viewer's header: the document's title, or "a thread in" it.
 * Its own module, so the page that provides it does not load the viewer.
 */
export const ImagePlace = createContext<string | undefined>(undefined);
