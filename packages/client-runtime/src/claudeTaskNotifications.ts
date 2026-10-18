/**
 * Claude Code hands background-task results and Monitor output to the model as
 * user messages wrapped in `<task-notification>`. Imported Claude transcripts
 * keep that text verbatim, so clients read it back into a notice instead of
 * showing harness XML as something the user typed.
 */
export interface ClaudeTaskNotification {
  readonly summary: string;
  /** Monitor output that triggered the notice. */
  readonly event?: string;
  /** A finished agent's report, when Claude inlined it. */
  readonly result?: string;
}

const NOTIFICATION_BLOCK = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  "#39": "'",
};

// Claude escapes tag contents, so `->` arrives as `-&gt;`. One pass keeps `&amp;lt;` literal.
function decodeEntities(value: string): string {
  return value.replace(/&(lt|gt|amp|quot|apos|#39);/g, (entity, name: string) => {
    return ENTITIES[name] ?? entity;
  });
}

function readTag(body: string, tag: string): string | undefined {
  const value = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body)?.[1]?.trim();
  return value ? decodeEntities(value) : undefined;
}

/**
 * The notices in `text` when it holds nothing but notification blocks, otherwise
 * null. Anything else in the message, even beside a block, keeps it a user message.
 * Untagged text inside a block is addressed to the model and is dropped.
 */
export function parseClaudeTaskNotifications(
  text: string,
): ReadonlyArray<ClaudeTaskNotification> | null {
  if (!text.trimStart().startsWith("<task-notification>")) return null;
  if (text.replace(NOTIFICATION_BLOCK, "").trim().length > 0) return null;
  return Array.from(text.matchAll(NOTIFICATION_BLOCK), ([, body = ""]) => {
    const event = readTag(body, "event");
    let result = readTag(body, "result");
    // Claude can point at a separate hand-back message instead; imports skip that message.
    if (result?.includes("delivered to you as a message")) result = undefined;
    return {
      summary: readTag(body, "summary") ?? "Background task update",
      ...(event ? { event } : {}),
      ...(result ? { result } : {}),
    };
  });
}
