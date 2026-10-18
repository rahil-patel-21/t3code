import {
  API_GATEWAY_MAX_NAME_LENGTH,
  ApiGatewayVariableSet,
  ApiGatewayVariableSetId,
  type ApiGatewayItemId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { ensureLocalApi } from "~/localApi";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { ApiGatewayFolderOption } from "./apiGateway.logic";
import { ApiGatewayKeyValueEditor } from "./ApiGatewayKeyValueEditor";

const TOP_LEVEL = "top-level";
const NEW_COLLECTION = "new-collection";

export interface ApiGatewayItemDialogLocation {
  readonly options: ReadonlyArray<ApiGatewayFolderOption>;
  /** The folder selected when the dialog opens. Null selects the top level. */
  readonly initial: ApiGatewayItemId | null;
  /** True for a folder, which may sit at the top level as a collection. */
  readonly allowTopLevel: boolean;
}

/** Where the dialog puts the item. */
export type ApiGatewayItemDialogTarget =
  | { readonly kind: "top" }
  | { readonly kind: "folder"; readonly id: ApiGatewayItemId }
  /** A collection to create for the item, since a request needs a folder and there may be none. */
  | { readonly kind: "newCollection"; readonly name: string };

/**
 * Asks for an item's name and, when `location` is given, the folder it goes
 * in. Without a location the target is always `top`, and the caller knows
 * where the item goes. Mount it while it is open; closing unmounts it.
 */
export function ApiGatewayItemDialog(props: {
  readonly title: string;
  readonly submitLabel: string;
  readonly initialName: string;
  readonly location: ApiGatewayItemDialogLocation | null;
  /** Resolves true once the change is stored, which closes the dialog. */
  readonly onSubmit: (name: string, target: ApiGatewayItemDialogTarget) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const { location } = props;
  const formId = useId();
  const nameId = useId();
  const collectionNameId = useId();
  const [name, setName] = useState(props.initialName);
  const [selected, setSelected] = useState<string>(
    location === null
      ? TOP_LEVEL
      : (location.initial ??
          (location.allowTopLevel ? TOP_LEVEL : (location.options[0]?.id ?? NEW_COLLECTION))),
  );
  const [collectionName, setCollectionName] = useState("My collection");
  const [isSaving, setIsSaving] = useState(false);

  // A folder another client deleted while this was open is no longer a place to go.
  const folder = location?.options.find((option) => option.id === selected);
  const target: ApiGatewayItemDialogTarget | null =
    selected === TOP_LEVEL
      ? { kind: "top" }
      : selected === NEW_COLLECTION
        ? { kind: "newCollection", name: collectionName.trim() }
        : folder === undefined
          ? null
          : { kind: "folder", id: folder.id };
  const canSubmit =
    name.trim() !== "" &&
    target !== null &&
    (target.kind !== "newCollection" || target.name !== "") &&
    !isSaving;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // A save in flight finishes by closing the dialog, so it cannot be closed under it.
        if (!open && !isSaving) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSubmit || target === null) return;
              setIsSaving(true);
              void props.onSubmit(name.trim(), target).then((stored) => {
                if (stored) props.onClose();
                else setIsSaving(false);
              });
            }}
          >
            <fieldset className="space-y-4" disabled={isSaving}>
              <div className="space-y-1.5">
                <Label htmlFor={nameId}>Name</Label>
                <Input
                  id={nameId}
                  autoFocus
                  value={name}
                  maxLength={API_GATEWAY_MAX_NAME_LENGTH}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              {location === null ? null : (
                <div className="space-y-1.5">
                  <Label>Location</Label>
                  <Select
                    value={selected}
                    onValueChange={(value) => {
                      if (value !== null) setSelected(value);
                    }}
                  >
                    <SelectTrigger aria-label="Location">
                      <SelectValue>
                        {selected === TOP_LEVEL
                          ? "Top level"
                          : selected === NEW_COLLECTION
                            ? "New collection…"
                            : (folder?.label ?? "Choose a folder")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {location.allowTopLevel ? (
                        <SelectItem value={TOP_LEVEL}>Top level</SelectItem>
                      ) : null}
                      {location.options.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                        </SelectItem>
                      ))}
                      {location.allowTopLevel ? null : (
                        <SelectItem value={NEW_COLLECTION}>New collection…</SelectItem>
                      )}
                    </SelectPopup>
                  </Select>
                </div>
              )}
              {selected === NEW_COLLECTION ? (
                <div className="space-y-1.5">
                  <Label htmlFor={collectionNameId}>Collection name</Label>
                  <Input
                    id={collectionNameId}
                    value={collectionName}
                    maxLength={API_GATEWAY_MAX_NAME_LENGTH}
                    onChange={(event) => setCollectionName(event.target.value)}
                  />
                </div>
              ) : null}
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" disabled={isSaving} onClick={props.onClose}>
            Cancel
          </Button>
          <Button form={formId} type="submit" disabled={!canSubmit}>
            {props.submitLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const sameVariableSet = Schema.toEquivalence(ApiGatewayVariableSet);

const newVariableSet = (): ApiGatewayVariableSet => ({
  id: ApiGatewayVariableSetId.make(randomUUID()),
  name: "New variable set",
  variables: [],
});

/**
 * Creates and edits the environment's variable sets, one at a time. Edits stay
 * in the dialog until Save; leaving a set with edits asks first.
 */
export function ApiGatewayVariablesDialog(props: {
  readonly variableSets: ReadonlyArray<ApiGatewayVariableSet>;
  /** The set to open on, typically the one requests are being sent with. */
  readonly initialId: ApiGatewayVariableSetId | null;
  /** Both resolve true once the server has the change. */
  readonly onSave: (variableSet: ApiGatewayVariableSet) => Promise<boolean>;
  readonly onDelete: (variableSet: ApiGatewayVariableSet) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const nameId = useId();
  const [draft, setDraft] = useState<ApiGatewayVariableSet>(
    () =>
      props.variableSets.find((set) => set.id === props.initialId) ??
      props.variableSets[0] ??
      newVariableSet(),
  );
  const [isSaving, setIsSaving] = useState(false);
  const saved = props.variableSets.find((set) => set.id === draft.id);
  const isDirty = saved === undefined || !sameVariableSet(saved, draft);
  // A new set counts as edited once it has variables; its default name alone is nothing to lose.
  const hasEdits = saved === undefined ? draft.variables.length > 0 : isDirty;

  const confirmLeaving = async () =>
    !hasEdits ||
    ensureLocalApi().dialogs.confirm(
      `Discard changes to "${draft.name}"?\nThey have not been saved.`,
    );

  const switchTo = async (next: ApiGatewayVariableSet) => {
    if (next.id !== draft.id && (await confirmLeaving())) setDraft(next);
  };

  const close = async () => {
    if (!isSaving && (await confirmLeaving())) props.onClose();
  };

  const run = (change: Promise<boolean>, afterwards?: () => void) => {
    setIsSaving(true);
    void change.then((stored) => {
      setIsSaving(false);
      if (stored) afterwards?.();
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Variable sets</DialogTitle>
          <DialogDescription>
            A request can use {"{{name}}"} anywhere, and the set you send with fills it in. Keep one
            set per place you call, such as Local and Production.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset className="space-y-4" disabled={isSaving}>
            <div className="flex items-center gap-2">
              <Select
                value={draft.id}
                onValueChange={(id) => {
                  const next = props.variableSets.find((set) => set.id === id);
                  if (next) void switchTo(next);
                }}
              >
                <SelectTrigger aria-label="Variable set" className="min-w-0 flex-1">
                  <SelectValue>{saved === undefined ? "Not saved yet" : saved.name}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {props.variableSets.map((set) => (
                    <SelectItem key={set.id} value={set.id}>
                      {set.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                type="button"
                variant="outline"
                onClick={() => void switchTo(newVariableSet())}
              >
                <PlusIcon />
                New set
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                value={draft.name}
                maxLength={API_GATEWAY_MAX_NAME_LENGTH}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Variables</Label>
              <ApiGatewayKeyValueEditor
                rows={draft.variables}
                onChange={(variables) => setDraft({ ...draft, variables })}
                noun="variable"
                keyPlaceholder="name"
              />
            </div>
          </fieldset>
        </DialogPanel>
        <DialogFooter variant="bare">
          {saved === undefined ? null : (
            <Button
              type="button"
              variant="destructive-outline"
              className="mr-auto"
              disabled={isSaving}
              onClick={() =>
                run(props.onDelete(saved), () =>
                  setDraft(
                    props.variableSets.find((set) => set.id !== saved.id) ?? newVariableSet(),
                  ),
                )
              }
            >
              Delete set
            </Button>
          )}
          <Button type="button" variant="outline" disabled={isSaving} onClick={() => void close()}>
            Close
          </Button>
          <Button
            type="button"
            disabled={isSaving || !isDirty || draft.name.trim() === ""}
            onClick={() => {
              const next = { ...draft, name: draft.name.trim() };
              setDraft(next);
              run(props.onSave(next));
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
