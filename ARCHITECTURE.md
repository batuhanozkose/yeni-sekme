# Architecture

There is no server. Nothing to deploy, nothing to run alongside the browser.

| | Runs where | Does what |
|---|---|---|
| **Extension** (service worker) | Your browser | Hosts the whole build: the agent loop, the tool calls, the run's state |
| **Extension** (new-tab page(s)) | Your browser | Thin view: subscribes to the worker over a port, renders live progress and the finished homepage |
| **Model endpoint** | Your provider, or localhost | Answers one request. It never runs anything, and sees only what the loop sends it |

The agent loop runs **in the service worker** (`packages/agent-core/orchestrator.ts`), so a build
survives closing the tab, shows up in every open tab, and can run headless on a `chrome.alarms`
schedule. Every tool executes in that same process. `getHistory` and `getPageHtml` run there
because they need `chrome.history` and `chrome.tabs`; `glob`, `grep`, `read` and `write` run
there because the pages they work on were just scraped into memory.

```diagram
   service worker
      │
      ├─ getHistory ── chrome.history ──────────────► ranked digest
      │
      ├─ getPageHtml ─ chrome.tabs (real, logged-in)
      │                  └─ renderPageText ─────────► page files
      │
      ├─ glob / grep / read ────────────────────────► page files
      ├─ write ─────────────────────────────────────► homepage.tsx
      │
      └─ POST /chat/completions or /v1/messages ────► the model
```

The sequence for one build:

1. The worker builds a kickoff message (date, time of day, the user's standing
   instructions, the output language) and starts a loop.
2. Each pass sends the transcript plus the tool definitions to the configured
   provider, appends whatever comes back, and runs any tool calls it asked for.
3. The loop ends when the model answers without asking for a tool. The component
   it wrote is then in hand — there is no remote file to fetch.

## Two providers, one loop

`ModelProvider` is the only thing that leaves the process, and there are two
implementations of it (`packages/agent-core/providers.ts`):

| `kind` | Wire format | Covers |
|---|---|---|
| `anthropic` | `POST /v1/messages`, Anthropic tool blocks | Claude |
| `openai` | `POST /chat/completions`, OpenAI tool calls | OpenAI, OpenRouter, Groq, vLLM, LM Studio, Ollama, anything compatible |

Adding a provider means adding a row to `packages/agent-core/catalog.ts`, not a
new code path. An Anthropic call needs one header the others do not —
`anthropic-dangerous-direct-browser-access: true` — because the API refuses
requests whose Origin is a browser. It is set, and it is why the key is a
browser-profile secret rather than a server one (see **Privacy**).

## Persistence, and the one invariant

An MV3 worker is torn down after ~30s idle, and a build spends most of its wall
clock waiting on the model. Two mechanisms keep a build alive or bring it back:

- **During a turn**, the in-flight model fetch plus a 20s self-ping
  (`runtime.getPlatformInfo`) reset the idle timer.
- **A 1-minute alarm heartbeat** calls `BuildManager.tick()`. If a run is in
  progress, the worker reattaches to it; the same heartbeat also drives scheduled
  rebuilds (`lib/auto-rebuild.ts`).

The run is persisted under two keys, because one of them is megabytes and the
other is not:

| key | holds | written |
|---|---|---|
| `activeRun` | the transcript, the deliverable, the step count | after every model call and every batch of tool results |
| `runPages` | the scraped page bodies | only when `getPageHtml` added some |

Reattaching rests on a single invariant: **an assistant turn whose tool calls
have no `tool_results` turn behind them was interrupted**, so those calls are
re-executed before the loop asks the model for anything. `runTool` returns a
result on every path, so a transcript only ever reaches that state by dying
between two writes — never by choice. `pnpm agent:resume-test` proves it by
killing a real process mid-call and reattaching.

## Tabs are views

Each new tab connects on a port (`lib/protocol.ts`), receives a snapshot of the
build state, then streams phase/text/log deltas. Every open tab shows the same live
run. A throttled snapshot is also mirrored to storage so a tab opened while the
worker is asleep paints instantly.

The finished component renders inside a Sandpack iframe
(`entrypoints/newtab/components/HomepagePreview.tsx`): it is model-written code, so
it runs sandboxed, not in the extension's own page.

## Language

`lib/i18n.tsx` holds every string the extension shows, in English and Turkish.
`chrome.i18n` was the alternative and is the wrong fit: it is pinned to the
browser's UI language and cannot change while the extension runs, and this app
already has a settings screen. The setting defaults to the browser language and
is stored explicitly once the user picks one.

It also decides the language of the page the agent writes. `buildKickoffMessage`
formats the date with the matching locale and tells the model to write the page's
own copy in Turkish — while leaving headlines and post titles exactly as they were
found, so the page never disagrees with the sources it links to.

## Layout

```
packages/agent-core/      host-agnostic loop — imports no chrome.*, browser.*, or node:*
  orchestrator.ts         runHomepageBuild: the loop, persistence, reattach
  providers.ts            the two wire formats; the only network code in the package
  catalog.ts              providers the settings screen offers
  tools.ts                tool definitions and their implementations
  page-text.ts            page HTML -> greppable text with absolute links
  prompt.ts               system prompt + per-build kickoff message
  schemas.ts              tool input schemas, caps, the output path
  history-digest.ts       narrows raw history to fit a tool result
  site-filter.ts          the block list, and what is always blocked
  types.ts                ModelProvider, BrowserBridge, KVStore, Turn, …

apps/extension/           MV3 extension (WXT + React)
  entrypoints/
    background.ts         service worker: hosts BuildManager, alarm heartbeat
    scraper.content.ts    injected into scraped tabs: scroll, return HTML
    newtab/               the new-tab UI (thin client onto the worker)
  lib/
    build-manager.ts      single-flight build host, broadcast, keepalive, reattach
    browser-bridge.ts     BrowserBridge over chrome.history / chrome.tabs
    history.ts            getHistory: group and rank chrome.history by domain
    scraper.ts            getPageHtml: load URLs in a background window, render text
    protocol.ts           page ↔ worker messages and the five UI build steps
    i18n.tsx              every user-visible string, en + tr
    auto-rebuild.ts       when to rebuild on a schedule
    storage.ts            every chrome.storage key, settings, saved homepage
    transpile.ts          TSX → JS for the preview

harness/                  Bun scripts: a scripted provider for the loop, a real one for the API
```

## Verification

| Command | Proves |
|---|---|
| `pnpm test` | The loop, the tools and the resume invariant — with a scripted provider, so no network and no key |
| `pnpm agent:resume-test` | A build killed mid-tool-call is reattached and finished, across a real process death |
| `pnpm extension:test` | In headless Chrome: worker registers, new tab renders, port protocol answers, `chrome.history` reads |
| `pnpm agent:run` | A full build against a real provider: scraping, reading, the deliverable |
| `pnpm agent:verify` | The deliverable transforms, evaluates and server-renders |
| `pnpm agent:retention` | Nothing the build read is left on disk afterwards |

Only the last three need a key, and only `agent:run` spends credits. The harness's
bridge uses fixture history and a plain `fetch`, so it can't see logged-in pages —
that's the whole reason `getPageHtml` runs in your browser.

## Gotchas worth knowing

**A link rendered as `<https://…>` looks like a tag.** `renderPageText` writes
absolute URLs in angle brackets because that is the clearest thing to hand a
model — but the tag stripper that runs afterwards would eat them, silently
producing a page with no links. They go through a `\u0001<index>\u0001`
placeholder and are restored once every real tag is gone.

**The transcript is copied into every model call.** `turns: [...run.turns]`. The
orchestrator owns the transcript; a provider that appended to the array it was
handed would rewrite the persisted run.

**An empty block list is not the same as no list.** `blockedSites` unset means
"use the defaults"; `[]` means the user deleted every entry and means it. The
orchestrator only falls back on `null`/`undefined`.

**Don't cap output tokens on OpenAI-compatible endpoints.** `max_tokens` and
`max_completion_tokens` disagree across those servers, and each model accepts only
one of them. Anthropic requires a cap, so only that adapter sends one.

**A `read` is capped twice**: by lines and by characters. A page rendered from a
real site can have single lines tens of thousands of characters long, and the line
cap alone would let one of them fill the context window.

## Privacy

Nothing is uploaded to a sandbox any more: the pages the agent reads stay in the
browser, and only what the loop sends to the model provider ever leaves the
machine. That copy is the transcript — domains, page titles, and the page text the
agent read — and it goes to whichever provider is configured.

The editable blocked-sites list is enforced in the tool handlers, not in the
prompt: blocked domains are excluded from history digests and their counts, and
blocked or non-HTTP(S) page requests never reach the browser bridge. Each scraped
page's final URL is checked before its text is stored, so a redirect onto a
blocked host is dropped: the browser still loads it, but nothing it read becomes
readable. Loopback, private-IP and local-network hosts are always blocked, whatever
the list says. Subresource loads are not intercepted.

The run in progress — transcript and page bodies — is written to
`chrome.storage.local` so a killed worker can resume, and both keys are removed in
a `finally` when the build ends, cancel included. Point the extension at a local
model (Ollama, LM Studio) and nothing leaves the machine at all.

The API key lives in `chrome.storage.local`, readable by anyone with access to the
browser profile. Fine for a tool you run yourself; **do not ship this to the Web Store**
without moving the key behind a proxy.
