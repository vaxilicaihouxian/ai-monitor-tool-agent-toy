/**
 * Ansi - ANSI escape sequence rendering component
 *
 * Parses strings containing ANSI escape codes and converts them to Ink Text
 * component style attributes (color, bold, italic, underline, etc.) to correctly
 * display colored text in the terminal.
 */
import { Box, Text } from "ink";

/** Ansi props */
interface AnsiProps {
  /** String containing ANSI escape codes */
  children: string;
}

/** Parsed ANSI escape code segment */
interface AnsiSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  bgColor?: string;
  dimColor?: boolean;
}

/** Parse ANSI escape codes into an array of segments */
function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\x1B\[([0-9;]*)m/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const currentStyles: Set<number> = new Set();

  while ((match = ansiRegex.exec(input)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      const text = input.slice(lastIndex, match.index);
      if (text) {
        segments.push(buildSegment(text, currentStyles));
      }
    }

    // Parse style codes
    const codes = match[1].split(";").map(Number);
    for (const code of codes) {
      if (code === 0) {
        currentStyles.clear();
      } else {
        currentStyles.add(code);
      }
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < input.length) {
    const text = input.slice(lastIndex);
    if (text) {
      segments.push(buildSegment(text, currentStyles));
    }
  }

  return segments;
}

const ANSI_COLOR_MAP: Record<number, string> = {
  30: "black", 31: "red", 32: "green", 33: "yellow",
  34: "blue", 35: "magenta", 36: "cyan", 37: "white",
  90: "gray",
};

const ANSI_BG_MAP: Record<number, string> = {
  40: "black", 41: "red", 42: "green", 43: "yellow",
  44: "blue", 45: "magenta", 46: "cyan", 47: "white",
};

function buildSegment(text: string, styles: Set<number>): AnsiSegment {
  const seg: AnsiSegment = { text };

  for (const code of styles) {
    if (code === 1) seg.bold = true;
    else if (code === 2) seg.dimColor = true;
    else if (code === 3) seg.italic = true;
    else if (code === 4) seg.underline = true;
    else if (ANSI_COLOR_MAP[code]) seg.color = ANSI_COLOR_MAP[code];
    else if (ANSI_BG_MAP[code]) seg.bgColor = ANSI_BG_MAP[code];
  }

  return seg;
}

/** Render ANSI colored string as Ink Text component */
export function Ansi({ children }: AnsiProps) {
  const segments = parseAnsi(children);

  if (segments.length === 0) return null;

  return (
    <Text>
      {segments.map((seg, i) => (
        <Text
          key={i}
          bold={seg.bold}
          italic={seg.italic}
          underline={seg.underline}
          color={seg.color}
          backgroundColor={seg.bgColor}
          dimColor={seg.dimColor}
        >
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}
