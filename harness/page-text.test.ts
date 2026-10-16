import { describe, expect, test } from "bun:test";
import { grepText, renderPageText } from "@homepage/agent-core";

/**
 * This layer replaced the remote sandbox: what it produces is exactly what the
 * model greps and reads, and every link on the finished homepage is copied out
 * of it. A mistake here is invisible — the page still renders, the links are
 * just wrong — so these assert exact output rather than shapes.
 */
describe("renderPageText", () => {
  const HTML = `
    <div class="nav">Skip to content</div>
    <script>var secret = "do not leak this";</script>
    <style>.x{color:red}</style>
    <article>
      <h1>Kernel 6.9 released</h1>
      <p>Linus said &quot;hello&quot; &amp; goodbye.</p>
      <ul><li><a href="/a/1">First story</a></li><li><a href="https://other.test/b">Second</a></li></ul>
    </article>
    <footer>&copy; 2026 Example</footer>
  `;

  test("keeps content, drops markup, one block per line", () => {
    expect(renderPageText(HTML, "https://example.com/news/")).toBe(
      [
        "Skip to content",
        "Kernel 6.9 released",
        'Linus said "hello" & goodbye.',
        "- First story <https://example.com/a/1>",
        "- Second <https://other.test/b>",
        "© 2026 Example",
      ].join("\n"),
    );
  });

  test("never leaks script or style bodies", () => {
    expect(renderPageText(HTML, "https://example.com/")).not.toContain("do not leak");
    expect(renderPageText(HTML, "https://example.com/")).not.toContain("color:red");
  });

  test("resolves relative links against the page's own directory", () => {
    // The distinction that matters: a path-relative href is not resolved
    // against the origin, so a base with a path must change the answer.
    expect(renderPageText('<a href="../x">up</a>', "https://example.com/news/2026/")).toContain(
      "<https://example.com/news/x>",
    );
    expect(renderPageText('<a href="x">down</a>', "https://example.com/news/")).toContain(
      "<https://example.com/news/x>",
    );
    expect(renderPageText('<a href="//cdn.test/x">proto</a>', "https://example.com/")).toContain(
      "<https://cdn.test/x>",
    );
  });

  test("keeps anchor text but emits no link for unusable hrefs", () => {
    const rendered = renderPageText(
      '<a href="#">top</a><a href="javascript:alert(1)">evil</a><a href="mailto:a@b.c">mail</a>',
      "https://example.com/",
    );
    // Adjacent anchors are inline, so they share a line.
    expect(rendered).toBe("top evil mail");
    expect(rendered).not.toContain("javascript:");
    expect(rendered).not.toContain("<");
  });

  test("image alt text travels with an absolute src", () => {
    expect(renderPageText('<img src="/i/a.png" alt="A chart">', "https://example.com/")).toBe(
      "[image: A chart] <https://example.com/i/a.png>",
    );
    expect(renderPageText('<img src="/i/a.png">', "https://example.com/")).toBe(
      "[image] <https://example.com/i/a.png>",
    );
  });

  test("decodes numeric entities", () => {
    expect(renderPageText("<p>caf&#233; &#x2014; ok</p>", "https://example.com/")).toBe("café — ok");
  });
});

describe("grepText", () => {
  const text = ["alpha news", "beta", "NEWS again", "gamma news"].join("\n");
  const opts = { maxResults: 10, maxLineLength: 400 };

  test("numbers lines from 1, in order", () => {
    expect(grepText(text, "news", opts).matches).toEqual([
      { line: 1, text: "alpha news" },
      { line: 4, text: "gamma news" },
    ]);
  });

  test("reports how many matched even when the cap cuts the list", () => {
    const found = grepText(text, "news", { ...opts, maxResults: 1 });
    expect(found.matches).toHaveLength(1);
    expect(found.totalMatches).toBe(2);
  });

  test("ignoreCase widens the match", () => {
    expect(grepText(text, "news", { ...opts, ignoreCase: true }).totalMatches).toBe(3);
  });

  test("a pattern that is not a valid regex falls back to a literal search", () => {
    const found = grepText("f(x) is fine", "f(x", opts);
    expect(found.matches).toEqual([{ line: 1, text: "f(x) is fine" }]);
  });

  test("truncates a long matched line instead of returning all of it", () => {
    const long = "x".repeat(500);
    const found = grepText(long, "x", { ...opts, maxLineLength: 10 });
    expect(found.matches[0]!.text).toHaveLength(11); // 10 chars plus the ellipsis
    expect(found.matches[0]!.text.endsWith("…")).toBe(true);
  });
});
