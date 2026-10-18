import {
  API_GATEWAY_PLACEHOLDER,
  isApiGatewayRowSent,
  parseCurlCommand,
  withApiGatewayQuery,
  withApiGatewayUrl,
} from "@t3tools/client-runtime/api-gateway";
import {
  API_GATEWAY_MAX_TIMEOUT_MS,
  ApiGatewayHttpMethod,
  apiGatewayMethodSendsBody,
  type ApiGatewayAuth,
  type ApiGatewayAuthType,
  type ApiGatewayBody,
  type ApiGatewayBodyMode,
  type ApiGatewayKeyValue,
  type ApiGatewayRawLanguage,
  type ApiGatewayRequest,
} from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { isMacPlatform } from "~/lib/utils";

import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { apiGatewayFormatJson } from "./apiGateway.logic";
import { ApiGatewayKeyValueEditor } from "./ApiGatewayKeyValueEditor";
import { ApiGatewayMethodLabel } from "./ApiGatewayMethodLabel";

type Section = "params" | "headers" | "auth" | "body" | "settings";

const SECTIONS: ReadonlyArray<readonly [Section, string]> = [
  ["params", "Params"],
  ["headers", "Headers"],
  ["auth", "Auth"],
  ["body", "Body"],
  ["settings", "Settings"],
];

const AUTH_LABELS: Record<ApiGatewayAuthType, string> = {
  none: "No auth",
  bearer: "Bearer token",
  basic: "Basic auth",
  apiKey: "API key",
};

const BODY_MODE_LABELS: Record<ApiGatewayBodyMode, string> = {
  none: "None",
  raw: "Raw",
  urlencoded: "Form URL-encoded",
  multipart: "Multipart form",
};

const RAW_LANGUAGE_LABELS: Record<ApiGatewayRawLanguage, string> = {
  json: "JSON",
  text: "Text",
  xml: "XML",
  html: "HTML",
};

/** Narrows a toggle group's value, which is typed loosely, to one of the labelled keys. */
const isKeyOf = <K extends string>(labels: Record<K, string>, value: unknown): value is K =>
  typeof value === "string" && value in labels;

const sentCount = (rows: ReadonlyArray<ApiGatewayKeyValue>) =>
  rows.filter(isApiGatewayRowSent).length;

/** A labelled row. The control inside names itself, since a row can hold more than one. */
function Field(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-24 shrink-0 text-muted-foreground">{props.label}</span>
      {props.children}
    </div>
  );
}

function AuthSection(props: {
  readonly auth: ApiGatewayAuth;
  readonly onChange: (auth: ApiGatewayAuth) => void;
}) {
  const { auth } = props;
  const set = (patch: Partial<ApiGatewayAuth>) => props.onChange({ ...auth, ...patch });
  return (
    <div className="flex max-w-xl flex-col gap-2">
      <Field label="Type">
        <Select
          value={auth.type}
          onValueChange={(type) => {
            if (type !== null) set({ type });
          }}
        >
          <SelectTrigger size="compact" className="w-40" aria-label="Auth type">
            <SelectValue>{AUTH_LABELS[auth.type]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {Object.entries(AUTH_LABELS).map(([type, label]) => (
              <SelectItem key={type} value={type}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      {auth.type === "bearer" ? (
        <Field label="Token">
          <Input
            size="compact"
            font="mono"
            className="min-w-0 flex-1"
            value={auth.bearerToken}
            onChange={(event) => set({ bearerToken: event.target.value })}
            placeholder="{{token}}"
            spellCheck={false}
            autoComplete="off"
            aria-label="Bearer token"
          />
        </Field>
      ) : null}
      {auth.type === "basic" ? (
        <>
          <Field label="Username">
            <Input
              size="compact"
              font="mono"
              className="min-w-0 flex-1"
              value={auth.basicUsername}
              onChange={(event) => set({ basicUsername: event.target.value })}
              spellCheck={false}
              autoComplete="off"
              aria-label="Username"
            />
          </Field>
          <Field label="Password">
            <Input
              size="compact"
              font="mono"
              className="min-w-0 flex-1"
              type="password"
              value={auth.basicPassword}
              onChange={(event) => set({ basicPassword: event.target.value })}
              autoComplete="off"
              aria-label="Password"
            />
          </Field>
        </>
      ) : null}
      {auth.type === "apiKey" ? (
        <>
          <Field label="Name">
            <Input
              size="compact"
              font="mono"
              className="min-w-0 flex-1"
              value={auth.apiKeyName}
              onChange={(event) => set({ apiKeyName: event.target.value })}
              placeholder="X-API-Key"
              spellCheck={false}
              autoComplete="off"
              aria-label="API key name"
            />
          </Field>
          <Field label="Value">
            <Input
              size="compact"
              font="mono"
              className="min-w-0 flex-1"
              value={auth.apiKeyValue}
              onChange={(event) => set({ apiKeyValue: event.target.value })}
              placeholder="{{apiKey}}"
              spellCheck={false}
              autoComplete="off"
              aria-label="API key value"
            />
          </Field>
          <Field label="Send in">
            <ToggleGroup
              aria-label="Where the API key is sent"
              value={[auth.apiKeyIn]}
              onValueChange={(next) => {
                if (next[0] === "header" || next[0] === "query") set({ apiKeyIn: next[0] });
              }}
            >
              <Toggle value="header">Header</Toggle>
              <Toggle value="query">Query string</Toggle>
            </ToggleGroup>
          </Field>
        </>
      ) : null}
      {auth.type === "none" ? null : (
        <p className="text-2xs text-muted-foreground">
          A header with the same name under Headers is sent instead of this one.
        </p>
      )}
    </div>
  );
}

/** Past this, checking the body on every keystroke would make typing in it lag. */
const JSON_CHECK_MAX_LENGTH = 200_000;

/**
 * Whether the body parses once its placeholders are filled. They are not JSON
 * themselves, so each stands in as a value while the rest is judged.
 */
function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text.replace(API_GATEWAY_PLACEHOLDER, "0"));
    return true;
  } catch {
    return false;
  }
}

function BodySection(props: {
  readonly body: ApiGatewayBody;
  /** False for methods that carry no body, where the content is kept but not sent. */
  readonly isSent: boolean;
  readonly onChange: (body: ApiGatewayBody) => void;
}) {
  const { body } = props;
  const set = (patch: Partial<ApiGatewayBody>) => props.onChange({ ...body, ...patch });
  const isJson = body.mode === "raw" && body.rawLanguage === "json";
  const invalidJson =
    isJson &&
    body.raw.trim() !== "" &&
    body.raw.length <= JSON_CHECK_MAX_LENGTH &&
    !parsesAsJson(body.raw);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          aria-label="Body type"
          value={[body.mode]}
          onValueChange={(next) => {
            if (isKeyOf(BODY_MODE_LABELS, next[0])) set({ mode: next[0] });
          }}
        >
          {Object.entries(BODY_MODE_LABELS).map(([mode, label]) => (
            <Toggle key={mode} value={mode}>
              {label}
            </Toggle>
          ))}
        </ToggleGroup>
        {body.mode === "raw" ? (
          <>
            <Select
              value={body.rawLanguage}
              onValueChange={(rawLanguage) => {
                if (rawLanguage !== null) set({ rawLanguage });
              }}
            >
              <SelectTrigger size="compact" className="w-24 min-w-0" aria-label="Body language">
                <SelectValue>{RAW_LANGUAGE_LABELS[body.rawLanguage]}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {Object.entries(RAW_LANGUAGE_LABELS).map(([language, label]) => (
                  <SelectItem key={language} value={language}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {isJson ? (
              <Button
                type="button"
                size="compact"
                variant="ghost"
                disabled={invalidJson || body.raw.trim() === ""}
                onClick={() => {
                  // Checked again here: a body too long to check while typing is not checked then.
                  const formatted = parsesAsJson(body.raw) ? apiGatewayFormatJson(body.raw) : null;
                  if (formatted !== null) set({ raw: formatted });
                }}
              >
                Format
              </Button>
            ) : null}
            {invalidJson ? (
              <span className="text-2xs text-warning-foreground">Not valid JSON</span>
            ) : null}
          </>
        ) : null}
        {!props.isSent && body.mode !== "none" ? (
          <span className="text-2xs text-muted-foreground">
            Not sent: GET and HEAD requests carry no body.
          </span>
        ) : null}
      </div>
      {body.mode === "raw" ? (
        <textarea
          className="min-h-24 w-full flex-1 resize-none rounded-md border border-input bg-background px-2.5 py-2 font-mono text-xs text-foreground outline-none placeholder:text-placeholder focus-visible:border-ring dark:bg-input/32"
          value={body.raw}
          onChange={(event) => set({ raw: event.target.value })}
          placeholder={body.rawLanguage === "json" ? '{\n  "name": "{{name}}"\n}' : "Request body"}
          spellCheck={false}
          aria-label="Request body"
        />
      ) : null}
      {body.mode === "urlencoded" || body.mode === "multipart" ? (
        <ApiGatewayKeyValueEditor
          rows={body.form}
          onChange={(form) => set({ form })}
          noun="field"
          keyPlaceholder="Field"
        />
      ) : null}
      {body.mode === "none" ? (
        <p className="text-xs text-muted-foreground">This request has no body.</p>
      ) : null}
    </div>
  );
}

function SettingsSection(props: {
  readonly request: ApiGatewayRequest;
  readonly onChange: (request: ApiGatewayRequest) => void;
}) {
  const { request } = props;
  return (
    <div className="flex max-w-xl flex-col gap-2">
      <Field label="Follow redirects">
        <Switch
          size="sm"
          checked={request.followRedirects}
          onCheckedChange={(followRedirects) => props.onChange({ ...request, followRedirects })}
          aria-label="Follow redirects"
        />
      </Field>
      {request.followRedirects ? (
        <p className="text-2xs text-muted-foreground">
          A redirect to another site receives this request&apos;s headers and body too. Only
          Authorization and Cookie headers are left behind.
        </p>
      ) : null}
      <Field label="Timeout">
        <DraftInput
          size="compact"
          font="mono"
          className="w-20"
          inputMode="decimal"
          value={String(request.timeoutMs / 1000)}
          onCommit={(text) => {
            const seconds = Number(text);
            if (!Number.isFinite(seconds) || seconds <= 0) return;
            props.onChange({
              ...request,
              timeoutMs: Math.min(
                Math.max(Math.round(seconds * 1000), 1),
                API_GATEWAY_MAX_TIMEOUT_MS,
              ),
            });
          }}
          aria-label="Timeout in seconds"
        />
        <span className="text-muted-foreground">seconds</span>
      </Field>
    </div>
  );
}

/**
 * One request's method, URL, and everything sent with it. Holds no request
 * state of its own: every edit goes out through `onChange`. Send and Save are
 * also bound to keys, by the page, so they work wherever focus is on it.
 */
export function ApiGatewayRequestEditor(props: {
  /** The tab being edited. A new tab with no URL yet takes focus in its URL field. */
  readonly tabId: string;
  readonly request: ApiGatewayRequest;
  readonly onChange: (request: ApiGatewayRequest) => void;
  readonly isSending: boolean;
  /** True when there is something Save would write. */
  readonly canSave: boolean;
  /** Set when the tab has edits over a saved request that can be thrown away. */
  readonly onRevert: (() => void) | null;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly onCopyAsCurl: () => void;
}) {
  const { request, onChange } = props;
  const [section, setSection] = useState<Section>("params");
  const canSend = request.url.trim() !== "";
  const modifier = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl+";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex shrink-0 items-center gap-1.5 px-3 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend && !props.isSending) props.onSend();
        }}
      >
        <Select
          value={request.method}
          onValueChange={(method) => {
            if (method !== null) onChange({ ...request, method });
          }}
        >
          <SelectTrigger size="compact" className="w-24 min-w-0 shrink-0" aria-label="HTTP method">
            <SelectValue>
              <ApiGatewayMethodLabel method={request.method} />
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {ApiGatewayHttpMethod.literals.map((method) => (
              <SelectItem key={method} value={method}>
                <ApiGatewayMethodLabel method={method} />
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Input
          // A fresh field per tab, so a new tab can take focus as it opens.
          key={props.tabId}
          autoFocus={request.url === ""}
          size="compact"
          font="mono"
          className="min-w-0 flex-1"
          value={request.url}
          onChange={(event) => onChange(withApiGatewayUrl(request, event.target.value))}
          onPaste={(event) => {
            // A pasted curl command is a whole request, not text for the URL.
            const text = event.clipboardData.getData("text");
            const imported = /^\s*curl\s/.test(text) ? parseCurlCommand(text) : null;
            if (imported === null) return;
            event.preventDefault();
            onChange(imported);
          }}
          placeholder="Enter a URL or paste a curl command"
          spellCheck={false}
          autoComplete="off"
          aria-label="Request URL"
        />
        {props.isSending ? (
          <Button type="button" size="compact" variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button type="submit" size="compact" disabled={!canSend}>
                  Send
                </Button>
              }
            />
            <TooltipPopup>{`Send (${modifier}Enter)`}</TooltipPopup>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="compact"
                variant="outline"
                disabled={!props.canSave}
                onClick={props.onSave}
              >
                Save
              </Button>
            }
          />
          <TooltipPopup>{`Save (${modifier}S)`}</TooltipPopup>
        </Tooltip>
        <Menu>
          <MenuTrigger
            render={
              <Button type="button" size="icon-sm" variant="ghost" aria-label="More actions" />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem disabled={!canSend} onClick={props.onCopyAsCurl}>
              Copy as curl
            </MenuItem>
            {props.onRevert ? (
              <MenuItem onClick={props.onRevert}>Discard unsaved changes</MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </form>

      <div className="flex shrink-0 px-3 py-2">
        <ToggleGroup
          aria-label="Request sections"
          value={[section]}
          onValueChange={(next) => {
            const chosen = SECTIONS.find(([key]) => key === next[0]);
            if (chosen) setSection(chosen[0]);
          }}
        >
          {SECTIONS.map(([key, label]) => {
            const count =
              key === "params"
                ? sentCount(request.query)
                : key === "headers"
                  ? sentCount(request.headers)
                  : 0;
            return (
              <Toggle key={key} value={key}>
                {count > 0 ? `${label} (${count})` : label}
              </Toggle>
            );
          })}
        </ToggleGroup>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
        {section === "params" ? (
          <ApiGatewayKeyValueEditor
            rows={request.query}
            onChange={(query) => onChange(withApiGatewayQuery(request, query))}
            noun="parameter"
            keyPlaceholder="Parameter"
          />
        ) : null}
        {section === "headers" ? (
          <ApiGatewayKeyValueEditor
            rows={request.headers}
            onChange={(headers) => onChange({ ...request, headers })}
            noun="header"
            keyPlaceholder="Header"
          />
        ) : null}
        {section === "auth" ? (
          <AuthSection auth={request.auth} onChange={(auth) => onChange({ ...request, auth })} />
        ) : null}
        {section === "body" ? (
          <BodySection
            body={request.body}
            isSent={apiGatewayMethodSendsBody(request.method)}
            onChange={(body) => onChange({ ...request, body })}
          />
        ) : null}
        {section === "settings" ? <SettingsSection request={request} onChange={onChange} /> : null}
      </div>
    </div>
  );
}
