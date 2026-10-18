# API Gateway

API Gateway is an HTTP client inside T3 Code, for calling and debugging APIs while you work.
Open **API Gateway** from the sidebar or the command palette on web and desktop.

## Requests are sent from the environment

The environment's machine sends every request, not your browser or the device in your hand. A
request can reach whatever that machine can reach, including its `localhost` and private
network, and a browser's cross-origin rules do not apply. With more than one environment
connected, choose which one sends requests from the page header.

## Send a request

Start a request, choose a method, enter a URL, and press **Send**, or `Cmd+Enter` on macOS or
`Ctrl+Enter` elsewhere. A URL without `http://` or `https://` is sent over `http`.

- **Params** and the URL's query string are one list: editing either updates the other. Untick
  a row to leave it out of the request without deleting it.
- A header you write under **Headers** replaces the one **Auth** or **Body** would add. The
  exception is a multipart body, whose `Content-Type` has to name the boundary it was written
  with.
- Multipart fields are text. A `@file` value is sent as those characters, not as a file.
- **Settings** holds the timeout and whether redirects are followed. A followed redirect to
  another site receives the request's headers and body, except `Authorization` and `Cookie`
  headers, so turn following off before sending a key in another header to a server you do not
  trust. Opening a connection gives up after 10 seconds, whatever the timeout.
- Paste a `curl` command into the URL field to fill in the whole request. **Copy as curl**
  produces one for macOS and Linux shells from the request, with variables filled in.

`GET` and `HEAD` requests are sent without a body, even when **Body** has content. A `Host`
header can only name the URL's own host, and some ports, such as 6000 and the mail ports, cannot
be reached at all.

The response shows its status, time, size, headers, and body. JSON is indented for reading;
choose **Raw** to see it as it arrived. A body longer than 5 MB is cut off at that size, and a
body still arriving when the timeout runs out, such as an event stream, shows what came until
then.

## Save requests in collections

**Save**, or `Cmd+S` on macOS and `Ctrl+S` elsewhere, stores a request in a collection.
Collections can hold folders, ten levels deep. Right-click an item, or use its menu, to rename,
move, duplicate, or delete it.

Collections belong to the environment. Every app connected to it sees the same ones, and
deleting an item removes it for all of them. Open tabs, unsaved edits, and **History** stay on
the device where you made them, in the browser's storage, including any token typed into them.
Very large unsaved edits may not survive a reload; save the request to keep one.

## Reuse values with variables

Write `{{name}}` in a URL, header, auth field, or body, and give `name` a value in a variable
set. Keep one set per place you call, such as local and production, and choose the set to send
with. A value can use other variables, as `{{host}}/v2` can for a base URL. A placeholder with
no value is sent as written, and the response names it.

Variable sets are shared like collections. They and saved requests are stored as plain text on
the environment's machine, so treat a token saved in them as you would one in a `.env` file
there.

## Access from paired devices

A paired device needs the **Use terminals** permission to open API Gateway. Sending requests
from a machine reaches what a shell on it can.
