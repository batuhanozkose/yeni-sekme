# AI Homepage

**A new tab that reads the internet for you.**

AI Homepage replaces Chrome's new-tab page with one that's written for you. An
agent looks at what you've actually been browsing, opens the pages you follow
(signed in as you), and writes a fresh homepage from what it finds there. It
rebuilds itself in the background, so each new tab is up to date.

![An example homepage in a morning-newspaper style](docs/preview.png)
<sub>Illustration. Your homepage is built from your own browsing, so its stories will be different.</sub>

A morning newspaper is just one look. You can describe any look and the next build
follows it: a quiet one-column digest, a dense dashboard, a green-on-black
terminal, a zine.

> **Privacy, up front.** The agent runs inside the extension. It reads your history
> in the browser and opens pages in your signed-in browser, then sends that
> material — the domains it visited, a few page titles, and the text of up to 10
> pages — to the model provider you configure, using your own key. Nothing goes
> anywhere else: there is no server in this project and no sandbox to upload pages
> to. Point it at a local model and nothing leaves your machine at all. More detail
> in [ARCHITECTURE.md](./ARCHITECTURE.md#privacy).

---

## Install

You need Chrome (or another Chromium browser), [Node.js](https://nodejs.org) 20+,
and an API key for a model provider (or [Ollama](https://ollama.com) running
locally, which needs none).

```bash
git clone https://github.com/ThariqS/ai-newtab.git
cd ai-newtab
npx pnpm@10.11.1 install
npx pnpm@10.11.1 build
```

(If you already have [pnpm](https://pnpm.io), plain `pnpm install && pnpm build` works too.)

Then load it into Chrome:

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose `apps/extension/.output/chrome-mv3`.

If Chrome asks whether to keep the changed new-tab page, choose **Keep it**.

## Your first homepage

1. Open a new tab, pick a provider and paste your API key.
2. Click **Build today's homepage**.
3. Watch it work. The progress view walks through each step: preparing the
   agent, reading your history, opening pages in your browser, analyzing them,
   and writing your homepage.

The first build takes a few minutes. You can close the tab while it runs, since
the build lives in the extension's background worker and appears in any new tab
you open.

## Choose your model

Click **⚙️ Settings** on the new tab. Any of these work, with your own key:

| Provider | Notes |
| --- | --- |
| **Anthropic** (default) | Claude. `claude-sonnet-5-5` is the default model. |
| **OpenAI** | `gpt-4o`, `gpt-4o-mini`, anything you have access to. |
| **OpenRouter** | One key, most models. Use `provider/model` ids. |
| **Groq** | Fast hosted open models. |
| **Ollama** | Local, no key, no cost. Needs `ollama serve` running. |
| **Custom** | Any OpenAI-compatible endpoint: something you host, a gateway, or a proxy. Give it the base URL including its `/v1`. |

The model field is free text, with the common ids offered as suggestions —
model names change faster than this README does. The new model takes effect from
your next build, and **Resume interrupted build** will finish a half-done build
with a different provider than it started with: the transcript belongs to the
extension, not to a provider.

Two things worth knowing before you pick a small local model: the build is a
four-step tool loop (read history → scrape → grep/read → write), and weaker models
tend to skip steps or invent links. Claude and the larger hosted models follow it
reliably; a 3B local model mostly does not.

## Make it yours

The **Instructions** box is the main lever. Anything you write here goes into every
build and takes priority over the agent's own defaults. It sets both the content
and the look:

| You write | You get |
| --- | --- |
| *"A morning newspaper. Serif type, a big masthead, a lead story, a column of briefs."* | A broadsheet front page |
| *"One calm column. No images. Five things worth reading, with one line on why."* | A quiet reading list |
| *"Dense dashboard: GitHub PRs and issues first, then Hacker News, then everything else."* | A work cockpit |
| *"Green-on-black terminal, monospace, like a 1980s BBS."* | Exactly that |
| *"Skip sports and politics. Always show the weather and my next three calendar events."* | Your rules, every day |

Click **Save & rebuild** to apply them right away.

**Sites the agent never reads.** Enter one host per line; subdomains are included,
and `*.example.com` is supported. The editable defaults include common webmail,
sign-in and document hosts. They are applied to history summaries and to every URL
requested through `getPageHtml`, and a page that redirects onto a blocked host is
dropped before the agent can read a word of it. Local-network addresses (localhost,
private IPs, `.local` and `.internal` hosts) are always blocked.

**Language.** English or Türkçe, defaulting to your browser's language. It switches
the extension's own interface and the language the page is written in. Headlines
and post titles stay exactly as they were found — a Turkish page that silently
rewrote an English headline would misquote the link next to it.

**Rebuild automatically.** On by default. Once your homepage is older than the
interval you pick (6, 12, 24 or 48 hours), the extension rebuilds it quietly in the
background. It only starts after you've built once by hand, and it won't retry a
failed build until the next interval, so it never loops.

**↻ Rebuild** in the top-right corner rebuilds right away.

## Good to know

- **Cost.** Each build is a handful of model calls billed to your key. What it
  costs depends on the model and on how much it reads. A local model is free, and
  you can turn off automatic rebuilds to build only when you ask.
- **What it can see.** It ranks the sites in your history and opens up to 10 of
  them per build. It skips search engines, webmail, banking and logged-out
  marketing pages. Anything it can't open is reported, not hidden.
- **Links are real.** Pages are rendered to text with their links already
  absolutized, and the agent is told to copy them exactly. It's told never to
  invent a URL.
- **Interrupted builds.** If Chrome closes mid-build, the new tab offers
  **Resume interrupted build** next time. The half-finished transcript is on disk,
  and nothing the build read is kept once it ends.
- **Updating.** After pulling new code, run `npx pnpm@10.11.1 build` again, then
  click the reload icon on the extension in `chrome://extensions`.

## How it works

1. **`getHistory`**: the agent gets a ranked summary of your most-visited domains.
2. **`getPageHtml`**: it picks up to 10 pages, which the extension opens in a
   background window and renders to readable text.
3. **`grep` / `read`**: the agent pulls headlines, posts and links out of those
   pages.
4. **`write`**: it writes one React component, which the new tab renders.

All of that happens in the extension's service worker, in one process, with no
server in between. Only the model call leaves the machine, going straight to the
provider you configured with your own key.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the loop, the layout, and the
gotchas worth knowing.

## Development

```
packages/agent-core   the agent loop: host-agnostic, no chrome.* or node:*
apps/extension        the MV3 extension (WXT + React)
harness               Bun scripts that drive the loop outside Chrome, and test the built extension
```

```bash
pnpm dev                 # WXT with hot reload
pnpm typecheck           # all packages
pnpm test                # the loop, tools and resume — scripted provider, no API calls (needs Bun)
pnpm agent:resume-test   # kill a build mid-tool-call and watch it recover (no API calls)
pnpm extension:test      # loads the built extension into headless Chrome (no API calls)

cp .env.example .env     # add a provider key, then:
pnpm agent:run           # a full build against a real provider, with fixture history
pnpm agent:verify        # check the output actually renders
pnpm agent:retention     # check nothing it read is left on disk
```

## Status

Early and experimental. It's a tool you run yourself with your own key. Don't
publish it to a store as-is: anyone with access to the browser profile can read
the stored key.

## License

MIT
