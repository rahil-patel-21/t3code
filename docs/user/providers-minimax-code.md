# MiniMax Code

MiniMax Code runs as a CLI on the machine that hosts your environment. Install it
there, sign in with `mcode login`, then enable it in **Settings > Providers**. See
[provider setup](./install.md#providers).

T3 Code drives the CLI over the Agent Client Protocol (`mcode acp`), so it uses
whatever models your MiniMax account exposes, including custom providers you add
with `mcode provider add`.

## Sign-in happens in the CLI

T3 Code cannot sign you in to MiniMax. It exposes no browser sign-in, and it never
sends or stores your MiniMax credentials. Run `mcode login` yourself, or configure
an API key with `mcode provider set-minimax-key`. The provider card shows
**not signed in** until one of those is done.

Use `mcode provider use` to choose which credential source is active. T3 Code
follows whichever source is active, so switching it in the CLI changes what T3 Code
uses on the next thread.

## Things that differ from other providers

- **Permission modes are coarser.** MiniMax Code offers three policies where other
  providers offer four. **Ask** and **Accept edits** both map to asking, so
  **Auto-accept edits** behaves like **Ask** for this provider. Choose **Full
  access** for unattended runs. See [permission modes](./permission-modes.md).
- **Images arrive as file paths, not as prompt content.** The CLI rejects image
  blocks in `session/prompt`, so T3 Code sends the saved file path instead and the
  agent opens the image with its own tools. Screenshot turns work, but the agent
  has to go and read the file rather than receiving the image inline.
- **No audio input.** Audio attachments are not supported.
- **Thinking effort depends on the model.** The effort control only appears for
  models that offer a thinking variant. Switching to a model without one removes
  it, and the previous choice is not carried over.
- **Usage and cost are not reported.** Token spend and rate-limit windows are not
  shown in T3 Code's usage views for this provider yet.

## Multiple accounts

Add a second provider instance to run MiniMax Code under a different account or
configuration. Each instance can set its own environment variables, and its
**Binary path** can point at a separate `mcode` install.
