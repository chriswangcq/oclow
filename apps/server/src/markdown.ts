import matter from "gray-matter";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, {
    clobberPrefix: "md-",
    footnoteBackLabel: "回到正文",
    footnoteLabel: "脚注"
  })
  .use(rehypeSlug, { prefix: "md-" })
  .use(rehypeAutolinkHeadings, {
    behavior: "append",
    properties: {
      ariaHidden: "true",
      className: ["heading-anchor"],
      tabIndex: -1
    },
    content: {
      type: "element",
      tagName: "span",
      properties: {},
      children: [{ type: "text", value: "#" }]
    }
  })
  .use(rehypePrettyCode, {
    theme: "github-light",
    keepBackground: false,
    bypassInlineCode: true,
    defaultLang: {
      block: "plaintext"
    }
  })
  .use(rehypeStringify);

export async function renderWorkspaceFile(filePath: string, content: string) {
  if (!isMarkdownPath(filePath)) {
    return `<pre class="plain-text"><code>${escapeHtml(content)}</code></pre>`;
  }

  const parsed = matter(content);
  const file = await markdownProcessor.process(parsed.content.trimStart());
  return String(file);
}

function isMarkdownPath(filePath: string) {
  return /\.(md|markdown)$/i.test(filePath);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
