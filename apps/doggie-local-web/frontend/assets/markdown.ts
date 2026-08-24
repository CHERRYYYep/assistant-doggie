/**
 * Minimal Markdown renderer for assistant output.
 *
 * Everything here returns an HTML string that a caller assigns to `innerHTML`,
 * so escaping is not cosmetic — it is the only thing standing between model or
 * user text and script execution. Two rules hold throughout:
 *
 *   1. Every value that originates outside this module passes through
 *      `escapeHtml` before it reaches the output, and
 *   2. attribute values are additionally constrained (`safeHref` for URLs,
 *      a character allow-list for code languages).
 *
 * Behaviour is covered by `tests/markdown.test.ts`, including the injection
 * payloads each rule exists to stop.
 */

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape the five characters that can break out of text or an attribute. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/**
 * Whether `value` contains a C0 control character or DEL.
 *
 * Browsers strip these before resolving a scheme, so `java<TAB>script:` and
 * `java<LF>script:` both execute as `javascript:`. Rejecting them by code point
 * avoids relying on an escape sequence surviving every tool that edits this
 * file.
 */
function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Return `value` if it is a URL we are willing to put in an `href`, else "".
 *
 * Only http(s), mailto, fragments, root-relative paths and queries pass.
 * Protocol-relative `//host` is rejected along with `javascript:` and `data:`.
 */
export function safeHref(value) {
  const href = String(value ?? "").trim();
  if (hasControlCharacter(href)) return "";
  return /^(?:https?:\/\/|mailto:|#|\/(?!\/)|\?)/i.test(href) ? href : "";
}

/** Reduce a fence info string to a token safe to interpolate into a class. */
export function codeLanguage(value) {
  const token =
    String(value ?? "")
      .trim()
      .split(/\s+/, 1)[0] || "";
  return token.replace(/[^A-Za-z0-9_+#.-]/g, "").slice(0, 32);
}

/** Render inline spans: code, strong, emphasis and links. */
export function renderInline(value) {
  const source = String(value ?? "");
  let html = "";
  let plain = "";
  let index = 0;

  const flushPlain = () => {
    if (plain) {
      html += escapeHtml(plain).replace(/\n/g, "<br>");
      plain = "";
    }
  };

  while (index < source.length) {
    if (source[index] === "`") {
      let run = 1;
      while (source[index + run] === "`") run += 1;
      const marker = source.slice(index, index + run);
      const end = source.indexOf(marker, index + run);
      if (end !== -1) {
        flushPlain();
        html += `<code>${escapeHtml(source.slice(index + run, end))}</code>`;
        index = end + run;
        continue;
      }
    }

    if (source.startsWith("**", index) || source.startsWith("__", index)) {
      const marker = source.slice(index, index + 2);
      const end = source.indexOf(marker, index + 2);
      if (end > index + 2) {
        flushPlain();
        html += `<strong>${renderInline(source.slice(index + 2, end))}</strong>`;
        index = end + 2;
        continue;
      }
    }

    if (source[index] === "*" || source[index] === "_") {
      const marker = source[index];
      // `snake_case` must not turn into emphasis.
      const isWordUnderscore = marker === "_" && index > 0 && /\w/.test(source[index - 1]);
      if (!isWordUnderscore) {
        const end = source.indexOf(marker, index + 1);
        if (end > index + 1) {
          flushPlain();
          html += `<em>${renderInline(source.slice(index + 1, end))}</em>`;
          index = end + 1;
          continue;
        }
      }
    }

    if (source[index] === "[") {
      const link = source
        .slice(index)
        .match(/^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/);
      if (link) {
        const href = safeHref(link[2]);
        // A rejected URL falls through to plain text, so the label survives.
        if (href) {
          flushPlain();
          const title = link[3] ? ` title="${escapeHtml(link[3])}"` : "";
          html +=
            `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener"${title}>` +
            `${renderInline(link[1])}</a>`;
          index += link[0].length;
          continue;
        }
      }
    }

    plain += source[index];
    index += 1;
  }

  flushPlain();
  return html;
}

/** Render one fenced block. Contents are escaped, never re-parsed. */
export function renderCodeBlock(lines, info) {
  const language = codeLanguage(info);
  const className = language ? ` class="language-${escapeHtml(language)}"` : "";
  return (
    `<div class="md-code-block"><div class="md-code-header">` +
    `${language ? escapeHtml(language) : "代码"}</div>` +
    `<pre><code${className}>${escapeHtml(lines.join("\n"))}</code></pre></div>`
  );
}

/** Render a Markdown document to HTML. */
export function renderMarkdown(value) {
  const lines = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");

  let html = "";
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let quoteLines = [];
  let fence = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      html += `<p>${renderInline(paragraph.join("\n"))}</p>`;
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listType) {
      html += `<${listType}>${listItems.map((item) => `<li>${item}</li>`).join("")}</${listType}>`;
      listType = null;
      listItems = [];
    }
  };
  const flushQuote = () => {
    if (quoteLines.length) {
      html += `<blockquote>${renderInline(quoteLines.join("\n"))}</blockquote>`;
      quoteLines = [];
    }
  };
  const flushBlocks = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        html += renderCodeBlock(fence.lines, fence.info);
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }

    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening) {
      flushBlocks();
      fence = {
        char: opening[1][0],
        length: opening[1].length,
        info: opening[2],
        lines: [],
      };
      continue;
    }

    if (!line.trim()) {
      flushBlocks();
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushBlocks();
      const level = heading[1].length;
      html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
      continue;
    }

    if (/^ {0,3}(?:[-*_]\s*){3,}$/.test(line)) {
      flushBlocks();
      html += "<hr>";
      continue;
    }

    const quote = line.match(/^ {0,3}>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      quoteLines.push(quote[1]);
      continue;
    }
    if (quoteLines.length) flushQuote();

    const unordered = line.match(/^ {0,3}[-+*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      if (listType !== "ul") {
        flushList();
        listType = "ul";
      }
      listItems.push(renderInline(unordered[1]));
      continue;
    }

    const ordered = line.match(/^ {0,3}\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (listType !== "ol") {
        flushList();
        listType = "ol";
      }
      listItems.push(renderInline(ordered[1]));
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  // An unterminated fence still renders as code rather than leaking markup.
  if (fence) {
    html += renderCodeBlock(fence.lines, fence.info);
  } else {
    flushBlocks();
  }
  return html;
}
