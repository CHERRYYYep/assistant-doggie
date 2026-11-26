import { useMemo } from "react";
import { renderMarkdown } from "../../assets/markdown.ts";

type Props = {
  readonly content: string;
  readonly className?: string;
};

/**
 * Renders sanitized HTML produced by Doggie's tested deterministic Markdown
 * renderer (`web/assets/markdown.ts`), preserving XSS escape invariants.
 */
export function MarkdownContent({ content, className }: Props) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  return (
    <div
      className={className ? `doggie-md ${className}` : "doggie-md"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
