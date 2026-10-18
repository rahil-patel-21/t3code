import {
  API_GATEWAY_MAX_RESPONSE_BYTES,
  type ApiGatewayBodyCutOff,
  type ApiGatewayExecuteResult,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useMemo, useState } from "react";

import type { ApiGatewayRun } from "~/apiGatewayStore";
import { ReadOnlySourcePreview } from "~/components/files/AttachmentFilePreview";
import { FileSurfaceNotice } from "~/components/files/fileSurfaceChrome";
import { formatBytes } from "~/lib/formatBytes";

import { MessageCopyButton } from "../chat/MessageCopyButton";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { Table, TableBody, TableCell, TableRow } from "../ui/table";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  API_GATEWAY_RESPONSE_DISPLAY_MAX_CHARS,
  apiGatewayResponseContent,
  apiGatewayStatusLabel,
  apiGatewayStatusTone,
  type ApiGatewayTone,
} from "./apiGateway.logic";

const CUT_OFF_NOTICES: Record<ApiGatewayBodyCutOff, string> = {
  size: `The response was longer than ${API_GATEWAY_MAX_RESPONSE_BYTES / (1024 * 1024)} MB. This is its start.`,
  timeout: "The response was still arriving when the timeout ran out. This is what came.",
  connection: "The connection closed before the response was finished. This is what came.",
};

const STATUS_BADGE_VARIANT = {
  success: "success",
  info: "info",
  warning: "warning",
  error: "error",
  muted: "outline",
} as const satisfies Record<ApiGatewayTone, string>;

function ResponseResult(props: {
  readonly result: ApiGatewayExecuteResult;
  readonly unresolved: ReadonlyArray<string>;
}) {
  const { result } = props;
  const [section, setSection] = useState<"body" | "headers">("body");
  const [showRaw, setShowRaw] = useState(false);
  const content = useMemo(() => apiGatewayResponseContent(result), [result]);
  const text =
    content.kind === "text" ? (showRaw ? content.text : (content.pretty ?? content.text)) : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/60 px-3 py-1.5">
        <Badge variant={STATUS_BADGE_VARIANT[apiGatewayStatusTone(result.status)]}>
          {apiGatewayStatusLabel(result.status)}
        </Badge>
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatDuration(result.totalMs)}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatBytes(result.body.bytes)}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {section === "body" && content.kind === "text" && content.pretty !== null ? (
            <ToggleGroup
              aria-label="Body format"
              value={[showRaw ? "raw" : "pretty"]}
              onValueChange={(next) => {
                if (next[0] === "raw" || next[0] === "pretty") setShowRaw(next[0] === "raw");
              }}
            >
              <Toggle value="pretty">Pretty</Toggle>
              <Toggle value="raw">Raw</Toggle>
            </ToggleGroup>
          ) : null}
          <ToggleGroup
            aria-label="Response sections"
            value={[section]}
            onValueChange={(next) => {
              if (next[0] === "body" || next[0] === "headers") setSection(next[0]);
            }}
          >
            <Toggle value="body">Body</Toggle>
            <Toggle value="headers">{`Headers (${result.headers.length})`}</Toggle>
          </ToggleGroup>
          {content.kind === "text" ? (
            <MessageCopyButton
              text={text}
              label="Copy response body"
              size="icon-xs"
              variant="ghost"
            />
          ) : null}
        </div>
      </div>

      {props.unresolved.length > 0 ? (
        <FileSurfaceNotice>
          {`Sent with placeholders that had no value: ${props.unresolved
            .map((name) => `{{${name}}}`)
            .join(", ")}`}
        </FileSurfaceNotice>
      ) : null}
      {result.body.cutOff === null ? null : (
        <FileSurfaceNotice>{CUT_OFF_NOTICES[result.body.cutOff]}</FileSurfaceNotice>
      )}

      {section === "headers" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* After redirects this is not the URL the request was sent to. */}
          <p className="border-b border-border/60 px-3 py-1.5 text-xs break-all text-muted-foreground">
            Response from <span className="font-mono text-foreground">{result.url}</span>
          </p>
          <Table className="table-fixed">
            <TableBody>
              {result.headers.map((header, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- Header names repeat (set-cookie) and a response's headers never reorder.
                <TableRow key={`${index}:${header.name}`}>
                  <TableCell className="w-1/3 align-top whitespace-normal break-all">
                    <span className="font-mono text-muted-foreground">{header.name}</span>
                  </TableCell>
                  <TableCell className="align-top whitespace-normal break-all">
                    <span className="font-mono">{header.value}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : content.kind === "text" ? (
        <>
          {text.length > API_GATEWAY_RESPONSE_DISPLAY_MAX_CHARS ? (
            <FileSurfaceNotice>
              Only the start of this body is shown. Copy takes all of it.
            </FileSurfaceNotice>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col">
            <ReadOnlySourcePreview
              name={content.fileName}
              text={text.slice(0, API_GATEWAY_RESPONSE_DISPLAY_MAX_CHARS)}
            />
          </div>
        </>
      ) : content.kind === "image" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          <img src={content.src} alt="Response body" className="max-h-full max-w-full" />
        </div>
      ) : (
        <p className="p-4 text-xs text-muted-foreground">
          {content.kind === "empty"
            ? "The response has no body."
            : "The body is binary and cannot be shown as text."}
        </p>
      )}
    </div>
  );
}

/** The outcome of a tab's latest send: waiting, a response, or why there is none. */
export function ApiGatewayResponse(props: {
  readonly run: ApiGatewayRun | undefined;
  readonly onCancel: () => void;
}) {
  const { run } = props;
  if (run === undefined) {
    return (
      <Empty className="flex-1" size="compact">
        <EmptyHeader>
          <EmptyTitle>No response yet</EmptyTitle>
          <EmptyDescription>Send the request to see what comes back.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (run.phase === "sending") {
    return (
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center gap-3 text-xs text-muted-foreground"
      >
        <Spinner size="sm" />
        Sending…
        <Button type="button" size="compact" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    );
  }
  if (run.phase === "failed") {
    return (
      <div
        role="alert"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center"
      >
        <p className="text-sm font-medium text-foreground">{run.title}</p>
        <p className="max-w-full break-words font-mono text-xs text-muted-foreground">
          {run.message}
        </p>
      </div>
    );
  }
  return <ResponseResult result={run.result} unresolved={run.unresolved} />;
}
