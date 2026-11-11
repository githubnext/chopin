"use client";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  ImageOffIcon,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { safeHref } from "../utils/href";
import { clamp } from "../utils/range";
import { field, ghostButton, mono } from "./surfaces";

export interface GalleryImage {
  id: string;
  src: string;
  alt: string;
  caption?: string | undefined;
  source?: { label?: string | undefined; url?: string | undefined } | undefined;
  failed?: boolean | undefined;
  failedLabel?: string | undefined;
  failedChildren?: ReactNode | undefined;
  pending?: boolean | undefined;
  tileProps?:
    | Omit<
        ComponentProps<"button"> & ComponentProps<"div">,
        "children" | "className" | "style"
      >
    | undefined;
  imgProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
}

export interface ImageGalleryProps extends Omit<
  ComponentProps<"div">,
  "children"
> {
  images: readonly GalleryImage[];
  maxVisible?: number | undefined;
  onOpen?: ((id: string) => void) | undefined;
  activeId?: string | null | undefined;
  onActiveIdChange?: ((id: string | null) => void) | undefined;
  onTileOpen?: ((id: string, trigger: HTMLButtonElement) => void) | undefined;
  hideGrid?: boolean | undefined;
  between?: ((beforeIndex: number) => ReactNode) | undefined;
  dialogActions?:
    | ((image: GalleryImage, index: number) => ReactNode)
    | undefined;
}

const keyForImage = (image: GalleryImage) => `${image.id}\u0000${image.src}`;

export function ImageGallery({
  images,
  maxVisible = 6,
  onOpen,
  activeId: controlledActiveId,
  onActiveIdChange,
  onTileOpen,
  hideGrid,
  between,
  dialogActions,
  className,
  ...props
}: ImageGalleryProps) {
  const [uncontrolledActiveId, setUncontrolledActiveId] = useState<
    string | null
  >(null);
  const activeId =
    controlledActiveId !== undefined
      ? controlledActiveId
      : uncontrolledActiveId;
  const setActiveId = useCallback(
    (next: string | null) => {
      if (controlledActiveId === undefined) setUncontrolledActiveId(next);
      onActiveIdChange?.(next);
    },
    [controlledActiveId, onActiveIdChange],
  );
  const [failedImages, setFailedImages] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const previousRef = useRef<HTMLButtonElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const index = images.findIndex((image) => image.id === activeId);
  if (activeId !== null && index === -1 && controlledActiveId === undefined) {
    setUncontrolledActiveId(null);
  }
  const activeImage = index === -1 ? undefined : images[index];
  const sourceHref = safeHref(activeImage?.source?.url);
  const visibleCount = Math.floor(clamp(maxVisible, 1, images.length));
  const visibleImages = images.slice(0, visibleCount);

  const close = useCallback(() => {
    setActiveId(null);
    triggerRef.current?.focus();
  }, []);

  const focusDialog = useCallback((node: HTMLDivElement | null) => {
    node?.closest<HTMLElement>('[role="dialog"]')?.focus();
  }, []);

  const show = useCallback(
    (nextIndex: number) => {
      const image = images[nextIndex];
      if (!image) return;
      const focused = document.activeElement;
      if (nextIndex === 0 && focused === previousRef.current) {
        nextRef.current?.focus();
      } else if (
        nextIndex === images.length - 1 &&
        focused === nextRef.current
      ) {
        previousRef.current?.focus();
      }
      setActiveId(image.id);
    },
    [images, setActiveId],
  );

  useEffect(() => {
    if (activeImage === undefined) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        show(index - 1);
      } else if (event.key === "ArrowRight" && index < images.length - 1) {
        event.preventDefault();
        show(index + 1);
      }
    };
    // The dialog stops keydown propagation, so only a capture listener sees the arrows.
    document.addEventListener("keydown", onKeyDown, true);

    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [activeImage, images.length, index, show]);

  const open = (nextIndex: number, trigger: HTMLButtonElement) => {
    const image = images[nextIndex];
    if (!image) return;
    if (onTileOpen) {
      onTileOpen(image.id, trigger);
      onOpen?.(image.id);
      return;
    }
    triggerRef.current = trigger;
    setActiveId(image.id);
    onOpen?.(image.id);
  };

  const markFailed = (image: GalleryImage) => {
    const key = keyForImage(image);
    setFailedImages((current) =>
      current.has(key) ? current : new Set(current).add(key),
    );
  };

  if (images.length === 0 && !between) return null;

  return (
    <>
      {!hideGrid ? (
    <div
      data-slot="image-gallery"
      className={cn("@container w-full max-w-md", className)}
      {...props}
    >
      <div className="grid grid-cols-2 gap-2 @sm:grid-cols-3">
        {visibleImages.map((image, imageIndex) => {
          const failed =
            Boolean(image.failed) || failedImages.has(keyForImage(image));
          const overflow =
            imageIndex === visibleCount - 1 && images.length > visibleCount;
          const TileTag = failed && image.failedLabel ? "div" : "button";

          return (
            <Fragment key={image.id}>
              {between?.(imageIndex)}
            <TileTag
              type={TileTag === "button" ? "button" : undefined}
              role={TileTag === "div" ? "img" : undefined}
              aria-label={
                failed && image.failedLabel
                  ? image.failedLabel
                  : `Open image: ${image.alt}`
              }
              onClick={
                TileTag === "button"
                  ? (event) =>
                      open(imageIndex, event.currentTarget as HTMLButtonElement)
                  : undefined
              }
              {...image.tileProps}
              className={cn(
                field,
                "focus-visible:ring-foreground/30 relative aspect-square overflow-hidden rounded-xl transition-[transform,background-color] duration-150 outline-none hover:scale-[1.01] focus-visible:ring-1 active:scale-[0.98] motion-reduce:transition-none",
              )}
            >
              {failed ? (
                <span className="text-muted-foreground flex size-full items-center justify-center">
                  <ImageOffIcon aria-hidden className="size-6" />
                  {image.failedChildren}
                </span>
              ) : image.pending ? null : (
                <img
                  src={image.src}
                  alt={image.alt}
                  loading="lazy"
                  className="size-full object-cover"
                  onError={() => markFailed(image)}
                  {...image.imgProps}
                />
              )}
              {overflow ? (
                <span className="bg-foreground/65 text-background absolute inset-0 flex items-center justify-center text-lg font-medium">
                  +{images.length - visibleCount}
                </span>
              ) : null}
            </TileTag>
            </Fragment>
          );
        })}
        {between?.(visibleImages.length)}
      </div>
    </div>
      ) : null}
      {activeImage ? (
        <Dialog
          open
          onOpenChange={(nextOpen: boolean) => {
            if (!nextOpen) close();
          }}
        >
          <DialogContent className="gap-3 p-3 duration-150 motion-reduce:animate-none sm:max-w-[min(56rem,calc(100%-2rem))]">
            <DialogTitle className="sr-only">
              Image {index + 1} of {images.length}
            </DialogTitle>
            <div
              ref={focusDialog}
              className="flex min-h-0 items-center justify-center px-10"
            >
              {Boolean(activeImage.failed) ||
              failedImages.has(keyForImage(activeImage)) ? (
                <div className="text-muted-foreground flex h-[min(75vh,32rem)] w-full items-center justify-center">
                  <ImageOffIcon aria-hidden className="size-8" />
                </div>
              ) : (
                <img
                  src={activeImage.src}
                  alt={activeImage.alt}
                  className="max-h-[75vh] max-w-full object-contain"
                  onError={() => markFailed(activeImage)}
                  {...activeImage.imgProps}
                />
              )}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <button
                ref={previousRef}
                type="button"
                aria-label="Previous image"
                disabled={index === 0}
                onClick={() => show(index - 1)}
                className={cn(
                  ghostButton,
                  "size-8 shrink-0 disabled:pointer-events-none disabled:opacity-30",
                )}
              >
                <ChevronLeftIcon aria-hidden className="size-4" />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                {activeImage.caption ? (
                  <p className="text-foreground/75 truncate">
                    {activeImage.caption}
                  </p>
                ) : null}
                {activeImage.source?.label ? (
                  sourceHref ? (
                    <a
                      href={sourceHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground/80 flex min-w-0 items-center gap-1 truncate transition-colors"
                    >
                      <span className="truncate">
                        {activeImage.source.label}
                      </span>
                      <ExternalLinkIcon
                        aria-hidden
                        className="size-3 shrink-0"
                      />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  ) : (
                    <span className="text-muted-foreground truncate">
                      {activeImage.source.label}
                    </span>
                  )
                ) : null}
              </div>
              {dialogActions?.(activeImage, index)}
              <span className={cn(mono, "text-muted-foreground shrink-0")}>
                {index + 1} / {images.length}
              </span>
              <button
                ref={nextRef}
                type="button"
                aria-label="Next image"
                disabled={index === images.length - 1}
                onClick={() => show(index + 1)}
                className={cn(
                  ghostButton,
                  "size-8 shrink-0 disabled:pointer-events-none disabled:opacity-30",
                )}
              >
                <ChevronRightIcon aria-hidden className="size-4" />
              </button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
