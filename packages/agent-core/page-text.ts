/**
 * Turning a scraped page into something worth grepping.
 *
 * The remote sandbox this replaces mounted sanitized HTML and let the model grep
 * it. Grepping raw HTML is awkward — a real page has its whole body on one line,
 * and every link is relative — so pages are rendered down to text here instead:
 * one block per line, and links rewritten to absolute URLs against the page's
 * own origin.
 *
 * Two things this deliberately does not do: it never keeps `<script>`/`<style>`
 * bodies (they are noise and a prompt-injection surface), and it never keeps any
 * markup at all. What the model reads is 1:1 what `grep` and `read` return.
 */

/** Page bodies are untrusted: only the text survives, and only as data. */
const DROPPED_ELEMENTS = /<(script|style|noscript|template|svg|canvas|iframe|object|embed|form|input|button|select|textarea|head)\b[\s\S]*?<\/\1>/gi;
const VOID_DROPPED = /<(input|source|track|wbr)\b[^>]*>/gi;

const BLOCK_BREAK = /<\/?(p|div|section|article|aside|header|footer|nav|main|li|ul|ol|dl|dt|dd|h[1-6]|tr|table|thead|tbody|blockquote|figure|figcaption|pre|address|fieldset)\b[^>]*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", middot: "·", copy: "©",
  laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  times: "×", deg: "°", euro: "€", pound: "£", trade: "™", reg: "®",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, " ");

/** Absolute http(s) URL for a possibly-relative href, or "" when unusable. */
export function absolutize(href: string, baseUrl: string): string {
  const value = decodeEntities(href).trim();
  if (!value || value.startsWith("#")) return "";
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

/**
 * Render a page's body HTML to text lines.
 *
 * Links keep their visible text and gain their absolute URL in angle brackets,
 * which is the one piece of structure the homepage actually needs — every link
 * on the finished page is copied straight out of this.
 */
export function renderPageText(html: string, baseUrl: string): string {
  // Links are written as <url> in the output, which the tag stripper below would
  // happily eat as if it were markup. They go through a placeholder instead and
  // are restored once every real tag is gone.
  const links: string[] = [];
  const linkToken = (url: string) => `\u0001${links.push(url) - 1}\u0001`;

  let text = html
    .replace(DROPPED_ELEMENTS, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(VOID_DROPPED, " ");

  // Anchors: keep the label, append the resolved target.
  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attrs: string, label: string) => {
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const absolute = href ? absolutize(href[2] ?? href[3] ?? href[4] ?? "", baseUrl) : "";
    const visible = decodeEntities(stripTags(label)).replace(/\s+/g, " ").trim();
    if (!absolute) return visible ? ` ${visible} ` : " ";
    return visible && visible !== absolute
      ? ` ${visible} ${linkToken(absolute)} `
      : ` ${linkToken(absolute)} `;
  });

  // Images: alt text plus the resolved source, so an associated image is usable.
  text = text.replace(/<img\b([^>]*)>/gi, (_match, attrs: string) => {
    const src = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const alt = /\balt\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const absolute = src ? absolutize(src[2] ?? src[3] ?? src[4] ?? "", baseUrl) : "";
    const label = alt ? decodeEntities(alt[2] ?? alt[3] ?? alt[4] ?? "").replace(/\s+/g, " ").trim() : "";
    if (!absolute) return " ";
    return label ? ` [image: ${label}] ${linkToken(absolute)} ` : ` [image] ${linkToken(absolute)} `;
  });

  // List items get a marker so a bulleted block stays readable after tag removal.
  text = text
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n")
    .replace(BLOCK_BREAK, "\n");

  text = decodeEntities(stripTags(text)).replace(/\u0001(\d+)\u0001/g, (_match, i: string) => {
    return `<${links[Number(i)]}>`;
  });

  // One line per block, no blank lines: line numbers stay dense, so a grep hit
  // and a read range land on the same content.
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0\u200b]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export interface GrepMatch {
  line: number;
  text: string;
}

export interface GrepOptions {
  ignoreCase?: boolean;
  /** Reported, never silently applied, so the model knows a search was cut short. */
  maxResults: number;
  /** Characters kept per matched line. */
  maxLineLength: number;
}

/** Line-oriented search. Invalid regexes fall back to a literal substring match. */
export function grepText(
  text: string,
  pattern: string,
  opts: GrepOptions,
): { matches: GrepMatch[]; totalMatches: number } {
  let test: (line: string) => boolean;
  try {
    const re = new RegExp(pattern, opts.ignoreCase ? "i" : "");
    test = (line) => re.test(line);
  } catch {
    const needle = opts.ignoreCase ? pattern.toLowerCase() : pattern;
    test = (line) => (opts.ignoreCase ? line.toLowerCase() : line).includes(needle);
  }

  const matches: GrepMatch[] = [];
  let totalMatches = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!test(line)) continue;
    totalMatches++;
    if (matches.length < opts.maxResults) {
      matches.push({
        line: i + 1,
        text: line.length > opts.maxLineLength ? `${line.slice(0, opts.maxLineLength)}…` : line,
      });
    }
  }
  return { matches, totalMatches };
}
