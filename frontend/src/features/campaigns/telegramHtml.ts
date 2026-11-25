/** Render Telegram's HTML subset safely for previews. Anything else becomes text. */
const ALLOWED: Record<string, string> = {
  b: "strong", strong: "strong", i: "em", em: "em", u: "u", ins: "u",
  s: "s", strike: "s", del: "s", code: "code", pre: "pre", a: "a",
  blockquote: "blockquote", "tg-spoiler": "span", span: "span",
};

export function renderTelegramHtml(source: string, parseMode: "HTML" | "MarkdownV2" | null): DocumentFragment {
  const out = document.createDocumentFragment();
  if (parseMode !== "HTML") {
    out.append(document.createTextNode(source));
    return out;
  }
  const doc = new DOMParser().parseFromString(`<body>${source}</body>`, "text/html");
  const walk = (node: Node, parent: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        parent.appendChild(document.createTextNode(child.textContent ?? ""));
      } else if (child instanceof Element) {
        const tag = ALLOWED[child.tagName.toLowerCase()];
        if (!tag) {
          walk(child, parent);
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
  return out;
}
