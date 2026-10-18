import type { ApiGatewayHttpMethod } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { apiGatewayMethodTone, type ApiGatewayTone } from "./apiGateway.logic";

export const API_GATEWAY_TONE_TEXT: Record<ApiGatewayTone, string> = {
  success: "text-success-foreground",
  info: "text-info-foreground",
  warning: "text-warning-foreground",
  error: "text-destructive-foreground",
  muted: "text-muted-foreground",
};

const SHORT_NAMES: Partial<Record<ApiGatewayHttpMethod, string>> = {
  DELETE: "DEL",
  OPTIONS: "OPT",
};

/** The method in its color. `short` abbreviates the long ones to fit a narrow column. */
export function ApiGatewayMethodLabel(props: {
  readonly method: ApiGatewayHttpMethod;
  readonly short?: boolean;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "font-mono text-3xs font-semibold",
        API_GATEWAY_TONE_TEXT[apiGatewayMethodTone(props.method)],
        props.className,
      )}
    >
      {props.short ? (SHORT_NAMES[props.method] ?? props.method) : props.method}
    </span>
  );
}
