import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";

const ALLOWED_ELEMENTS = new Set([
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
]);

const safeWebUrl = (value: string | null): string | undefined => {
  if (value === null) return undefined;
  try {
    const url = new URL(value, globalThis.location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

const renderSafeMarkdown = (source: string): string => {
  try {
    const parsed = new DOMParser().parseFromString(
      marked.parse(source, { async: false, breaks: false, gfm: true }),
      "text/html",
    );
    for (const element of [...parsed.body.querySelectorAll("*")]) {
      const tag = element.tagName.toLowerCase();
      if (!ALLOWED_ELEMENTS.has(tag)) {
        element.replaceWith(document.createTextNode(element.textContent));
        continue;
      }
      const href = tag === "a" ? safeWebUrl(element.getAttribute("href")) : undefined;
      for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
      if (tag === "a") {
        if (href === undefined) {
          element.replaceWith(...element.childNodes);
          continue;
        }
        element.setAttribute("href", href);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }
    }
    return parsed.body.innerHTML;
  } catch {
    const fallback = document.createElement("div");
    fallback.textContent = source;
    return fallback.innerHTML;
  }
};

export function SafeMarkdown(props: Readonly<{ source: string; className?: string }>): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderSafeMarkdown(props.source), [props.source]);

  useEffect(() => {
    const disposers: Array<() => void> = [];
    for (const block of root.current?.querySelectorAll("pre") ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "code-copy-button";
      button.textContent = "复制";
      button.setAttribute("aria-label", "复制代码");
      const copy = (): void => {
        const codeElement = block.querySelector("code");
        const code = codeElement === null ? block.textContent : codeElement.textContent;
        void navigator.clipboard.writeText(code).then(() => {
          button.textContent = "已复制";
          globalThis.setTimeout(() => { button.textContent = "复制"; }, 1_200);
        });
      };
      button.addEventListener("click", copy);
      block.prepend(button);
      disposers.push(() => button.removeEventListener("click", copy));
    }
    return () => disposers.forEach((dispose) => dispose());
  }, [html]);

  return <div ref={root} className={`markdown-content${props.className === undefined ? "" : ` ${props.className}`}`}
    dangerouslySetInnerHTML={{ __html: html }} />;
}
