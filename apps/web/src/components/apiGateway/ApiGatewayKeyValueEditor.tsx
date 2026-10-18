import type { ApiGatewayKeyValue } from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";

const BLANK_ROW: ApiGatewayKeyValue = { key: "", value: "", enabled: true };

/**
 * Rows of name and value, each with a switch to leave it out of the request.
 * A blank row always trails the list and becomes a real row once something is
 * typed into it, which is how rows are added.
 */
export function ApiGatewayKeyValueEditor(props: {
  readonly rows: ReadonlyArray<ApiGatewayKeyValue>;
  readonly onChange: (rows: ReadonlyArray<ApiGatewayKeyValue>) => void;
  /** What one row is, as in "header" or "variable". Used in labels. */
  readonly noun: string;
  readonly keyPlaceholder: string;
}) {
  const { rows, noun } = props;
  const update = (index: number, patch: Partial<ApiGatewayKeyValue>) => {
    const next = { ...(rows[index] ?? BLANK_ROW), ...patch };
    props.onChange(
      index < rows.length ? rows.map((row, at) => (at === index ? next : row)) : [...rows, next],
    );
  };

  return (
    <div className="flex flex-col gap-1">
      {[...rows, BLANK_ROW].map((row, index) => {
        const isTrailing = index === rows.length;
        return (
          // oxlint-disable-next-line react/no-array-index-key -- A row is nothing but its position, and the trailing row must keep its inputs, and their focus, as it turns real.
          <div key={index} className="flex items-center gap-1.5">
            <Checkbox
              className={isTrailing ? "invisible" : undefined}
              checked={row.enabled}
              disabled={isTrailing}
              onCheckedChange={(enabled) => update(index, { enabled })}
              aria-label={`Send ${noun} ${index + 1}`}
            />
            <Input
              size="compact"
              font="mono"
              className="min-w-0 flex-1"
              value={row.key}
              onChange={(event) => update(index, { key: event.target.value })}
              placeholder={props.keyPlaceholder}
              spellCheck={false}
              autoComplete="off"
              aria-label={`Name of ${noun} ${index + 1}`}
            />
            <Input
              size="compact"
              font="mono"
              className="min-w-0 flex-2"
              value={row.value}
              onChange={(event) => update(index, { value: event.target.value })}
              placeholder="Value"
              spellCheck={false}
              autoComplete="off"
              aria-label={`Value of ${noun} ${index + 1}`}
            />
            <Button
              type="button"
              size="icon-micro"
              variant="ghost-muted"
              className={isTrailing ? "invisible" : undefined}
              disabled={isTrailing}
              onClick={() => props.onChange(rows.filter((_, at) => at !== index))}
              aria-label={`Remove ${noun} ${index + 1}`}
            >
              <XIcon />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
