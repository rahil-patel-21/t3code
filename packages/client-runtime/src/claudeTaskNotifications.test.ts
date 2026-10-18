import { describe, expect, it } from "vite-plus/test";

import { parseClaudeTaskNotifications } from "./claudeTaskNotifications.js";

describe("parseClaudeTaskNotifications", () => {
  it("reads Monitor events and agent reports as Claude writes them", () => {
    expect(
      parseClaudeTaskNotifications(
        [
          "<task-notification>",
          "<task-id>b8u8556xs</task-id>",
          '<summary>Monitor event: "docs Q&amp;A"</summary>',
          "<event>round3: pool -&gt; chunk &amp;lt;1500</event>",
          "If this event is something the user would act on now, send a PushNotification.",
          "</task-notification>",
          "<task-notification>",
          "<task-id>aac11a1405932f012</task-id>",
          "<status>completed</status>",
          '<summary>Agent "Review" finished</summary>',
          "<note>The same task-id may notify more than once.</note>",
          "<result># Report\n`&lt;div&gt;` is fine\n</result>",
          "<usage><tool_uses>8</tool_uses></usage>",
          "</task-notification>",
          "<task-notification>",
          '<summary>Agent "Audit" finished</summary>',
          '<result>This agent\'s report was delivered to you as a message from "a6f". Read it there.</result>',
          "</task-notification>",
        ].join("\n"),
      ),
    ).toEqual([
      { summary: 'Monitor event: "docs Q&A"', event: "round3: pool -> chunk &lt;1500" },
      { summary: 'Agent "Review" finished', result: "# Report\n`<div>` is fine" },
      { summary: 'Agent "Audit" finished' },
    ]);
  });

  it("keeps anything the user could have typed as a user message", () => {
    expect(parseClaudeTaskNotifications("why did this fail?")).toBeNull();
    expect(
      parseClaudeTaskNotifications(
        "<task-notification><summary>Task failed</summary></task-notification>\nWhy?",
      ),
    ).toBeNull();
  });
});
