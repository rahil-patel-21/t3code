import {
  API_GATEWAY_MAX_FOLDER_DEPTH,
  API_GATEWAY_MAX_ITEMS,
  API_GATEWAY_MAX_VARIABLE_SETS,
  type ApiGatewayItem,
  type ApiGatewayItemId,
  type ApiGatewayOperation,
  type ApiGatewayWorkspace,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

/**
 * An item with everything nested under it, and how many levels of folders lie
 * below it: 0 for a request or a folder that holds no folders.
 */
function subtree(
  items: ReadonlyArray<ApiGatewayItem>,
  rootId: ApiGatewayItemId,
): { readonly ids: ReadonlySet<ApiGatewayItemId>; readonly folderLevels: number } {
  // A child can sit before its parent in the list, so the tree is walked by
  // parent rather than read off the order.
  const children = new Map<ApiGatewayItemId, ApiGatewayItem[]>();
  for (const item of items) {
    if (item.parentId === null) continue;
    const siblings = children.get(item.parentId);
    if (siblings) siblings.push(item);
    else children.set(item.parentId, [item]);
  }
  const ids = new Set([rootId]);
  let folderLevels = 0;
  let level = [rootId];
  while (level.length > 0) {
    const folders: ApiGatewayItemId[] = [];
    for (const id of level) {
      for (const child of children.get(id) ?? []) {
        if (ids.has(child.id)) continue;
        ids.add(child.id);
        if (child.kind === "folder") folders.push(child.id);
      }
    }
    if (folders.length > 0) folderLevels += 1;
    level = folders;
  }
  return { ids, folderLevels };
}

/** How deep a folder sits: 1 for a collection. */
function folderDepth(items: ReadonlyArray<ApiGatewayItem>, id: ApiGatewayItemId): number {
  const parentOf = new Map(items.map((item) => [item.id, item.parentId]));
  let depth = 0;
  let current: ApiGatewayItemId | null | undefined = id;
  // Stops past the limit, so a loop in a file edited by hand ends as "too deep".
  while (current !== null && current !== undefined && depth <= API_GATEWAY_MAX_FOLDER_DEPTH) {
    current = parentOf.get(current);
    depth += 1;
  }
  return depth;
}

function putItem(
  items: ReadonlyArray<ApiGatewayItem>,
  item: ApiGatewayItem,
): Result.Result<ReadonlyArray<ApiGatewayItem>, string> {
  const existing = items.find((candidate) => candidate.id === item.id);
  if (existing !== undefined && existing.kind !== item.kind) {
    return Result.fail(
      `"${existing.name}" is a ${existing.kind} and cannot become a ${item.kind}.`,
    );
  }
  if (item.parentId !== null) {
    const parent = items.find((candidate) => candidate.id === item.parentId);
    if (parent?.kind !== "folder") {
      return Result.fail(`The folder that should hold "${item.name}" no longer exists.`);
    }
    // Only a folder taking a new place can break the tree's shape, so a rename
    // and a request are not checked.
    if (item.kind === "folder" && existing?.parentId !== item.parentId) {
      const moved = existing === undefined ? null : subtree(items, item.id);
      // Moving a folder under itself would cut its whole subtree off from the tree.
      if (moved?.ids.has(item.parentId)) {
        return Result.fail(`"${item.name}" cannot be moved into itself.`);
      }
      const depth = folderDepth(items, item.parentId) + 1 + (moved?.folderLevels ?? 0);
      if (depth > API_GATEWAY_MAX_FOLDER_DEPTH) {
        return Result.fail(
          `Folders nest at most ${API_GATEWAY_MAX_FOLDER_DEPTH} deep, and "${item.name}" would go past that.`,
        );
      }
    }
  }
  if (existing === undefined) {
    return items.length >= API_GATEWAY_MAX_ITEMS
      ? Result.fail(`API Gateway keeps at most ${API_GATEWAY_MAX_ITEMS} items.`)
      : Result.succeed([...items, item]);
  }
  return existing.parentId === item.parentId
    ? Result.succeed(items.map((candidate) => (candidate.id === item.id ? item : candidate)))
    : Result.succeed([...items.filter((candidate) => candidate.id !== item.id), item]);
}

/**
 * The workspace after `operations`, or why one of them was rejected. Nothing
 * is applied when any operation is rejected.
 */
export function applyApiGatewayOperations(
  workspace: ApiGatewayWorkspace,
  operations: ReadonlyArray<ApiGatewayOperation>,
): Result.Result<ApiGatewayWorkspace, string> {
  let { items, variableSets } = workspace;
  for (const operation of operations) {
    switch (operation.type) {
      case "item.put": {
        const next = putItem(items, operation.item);
        if (Result.isFailure(next)) return Result.fail(next.failure);
        items = next.success;
        break;
      }
      case "item.delete": {
        const removed = subtree(items, operation.id).ids;
        items = items.filter((item) => !removed.has(item.id));
        break;
      }
      case "variableSet.put": {
        const { variableSet } = operation;
        if (variableSets.some((candidate) => candidate.id === variableSet.id)) {
          variableSets = variableSets.map((candidate) =>
            candidate.id === variableSet.id ? variableSet : candidate,
          );
        } else if (variableSets.length >= API_GATEWAY_MAX_VARIABLE_SETS) {
          return Result.fail(
            `API Gateway keeps at most ${API_GATEWAY_MAX_VARIABLE_SETS} variable sets.`,
          );
        } else {
          variableSets = [...variableSets, variableSet];
        }
        break;
      }
      case "variableSet.delete": {
        variableSets = variableSets.filter((candidate) => candidate.id !== operation.id);
        break;
      }
    }
  }
  return Result.succeed({ items, variableSets });
}
