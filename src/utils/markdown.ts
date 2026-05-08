/**
 * markdown - Markdown to ANSI colored string converter
 *
 * Uses the marked lexer to parse Markdown text into a Token tree,
 * then recursively renders each Token as a chalk-colored ANSI terminal string.
 * Supports headings, paragraphs, code blocks/inline code, lists, blockquotes, tables, links, etc.
 */
import { marked, type Token, type Tokens } from "marked";
import chalk from "chalk";

/** Markdown → ANSI colored string */
export function formatMarkdown(content: string): string {
  const tokens = marked.lexer(content);
  return tokens.map((t) => formatToken(t, 0)).join("\n");
}

/** Recursively render a single Token */
function formatToken(token: Token, indent: number): string {
  const pad = "  ".repeat(indent);

  switch (token.type) {
    case "heading": {
      const text = formatInlineTokens(token.tokens, indent);
      const h = token as Tokens.Heading;
      if (h.depth === 1) return chalk.cyan.bold(text);
      if (h.depth === 2) return chalk.cyan(text);
      return chalk.yellow(text);
    }

    case "paragraph": {
      return pad + formatInlineTokens(token.tokens, indent);
    }

    case "code": {
      const c = token as Tokens.Code;
      const lang = c.lang || "";
      const lines = c.text.split("\n");
      const header = lang ? chalk.gray(`┌─ ${lang} ─`) : chalk.gray("┌─ ─");
      const footer = chalk.gray("└─ ─");
      const body = lines.map((l) => chalk.gray("│ ") + l).join("\n");
      return pad + header + "\n" + pad + body + "\n" + pad + footer;
    }

    case "codespan": {
      const c = token as Tokens.Codespan;
      return chalk.bgBlack.green(` ${c.text} `);
    }

    case "list": {
      const l = token as Tokens.List;
      return l.items
        .map((item, i) => {
          const prefix = l.ordered ? `${i + 1}. ` : "• ";
          const taskPrefix = item.task
            ? item.checked ? chalk.green("☑ ") : chalk.gray("☐ ")
            : "";
          const content = item.tokens
            .map((t) => formatToken(t, indent + 1))
            .join("\n");
          return pad + prefix + taskPrefix + content.trimStart();
        })
        .join("\n");
    }

    case "list_item": {
      // list_item is handled in list, this is a fallback
      return formatInlineTokens(token.tokens, indent);
    }

    case "blockquote": {
      const b = token as Tokens.Blockquote;
      const inner = b.tokens.map((t) => formatToken(t, indent)).join("\n");
      return inner
        .split("\n")
        .map((l) => pad + chalk.gray("│ ") + l)
        .join("\n");
    }

    case "hr": {
      return pad + chalk.gray("─".repeat(60));
    }

    case "table": {
      const t = token as Tokens.Table;
      const headers = t.header.map((cell) =>
        chalk.bold(formatInlineTokens(cell.tokens, 0))
      );
      const rows = t.rows.map((row) =>
        row.map((cell) => formatInlineTokens(cell.tokens, 0))
      );
      const colWidths = headers.map((h, ci) => {
        const clean = (s: string) => stripAnsi(s);
        let w = clean(h).length;
        for (const row of rows) {
          w = Math.max(w, clean(row[ci]).length);
        }
        return w;
      });

      const headerLine = headers
        .map((h, i) => h + " ".repeat(colWidths[i] - stripAnsi(h).length))
        .join("  ");
      const sepLine = colWidths.map((w) => "─".repeat(w)).join("──");
      const dataLines = rows.map((row) =>
        row
          .map((cell, i) => cell + " ".repeat(colWidths[i] - stripAnsi(cell).length))
          .join("  ")
      );

      return [
        pad + headerLine,
        pad + chalk.gray(sepLine),
        ...dataLines.map((l) => pad + l),
      ].join("\n");
    }

    case "space": {
      return "";
    }

    default: {
      // For unknown types, try to extract raw text
      if ("raw" in token && typeof token.raw === "string") {
        return pad + token.raw.trim();
      }
      if ("text" in token && typeof token.text === "string") {
        return pad + token.text;
      }
      return "";
    }
  }
}

/** Render inline tokens (bold/italic/codespan/link/text etc.) */
function formatInlineTokens(tokens: Token[] | undefined, indent: number): string {
  if (!tokens || tokens.length === 0) return "";
  return tokens.map((t) => formatInlineToken(t, indent)).join("");
}

function formatInlineToken(token: Token, _indent: number): string {
  switch (token.type) {
    case "strong": {
      const s = token as Tokens.Strong;
      return chalk.bold(formatInlineTokens(s.tokens, _indent));
    }
    case "em": {
      const e = token as Tokens.Em;
      return chalk.italic(formatInlineTokens(e.tokens, _indent));
    }
    case "codespan": {
      const c = token as Tokens.Codespan;
      return chalk.bgBlack.green(` ${c.text} `);
    }
    case "link": {
      const l = token as Tokens.Link;
      const text = formatInlineTokens(l.tokens, _indent);
      return `${chalk.underline.blue(text)} ${chalk.gray(`(${l.href})`)}`;
    }
    case "text": {
      const t = token as Tokens.Text;
      if ("tokens" in t && Array.isArray((t as any).tokens)) {
        return formatInlineTokens((t as any).tokens, _indent);
      }
      return t.text || t.raw || "";
    }
    case "escape": {
      const e = token as Tokens.Escape;
      return e.text;
    }
    case "br": {
      return "\n";
    }
    default: {
      if ("raw" in token && typeof token.raw === "string") {
        return token.raw;
      }
      if ("text" in token && typeof token.text === "string") {
        return token.text;
      }
      return "";
    }
  }
}

/** Strip ANSI escape codes for display width calculation */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, "");
}
