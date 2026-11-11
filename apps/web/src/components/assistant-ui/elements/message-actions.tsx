"use client";

import type { ComponentProps, ReactElement, ReactNode } from "react";
import {
  CheckIcon,
  CopyIcon,
  EllipsisIcon,
  RefreshCwIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ghostButton, iconSwap, iconSwapIn, iconSwapOut } from "./surfaces";

export type Reaction = "up" | "down" | null;

export interface MessageActionItem {
  key: string;
  label: string;
  pressed?: boolean;
  onClick?: () => void;
  buttonProps?: Omit<
    ComponentProps<"button">,
    | "aria-label"
    | "aria-pressed"
    | "children"
    | "className"
    | "key"
    | "onClick"
    | "type"
  >;
  children: ReactNode;
}

export interface MessageActionsProps extends Omit<
  ComponentProps<"div">,
  "children"
> {
  copied?: boolean;
  reaction?: Reaction;
  regenerating?: boolean;
  onCopy?: () => void;
  onReactionChange?: (reaction: Reaction) => void;
  onRegenerate?: () => void;
  onMore?: () => void;
  items?: readonly MessageActionItem[];
  moreProps?: Omit<
    ComponentProps<"button">,
    "children" | "className" | "onClick" | "type"
  >;
  renderMore?: (button: ReactElement<ComponentProps<"button">>) => ReactNode;
  renderCopy?: (icons: ReactNode) => ReactNode;
}

export function MessageActions({
  copied = false,
  reaction = null,
  regenerating = false,
  onCopy,
  onReactionChange,
  onRegenerate,
  onMore,
  items,
  moreProps,
  renderMore,
  renderCopy,
  className,
  ...props
}: MessageActionsProps) {
  const buttonClassName = cn(ghostButton, "size-7");
  let copyIcons: ReactNode;

  const content = (
    <div
      data-slot="message-actions"
      className={cn("flex items-center gap-1", className)}

      {...props}
    >
      {(() => {
        const button = (
      <button
        type="button"
        aria-label={copied ? "Copied response" : "Copy response"}
        onClick={onCopy}
        className={cn(
          buttonClassName,
          "grid place-items-center",
          copied && "text-emerald-500",
        )}
      >
        {(copyIcons = (
          <>
        <CopyIcon
          className={cn(
            iconSwap,
            "size-3.5",
            copied ? iconSwapOut : iconSwapIn,
          )}
        />
        <CheckIcon
          className={cn(
            iconSwap,
            "size-3.5",
            copied ? iconSwapIn : iconSwapOut,
          )}
        />
          </>
        ))}
      </button>
        );
        return items ? null : button;
      })()}
      {(items ?? [undefined]).map((item, index) => {
        const pressed = item ? item.pressed : reaction === "up";
        return (
      <button
        key={item?.key ?? index}
        type="button"
        aria-label={item ? item.label : "Mark response helpful"}
        aria-pressed={pressed}
        onClick={
          item
            ? item.onClick
            : () => onReactionChange?.(reaction === "up" ? null : "up")
        }
        {...item?.buttonProps}
        className={cn(
          buttonClassName,
          (item ? item.pressed : reaction === "up") &&
            "bg-foreground/[0.06] text-foreground/90 dark:bg-foreground/[0.09]",
        )}
      >
        {item ? (
          item.children
        ) : (
        <ThumbsUpIcon className="size-3.5" />
        )}
      </button>
        );
      })}
      {!items && (
        <>
      <button
        type="button"
        aria-label="Mark response unhelpful"
        aria-pressed={reaction === "down"}
        onClick={() => onReactionChange?.(reaction === "down" ? null : "down")}
        className={cn(
          buttonClassName,
          reaction === "down" &&
            "bg-foreground/[0.06] text-foreground/90 dark:bg-foreground/[0.09]",
        )}
      >
        <ThumbsDownIcon className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Regenerate response"
        onClick={onRegenerate}
        className={buttonClassName}
      >
        <RefreshCwIcon
          className={cn(
            "size-3.5",
            regenerating && "animate-spin motion-reduce:animate-none",
          )}
        />
      </button>
        </>
      )}
      {(renderMore ?? ((more) => more))(
      <button
        type="button"
        aria-label="More response actions"
        onClick={onMore}
        {...moreProps}
        className={buttonClassName}
      >
        <EllipsisIcon className="size-3.5" />
      </button>
      )}
    </div>
  );
  return renderCopy ? <>{renderCopy(copyIcons)}</> : content;
}
