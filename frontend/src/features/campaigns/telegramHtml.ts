import { marked } from "marked";
import type { ParseMode } from "../../lib/api";

/** Render Telegram's HTML subset safely for previews. Anything else becomes text. */
const ALLOWED: Record<string, string> = {
  b: "strong", strong: "strong", i: "em", em: "em", u: "u", ins: "u",
  s: "s", strike: "s", del: "s", code: "code", pre: "pre", a: "a",
  blockquote: "blockquote", "tg-spoiler": "span", span: "span",
};

export function renderTelegramHtml(source: string, parseMode: ParseMode): DocumentFragment {
  const out = document.createDocumentFragment();
  // Standard Markdown is parsed by `marked`; the walk below keeps what Telegram can show,
  // matching what the backend's telegramify-markdown sends.
  if (parseMode === "Markdown") source = marked.parse(source, { async: false, gfm: true, breaks: true });
  else if (parseMode !== "HTML") {
    out.append(document.createTextNode(source));
    return out;
  }
  const doc = new DOMParser().parseFromString(`<body>${source}</body>`, "text/html");
  const walk = (node: Node, parent: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        parent.appendChild(document.createTextNode(child.textContent ?? ""));
      } else if (child instanceof Element) {
        const name = child.tagName.toLowerCase();
        if (name === "br") {
          parent.appendChild(document.createTextNode("\n"));
          continue;
        }
        if (/^h[1-6]$/.test(name)) {
          const strong = document.createElement("strong");
          const u = document.createElement("u");
          walk(child, u);
          strong.appendChild(u);
          parent.appendChild(strong);
          parent.appendChild(document.createTextNode("\n"));
          continue;
        }
        if (name === "li") parent.appendChild(document.createTextNode("⦁ "));
        const tag = ALLOWED[name];
        if (!tag) {
          walk(child, parent);
          if (name === "p" || name === "li") parent.appendChild(document.createTextNode("\n"));
          continue;
        }
        const el = document.createElement(tag);
        if (tag === "a") {
          const href = child.getAttribute("href") ?? "";
          if (/^(https?|tg):\/\//i.test(href)) el.setAttribute("href", href);
          el.setAttribute("target", "_blank");
          el.setAttribute("rel", "noreferrer");
        }
        if (child.tagName.toLowerCase() === "tg-spoiler" || child.classList.contains("tg-spoiler")) {
          el.className = "tg-spoiler";
        }
        walk(child, el);
        parent.appendChild(el);
      }
    }
  };
  walk(doc.body, out);
  // Drop the trailing line breaks block elements leave behind.
  while (out.lastChild?.nodeType === Node.TEXT_NODE && !out.lastChild.textContent?.trim()) out.lastChild.remove();
  const last = out.lastChild;
  if (last?.nodeType === Node.TEXT_NODE) last.textContent = last.textContent!.replace(/\s+$/, "");
  return out;
}
