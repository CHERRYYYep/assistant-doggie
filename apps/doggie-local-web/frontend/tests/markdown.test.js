import { test } from "node:test";
import assert from "node:assert/strict";

import {
  codeLanguage,
  escapeHtml,
  renderInline,
  renderMarkdown,
  safeHref,
} from "../assets/markdown.js";

/** Build a string containing a raw control character without an escape literal. */
const withControl = (before, code, after) => before + String.fromCharCode(code) + after;

test("escapeHtml neutralises every character that can break out of markup", () => {
  assert.equal(
    escapeHtml(`<script>alert("x")</script>`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
  );
  assert.equal(escapeHtml("a & b"), "a &amp; b");
  assert.equal(escapeHtml("it's"), "it&#39;s");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(0), "0");
});

test("safeHref admits navigable URLs only", () => {
  for (const href of [
    "https://example.com/a?b=1#c",
    "http://example.com",
    "mailto:someone@example.com",
    "#section",
    "/local/path",
    "?q=1",
  ]) {
    assert.equal(safeHref(href), href, `should admit ${href}`);
  }

  for (const href of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "//evil.example/path",
    "file:///etc/passwd",
    "",
  ]) {
    assert.equal(safeHref(href), "", `should reject ${href}`);
  }
});

test("safeHref rejects control characters browsers strip before scheme resolution", () => {
  // Each of these resolves to `javascript:` once the browser removes the
  // control character, which is the whole reason the check exists.
  for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f]) {
    const href = withControl("java", code, "script:alert(1)");
    assert.equal(safeHref(href), "", `should reject control code ${code}`);
  }
});

test("renderInline refuses to emit a link for a rejected URL but keeps the label", () => {
  const html = renderInline("[click me](javascript:alert(1))");
  // The whole construct degrades to escaped plain text. The URL may still
  // appear as *text* — that is inert; what must not exist is an href.
  assert.ok(!html.includes("<a "), `no anchor may be produced: ${html}`);
  assert.ok(!html.includes("href"), `no href may be produced: ${html}`);
  assert.ok(html.includes("click me"), "the label text is preserved");
});

test("renderInline escapes the link title and always sets rel", () => {
  const html = renderInline(`[a](https://example.com "<script>alert(1)</script>")`);
  assert.ok(html.includes('rel="noreferrer noopener"'));
  assert.ok(html.includes('target="_blank"'));
  assert.ok(!html.includes("<script>"), `title must be escaped: ${html}`);
  assert.ok(html.includes('title="&lt;script&gt;'), `title must be escaped: ${html}`);
});

test("renderInline fails closed when a link title contains a quote", () => {
  // The title group excludes quotes, so a quote cannot terminate the attribute
  // early. The link does not parse and degrades to escaped plain text, where
  // `onmouseover=` is inert characters rather than an attribute.
  const html = renderInline(`[a](https://example.com "x'onmouseover='alert(1)")`);
  assert.ok(!html.includes("<a "), `no anchor may be produced: ${html}`);
  assert.ok(!html.includes("'"), `quotes must be escaped: ${html}`);
  assert.ok(html.includes("&#39;"), `quotes must be escaped: ${html}`);
});

test("renderInline escapes markup inside code, emphasis and plain runs", () => {
  assert.equal(
    renderInline("`<img src=x onerror=alert(1)>`"),
    "<code>&lt;img src=x onerror=alert(1)&gt;</code>",
  );
  assert.ok(renderInline("**<b>bold</b>**").includes("&lt;b&gt;"));
  assert.equal(renderInline("plain <b>text</b>"), "plain &lt;b&gt;text&lt;/b&gt;");
});

test("renderInline leaves snake_case alone but still emphasises real markers", () => {
  assert.equal(renderInline("some_var_name"), "some_var_name");
  assert.equal(renderInline("*em*"), "<em>em</em>");
  assert.equal(renderInline("**strong**"), "<strong>strong</strong>");
});

test("codeLanguage strips everything that could escape the class attribute", () => {
  assert.equal(codeLanguage("bash"), "bash");
  assert.equal(codeLanguage('"><script>alert(1)</script>'), "scriptalert1script");
  assert.equal(codeLanguage("c++"), "c++");
  assert.equal(codeLanguage(""), "");
  assert.equal(codeLanguage("a".repeat(64)).length, 32);
});

test("renderMarkdown keeps fenced code inert and preserves its newlines", () => {
  const html = renderMarkdown("```bash\nls -la\necho '<b>hi</b>'\n```");
  assert.ok(html.includes('<div class="md-code-block">'));
  assert.ok(html.includes('<div class="md-code-header">bash</div>'));
  assert.ok(html.includes('<code class="language-bash">'));
  assert.ok(html.includes("ls -la\necho"), "newlines inside the block survive");
  assert.ok(!html.includes("<b>hi</b>"), `fence contents must stay escaped: ${html}`);
});

test("renderMarkdown cannot be escaped by closing tags inside a fence", () => {
  const html = renderMarkdown("```\n</code></pre><img src=x onerror=alert(1)>\n```");
  assert.ok(!html.includes("<img"), `injected tag must be escaped: ${html}`);
  assert.ok(html.includes("&lt;img"));
});

test("renderMarkdown renders an unterminated fence as code rather than leaking markup", () => {
  const html = renderMarkdown("```\n<script>alert(1)</script>");
  assert.ok(html.includes("md-code-block"));
  assert.ok(!html.includes("<script>"), `must not emit a script tag: ${html}`);
});

test("renderMarkdown covers the block constructs the UI relies on", () => {
  assert.equal(renderMarkdown("# Title"), "<h1>Title</h1>");
  assert.equal(renderMarkdown("###### Deep"), "<h6>Deep</h6>");
  assert.equal(renderMarkdown("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(renderMarkdown("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(renderMarkdown("> quoted"), "<blockquote>quoted</blockquote>");
  assert.equal(renderMarkdown("---"), "<hr>");
  assert.equal(renderMarkdown("hello"), "<p>hello</p>");
});

test("renderMarkdown switches list type instead of nesting the wrong one", () => {
  assert.equal(renderMarkdown("- a\n1. b"), "<ul><li>a</li></ul><ol><li>b</li></ol>");
});

test("renderMarkdown handles empty and nullish input", () => {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown(null), "");
  assert.equal(renderMarkdown(undefined), "");
});

test("renderMarkdown normalises CRLF so Windows-authored text still parses", () => {
  assert.equal(renderMarkdown("# A\r\n\r\nbody"), "<h1>A</h1><p>body</p>");
});
