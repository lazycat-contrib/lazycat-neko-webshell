import { escapeAttr, escapeHtml } from "./utils";

type Fence = {
  marker: "```" | "~~~";
  language: string;
};

type ChatMarkdownOptions = {
  copyLabel?: string;
  sendLabel?: string;
};

export function renderChatMarkdown(source: string, options: ChatMarkdownOptions = {}): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  const copyLabel = options.copyLabel ?? "Copy";
  const sendLabel = options.sendLabel ?? "Send to terminal";
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = parseFence(line);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !isClosingFence(lines[index] ?? "", fence.marker)) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(renderCodeBlock(codeLines, fence.language, copyLabel, sendLabel));
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = Math.min(5, heading[1].length + 2);
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (isQuoteLine(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && isQuoteLine(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote><p>${renderInlineMarkdown(quoteLines.join(" "))}</p></blockquote>`);
      continue;
    }

    const list = parseListItem(line);
    if (list) {
      const items: string[] = [];
      const tag = list.ordered ? "ol" : "ul";
      while (index < lines.length) {
        const item = parseListItem(lines[index] ?? "");
        if (!item || item.ordered !== list.ordered) break;
        items.push(`<li>${renderInlineMarkdown(item.text)}</li>`);
        index += 1;
      }
      blocks.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && shouldContinueParagraph(lines[index] ?? "")) {
      paragraphLines.push((lines[index] ?? "").trim());
      index += 1;
    }
    blocks.push(`<p>${renderInlineMarkdown(paragraphLines.join(" "))}</p>`);
  }

  return blocks.join("");
}

function parseFence(line: string): Fence | undefined {
  const match = line.match(/^\s*(```|~~~)\s*([A-Za-z0-9_-]+)?\s*$/);
  if (!match) return undefined;
  return {
    marker: match[1] as Fence["marker"],
    language: match[2] ?? "",
  };
}

function isClosingFence(line: string, marker: Fence["marker"]): boolean {
  return new RegExp(`^\\s*${marker}\\s*$`).test(line);
}

function isQuoteLine(line: string): boolean {
  return /^\s*>\s?/.test(line);
}

function parseListItem(line: string): { ordered: boolean; text: string } | undefined {
  const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
  if (ordered) return { ordered: true, text: ordered[1].trim() };

  const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
  if (unordered) return { ordered: false, text: unordered[1].trim() };

  return undefined;
}

function shouldContinueParagraph(line: string): boolean {
  if (!line.trim()) return false;
  if (parseFence(line) || isQuoteLine(line) || parseListItem(line)) return false;
  return !/^(#{1,4})\s+(.+)$/.test(line);
}

function renderCodeBlock(lines: string[], language: string, copyLabel: string, sendLabel: string): string {
  const languageClass = language ? ` class="language-${escapeAttr(language)}"` : "";
  const safeCopyLabel = escapeAttr(copyLabel);
  const safeSendLabel = escapeAttr(sendLabel);
  return `
    <div class="ai-code-block">
      <div class="ai-code-actions">
        <button class="ai-code-action" type="button" data-ai-action="send-code-to-terminal" aria-label="${safeSendLabel}" title="${safeSendLabel}">
          <i data-lucide="terminal"></i>
        </button>
        <button class="ai-code-action" type="button" data-ai-action="copy-code" aria-label="${safeCopyLabel}" title="${safeCopyLabel}">
          <i data-lucide="copy"></i>
        </button>
      </div>
      <pre><code${languageClass}>${escapeHtml(lines.join("\n"))}</code></pre>
    </div>
  `;
}

function renderInlineMarkdown(source: string): string {
  const codeRegex = /`([^`\n]+)`/g;
  let output = "";
  let cursor = 0;
  for (const match of source.matchAll(codeRegex)) {
    output += renderInlineWithoutCode(source.slice(cursor, match.index));
    output += `<code>${escapeHtml(match[1])}</code>`;
    cursor = (match.index ?? 0) + match[0].length;
  }
  output += renderInlineWithoutCode(source.slice(cursor));
  return output;
}

function renderInlineWithoutCode(source: string): string {
  const linkRegex = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let output = "";
  let cursor = 0;
  for (const match of source.matchAll(linkRegex)) {
    output += renderEmphasis(escapeHtml(source.slice(cursor, match.index)));
    const href = safeLinkHref(match[2]);
    if (href) {
      output += `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${renderEmphasis(escapeHtml(match[1]))}</a>`;
    } else {
      output += renderEmphasis(escapeHtml(match[0]));
    }
    cursor = (match.index ?? 0) + match[0].length;
  }
  output += renderEmphasis(escapeHtml(source.slice(cursor)));
  return output;
}

function safeLinkHref(rawHref: string): string | undefined {
  try {
    const url = new URL(rawHref);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function renderEmphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
}
