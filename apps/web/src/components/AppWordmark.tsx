import { APP_BASE_NAME } from "../branding";
import { cn } from "../lib/utils";
import { resolveAppWordmarkParts } from "./AppWordmark.logic";
import { T3Wordmark } from "./T3Wordmark";

/**
 * The product lockup: the T3 glyph followed by the rest of the name, or plain text
 * once a fork renames the product. Decorative by default, because the surrounding
 * title or aria-label already carries the accessible name and announcing the
 * lockup separately would read the product out twice.
 */
export function AppWordmark({
  className,
  wordmarkClassName,
  captionClassName,
}: {
  readonly className?: string;
  readonly wordmarkClassName?: string;
  readonly captionClassName?: string;
}) {
  const { usesT3Glyph, caption } = resolveAppWordmarkParts(APP_BASE_NAME);

  return (
    <span aria-hidden className={cn("inline-flex min-w-0 items-baseline", className)}>
      {usesT3Glyph ? <T3Wordmark className={cn("w-auto shrink-0", wordmarkClassName)} /> : null}
      {caption ? <span className={cn("min-w-0 truncate", captionClassName)}>{caption}</span> : null}
    </span>
  );
}
