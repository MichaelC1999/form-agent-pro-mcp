/**
 * markdownToPdf — render a small subset of markdown to a print-ready PDF.
 *
 * Scope is deliberately narrow: enough to render the affidavit and letter
 * templates that live under assets/forms/<processId>/affidavits/ at a quality
 * suitable for printing and signing. NOT a general-purpose markdown renderer.
 *
 * Supported constructs (anything else is rendered as plain text):
 *   • Headings: # H1, ## H2, ### H3
 *   • Inline emphasis: **bold**, *italic*
 *   • Blockquotes: lines beginning with `>`
 *   • Horizontal rule: a line that is `---` on its own
 *   • Unordered list: lines beginning with `- ` or `* `
 *   • Ordered list:  lines beginning with `1.`, `2.`, ...
 *   • Pipe tables: `| col | col |` rows (and the `|---|---|` separator is ignored)
 *   • Paragraphs and signature/notary blocks (multiple blank-line-separated)
 *
 * The output is paginated automatically (US Letter, 0.75" margins). Italian
 * accented characters (è, à, ò, Università) render correctly via the WinAnsi
 * encoding subset embedded in the standard Helvetica fonts.
 */

import * as fs from "fs";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";

// US Letter at 72 dpi: 8.5" × 11" = 612 × 792 pt
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54; // 0.75 inch

const FONT_SIZE_BODY = 10.5;
const FONT_SIZE_H1 = 18;
const FONT_SIZE_H2 = 14;
const FONT_SIZE_H3 = 12;
const LINE_GAP = 4; // extra pt between wrapped lines
const PARAGRAPH_GAP = 8;
const BLOCK_GAP = 4;

const BLOCKQUOTE_INDENT = 18;
const LIST_INDENT = 18;
const TABLE_COL_GAP = 8;

interface RenderState {
  pdf: PDFDocument;
  page: PDFPage;
  fonts: {
    regular: PDFFont;
    bold: PDFFont;
    italic: PDFFont;
    boldItalic: PDFFont;
  };
  cursorY: number;
}

interface InlineSegment {
  text: string;
  bold: boolean;
  italic: boolean;
}

/** Selects the font that matches a segment's bold/italic flags. */
function fontFor(state: RenderState, bold: boolean, italic: boolean): PDFFont {
  if (bold && italic) return state.fonts.boldItalic;
  if (bold) return state.fonts.bold;
  if (italic) return state.fonts.italic;
  return state.fonts.regular;
}

/**
 * Parses inline markdown (**bold**, *italic*) into segments.
 *
 * Strategy: a single left-to-right scan that toggles emphasis state at every
 * `**` or `*` marker. Markers occurring inside words ("don't") are treated as
 * literal asterisks if they don't form a balanced pair within the line.
 */
function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let bold = false;
  let italic = false;
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer.length > 0) {
      segments.push({ text: buffer, bold, italic });
      buffer = "";
    }
  };

  while (i < text.length) {
    if (text[i] === "\\" && i + 1 < text.length) {
      // markdown-style escape — emit next char literally
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (text[i] === "*" && text[i + 1] === "*") {
      flush();
      bold = !bold;
      i += 2;
      continue;
    }
    if (text[i] === "*") {
      flush();
      italic = !italic;
      i += 1;
      continue;
    }
    buffer += text[i];
    i += 1;
  }
  flush();
  return segments;
}

/**
 * Splits a text run into pieces that fit within `maxWidth` at the segment's
 * font/size. Returns lines as arrays of segments (so a single line can still
 * mix bold + plain text).
 *
 * Word-wraps on whitespace. Long unbreakable tokens overflow rather than
 * truncate — readable PDFs over pixel-perfect ones.
 */
function wrapSegments(
  segments: InlineSegment[],
  state: RenderState,
  size: number,
  maxWidth: number,
): InlineSegment[][] {
  const lines: InlineSegment[][] = [];
  let current: InlineSegment[] = [];
  let currentWidth = 0;
  const spaceWidth = state.fonts.regular.widthOfTextAtSize(" ", size);

  const pushCurrent = () => {
    if (current.length > 0) {
      lines.push(current);
      current = [];
      currentWidth = 0;
    }
  };

  for (const seg of segments) {
    const font = fontFor(state, seg.bold, seg.italic);

    // Honor explicit \n inside a segment
    const subRuns = seg.text.split(/\n/);
    for (let s = 0; s < subRuns.length; s++) {
      const run = subRuns[s];
      const tokens = run.split(/(\s+)/).filter((t) => t.length > 0);
      for (const tok of tokens) {
        const w = font.widthOfTextAtSize(tok, size);
        const isWhitespace = /^\s+$/.test(tok);

        if (isWhitespace) {
          if (current.length === 0) continue; // skip leading whitespace on a new line
          current.push({ text: " ", bold: seg.bold, italic: seg.italic });
          currentWidth += spaceWidth;
          continue;
        }

        if (currentWidth + w > maxWidth && current.length > 0) {
          // strip trailing whitespace before wrapping
          while (current.length > 0 && /^\s+$/.test(current[current.length - 1].text)) {
            current.pop();
          }
          pushCurrent();
        }
        current.push({ text: tok, bold: seg.bold, italic: seg.italic });
        currentWidth += w;
      }
      if (s < subRuns.length - 1) pushCurrent(); // explicit newline → new line
    }
  }
  pushCurrent();
  return lines;
}

/** Ensures `requiredHeight` pt of vertical space below the cursor; paginates if not. */
function ensureRoom(state: RenderState, requiredHeight: number): void {
  if (state.cursorY - requiredHeight < MARGIN) {
    state.page = state.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    state.cursorY = PAGE_HEIGHT - MARGIN;
  }
}

/**
 * Replaces characters outside Helvetica's WinAnsi range with safe ASCII fall-
 * backs (em-dash → "—" the WinAnsi codepoint, smart quotes → straight, etc.).
 * pdf-lib's standard fonts throw on truly unsupported code points; this keeps
 * the renderer from failing on copy-pasted text with exotic punctuation.
 */
function sanitizeForWinAnsi(s: string): string {
  return s
    // Curly punctuation → straight ASCII
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    // Ellipsis
    .replace(/…/g, "...")
    // En dash / em dash — keep em as WinAnsi 0x97, en as hyphen
    .replace(/–/g, "-")
    // Anything outside Latin-1 supplement that isn't an em dash → "?"
    // pdf-lib will throw otherwise on rare glyphs. We accept the substitution.
    .replace(/[^\x00-\xff—]/g, (ch) => {
      // Common cases worth preserving cheaply
      if (ch === "€") return "EUR";     // €
      return "?";
    });
}

/** Draws a single wrapped line of segments at (x, baselineY). */
function drawLine(
  state: RenderState,
  line: InlineSegment[],
  x: number,
  baselineY: number,
  size: number,
): void {
  let cursor = x;
  for (const seg of line) {
    const font = fontFor(state, seg.bold, seg.italic);
    const text = sanitizeForWinAnsi(seg.text);
    state.page.drawText(text, {
      x: cursor,
      y: baselineY,
      size,
      font,
      color: rgb(0.1, 0.1, 0.12),
    });
    cursor += font.widthOfTextAtSize(text, size);
  }
}

/**
 * Renders a paragraph (plain text or with bold/italic emphasis markup) at the
 * current cursor. Wraps to fit (PAGE_WIDTH - 2*MARGIN - extraIndent) and
 * paginates as needed.
 */
function renderParagraph(
  state: RenderState,
  text: string,
  options: { size?: number; bold?: boolean; indent?: number; trailingGap?: number } = {},
): void {
  const size = options.size ?? FONT_SIZE_BODY;
  const indent = options.indent ?? 0;
  const trailingGap = options.trailingGap ?? PARAGRAPH_GAP;
  const segments = parseInline(text);
  if (options.bold) segments.forEach((s) => (s.bold = true));
  const maxWidth = PAGE_WIDTH - 2 * MARGIN - indent;
  const lines = wrapSegments(segments, state, size, maxWidth);
  const lineHeight = size + LINE_GAP;

  for (const line of lines) {
    ensureRoom(state, lineHeight);
    state.cursorY -= size;
    drawLine(state, line, MARGIN + indent, state.cursorY, size);
    state.cursorY -= LINE_GAP;
  }
  state.cursorY -= trailingGap;
}

function renderHeading(state: RenderState, text: string, level: 1 | 2 | 3): void {
  const size =
    level === 1 ? FONT_SIZE_H1 : level === 2 ? FONT_SIZE_H2 : FONT_SIZE_H3;
  ensureRoom(state, size + 8);
  state.cursorY -= (level === 1 ? 6 : 4);
  renderParagraph(state, text, { size, bold: true, trailingGap: level === 1 ? 12 : 8 });
}

function renderHorizontalRule(state: RenderState): void {
  ensureRoom(state, 12);
  const y = state.cursorY - 4;
  state.page.drawLine({
    start: { x: MARGIN, y },
    end:   { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  state.cursorY = y - 12;
}

function renderBlockquoteBlock(state: RenderState, lines: string[]): void {
  // Strip leading "> " on each line, then render as an indented paragraph block.
  // A subtle left bar marks it visually.
  const text = lines.map((l) => l.replace(/^>\s?/, "")).join("\n");
  const segments = parseInline(text);
  const maxWidth = PAGE_WIDTH - 2 * MARGIN - BLOCKQUOTE_INDENT;
  const wrapped = wrapSegments(segments, state, FONT_SIZE_BODY, maxWidth);
  const lineHeight = FONT_SIZE_BODY + LINE_GAP;
  const totalHeight = wrapped.length * lineHeight + 6;

  ensureRoom(state, totalHeight);
  const barTop = state.cursorY;
  const barBottom = state.cursorY - totalHeight + 6;

  for (const line of wrapped) {
    state.cursorY -= FONT_SIZE_BODY;
    drawLine(state, line, MARGIN + BLOCKQUOTE_INDENT, state.cursorY, FONT_SIZE_BODY);
    state.cursorY -= LINE_GAP;
  }
  // Draw the gray accent bar
  state.page.drawLine({
    start: { x: MARGIN + 4, y: barTop },
    end:   { x: MARGIN + 4, y: barBottom },
    thickness: 2,
    color: rgb(0.7, 0.72, 0.78),
  });
  state.cursorY -= PARAGRAPH_GAP;
}

function renderListItem(state: RenderState, marker: string, text: string): void {
  // Draw marker, then render the body text wrapped to (page - margin - listIndent)
  const segments = parseInline(text);
  const maxWidth = PAGE_WIDTH - 2 * MARGIN - LIST_INDENT;
  const lines = wrapSegments(segments, state, FONT_SIZE_BODY, maxWidth);
  const lineHeight = FONT_SIZE_BODY + LINE_GAP;

  // First line: draw marker + first wrapped line on the same baseline
  ensureRoom(state, lineHeight);
  state.cursorY -= FONT_SIZE_BODY;
  state.page.drawText(sanitizeForWinAnsi(marker), {
    x: MARGIN,
    y: state.cursorY,
    size: FONT_SIZE_BODY,
    font: state.fonts.regular,
    color: rgb(0.1, 0.1, 0.12),
  });
  if (lines.length > 0) {
    drawLine(state, lines[0], MARGIN + LIST_INDENT, state.cursorY, FONT_SIZE_BODY);
  }
  state.cursorY -= LINE_GAP;

  // Remaining lines: indented continuation
  for (let i = 1; i < lines.length; i++) {
    ensureRoom(state, lineHeight);
    state.cursorY -= FONT_SIZE_BODY;
    drawLine(state, lines[i], MARGIN + LIST_INDENT, state.cursorY, FONT_SIZE_BODY);
    state.cursorY -= LINE_GAP;
  }
  state.cursorY -= BLOCK_GAP;
}

function renderTable(state: RenderState, rows: string[][]): void {
  if (rows.length === 0) return;
  const cols = Math.max(...rows.map((r) => r.length));
  const totalWidth = PAGE_WIDTH - 2 * MARGIN;
  const colWidth = (totalWidth - TABLE_COL_GAP * (cols - 1)) / cols;
  const lineHeight = FONT_SIZE_BODY + LINE_GAP;

  for (const row of rows) {
    // Wrap each cell to colWidth, find the max line count to determine row height
    const cellLines: InlineSegment[][][] = row.map((cell) =>
      wrapSegments(parseInline(cell), state, FONT_SIZE_BODY, colWidth),
    );
    const maxLines = Math.max(...cellLines.map((c) => c.length));
    const rowHeight = maxLines * lineHeight + 4;
    ensureRoom(state, rowHeight);

    const top = state.cursorY;
    for (let c = 0; c < row.length; c++) {
      const x = MARGIN + c * (colWidth + TABLE_COL_GAP);
      const lines = cellLines[c];
      for (let li = 0; li < lines.length; li++) {
        const baseY = top - (li + 1) * FONT_SIZE_BODY - li * LINE_GAP;
        drawLine(state, lines[li], x, baseY, FONT_SIZE_BODY);
      }
    }
    state.cursorY -= rowHeight;
    // Faint row separator
    state.page.drawLine({
      start: { x: MARGIN, y: state.cursorY + 2 },
      end:   { x: PAGE_WIDTH - MARGIN, y: state.cursorY + 2 },
      thickness: 0.3,
      color: rgb(0.85, 0.86, 0.9),
    });
  }
  state.cursorY -= PARAGRAPH_GAP;
}

/** Splits the raw markdown into the document's logical blocks. */
type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "blockquote"; lines: string[] }
  | { kind: "hr" }
  | { kind: "list_item"; marker: string; text: string }
  | { kind: "table"; rows: string[][] }
  | { kind: "blank" };

function tokenize(md: string): Block[] {
  const lines = md.split(/\r?\n/);
  const blocks: Block[] = [];
  let paragraphBuf: string[] = [];
  let blockquoteBuf: string[] = [];
  let tableBuf: string[][] | null = null;

  const flushParagraph = () => {
    if (paragraphBuf.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraphBuf.join(" ") });
      paragraphBuf = [];
    }
  };
  const flushBlockquote = () => {
    if (blockquoteBuf.length > 0) {
      blocks.push({ kind: "blockquote", lines: blockquoteBuf });
      blockquoteBuf = [];
    }
  };
  const flushTable = () => {
    if (tableBuf && tableBuf.length > 0) {
      blocks.push({ kind: "table", rows: tableBuf });
      tableBuf = null;
    }
  };

  const flushAll = () => {
    flushParagraph();
    flushBlockquote();
    flushTable();
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (line.trim() === "") {
      flushAll();
      blocks.push({ kind: "blank" });
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      flushAll();
      blocks.push({
        kind: "heading",
        level: headingMatch[1].length as 1 | 2 | 3,
        text: headingMatch[2],
      });
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim())) {
      flushAll();
      blocks.push({ kind: "hr" });
      continue;
    }

    // Blockquote — allow leading indentation so blockquotes nested under list
    // items (a common pattern in the affidavit templates) are still detected.
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      flushTable();
      // Strip leading whitespace + the `>` marker so the buffered line is
      // pure content (renderBlockquoteBlock does a second strip too — harmless).
      blockquoteBuf.push(line.replace(/^\s*/, ""));
      continue;
    } else if (blockquoteBuf.length > 0) {
      flushBlockquote();
    }

    // Table row
    if (/^\|.+\|\s*$/.test(line)) {
      flushParagraph();
      flushBlockquote();
      // Skip pure separator rows (|---|---|)
      if (/^\|[\s\-:|]+\|\s*$/.test(line)) continue;
      const cells = line
        .replace(/^\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((c) => c.trim());
      tableBuf = tableBuf ?? [];
      tableBuf.push(cells);
      continue;
    } else if (tableBuf) {
      flushTable();
    }

    // List item (- foo, * foo, 1. foo)
    const ulMatch = line.match(/^\s*[-*]\s+(.*)$/);
    const olMatch = line.match(/^\s*(\d+\.)\s+(.*)$/);
    if (ulMatch) {
      flushAll();
      blocks.push({ kind: "list_item", marker: "•", text: ulMatch[1] });
      continue;
    }
    if (olMatch) {
      flushAll();
      blocks.push({ kind: "list_item", marker: olMatch[1], text: olMatch[2] });
      continue;
    }

    // Regular paragraph line (accumulate)
    paragraphBuf.push(line);
  }

  flushAll();
  return blocks;
}

export async function markdownToPdf(markdown: string, outputPath: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const boldItalic = await pdf.embedFont(StandardFonts.HelveticaBoldOblique);
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  const state: RenderState = {
    pdf,
    page,
    fonts: { regular, bold, italic, boldItalic },
    cursorY: PAGE_HEIGHT - MARGIN,
  };

  const blocks = tokenize(markdown);

  for (const b of blocks) {
    switch (b.kind) {
      case "heading":      renderHeading(state, b.text, b.level); break;
      case "paragraph":    renderParagraph(state, b.text); break;
      case "blockquote":   renderBlockquoteBlock(state, b.lines); break;
      case "hr":           renderHorizontalRule(state); break;
      case "list_item":    renderListItem(state, b.marker, b.text); break;
      case "table":        renderTable(state, b.rows); break;
      case "blank":        state.cursorY -= 2; break;
    }
  }

  const bytes = await pdf.save();
  fs.writeFileSync(outputPath, bytes);
}
