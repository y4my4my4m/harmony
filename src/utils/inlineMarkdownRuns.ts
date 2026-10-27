/**
 * Inline markdown across the parts of a message.
 *
 * A message is stored as parts: text, and between them links, mentions, emoji. Each inline
 * run of parts renders as one string, its non-text parts standing in as PART_SENTINEL, so a
 * marker pair around a link (`**bold https://x.com still bold**`, `**[a](url)**`) matches.
 * The sanitized HTML then splits at the sentinels: each text part receives its own slice,
 * with the elements open at its edges closed and reopened, and each non-text part receives
 * the inline formatting elements open around it (InlineMark), which the component draws
 * around it.
 *
 * A quote holding a non-text part is lifted out of the HTML: the text before, inside and after
 * it comes in pieces, each piece and each non-text part naming the quote it sits in, and the
 * component draws one blockquote around them.
 *
 * Spoiler and quote group ids are unique within one call of renderInlineRuns (one message).
 *
 * Stored content is unchanged; this is display only.
 */

import { sanitizeMessageHtml } from './sanitize';
import type { CodeBlock } from './chatMessageTextRenderer';

/** U+FDD0, a Unicode noncharacter: reserved for internal use, never meaningful in text. */
export const PART_SENTINEL = '﷐';
const SENTINEL_RE = /﷐/g;

// blockquote: the element drawn around a lifted quote's group, never a mark of one part.
export type InlineMarkTag = 'strong' | 'em' | 'u' | 'del' | 'span' | 'code' | 'blockquote';

/** An inline formatting element open around a non-text part. */
export interface InlineMark {
  tag: InlineMarkTag;
  className: string;
}

/** One message part, as a run sees it. */
export type RunPart =
  | { kind: 'text'; text: string }
  /** Drawn inline in the text flow: link, mention, hashtag, channel, custom emoji. */
  | { kind: 'inline' }
  /** Ends the run: media, files, embeds, polls. */
  | { kind: 'block' };

/** A piece of a text part's HTML; `quote` names the lifted quote it sits in. */
export interface TextPiece {
  html: string;
  quote?: number;
}

export interface RenderedRunText {
  html: string;
  codeBlocks: CodeBlock[];
  /** `html` in pieces, when some of it sits in a lifted quote. */
  pieces?: TextPiece[];
}

export interface InlineRuns {
  /** By part index: the text part's HTML, code-block placeholders intact. */
  text: Array<RenderedRunText | undefined>;
  /** By part index: formatting open around the non-text part, outermost first. */
  marks: Array<InlineMark[] | undefined>;
  /** By part index: the lifted quote the non-text part sits in. */
  quotes: Array<number | undefined>;
}

type RenderText = (text: string) => { renderedText: string; codeBlocks: CodeBlock[] };

// Elements carried onto a non-text part. A blockquote is lifted instead (splitAtSentinels).
const MARK_CLASSES: Record<string, { tag: InlineMarkTag; className: string }> = {
  'STRONG md-bold': { tag: 'strong', className: 'md-bold' },
  'EM md-italic': { tag: 'em', className: 'md-italic' },
  'U md-underline': { tag: 'u', className: 'md-underline' },
  'DEL md-strikethrough': { tag: 'del', className: 'md-strikethrough' },
  'SPAN md-spoiler': { tag: 'span', className: 'md-spoiler' },
  'SPAN md-greentext': { tag: 'span', className: 'md-greentext' },
  'CODE md-code': { tag: 'code', className: 'md-code' },
};

/** Class carried by every piece of one spoiler split across parts; a click reveals them all. */
export const SPOILER_GROUP_PREFIX = 'md-spoiler-group-';

function markOf(el: Element): InlineMark | null {
  const classes = (el.getAttribute('class') ?? '').split(/\s+/);
  for (const cls of classes) {
    const mark = MARK_CLASSES[`${el.tagName} ${cls}`];
    if (!mark) continue;
    const group = classes.find((c) => c.startsWith(SPOILER_GROUP_PREFIX));
    return { tag: mark.tag, className: group ? `${mark.className} ${group}` : mark.className };
  }
  return null;
}

// Clones of the elements open at a split are empty on the side the split leaves bare.
function pruneEmpty(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    if (el.tagName === 'IMG' || el.tagName === 'BR') continue;
    pruneEmpty(el);
    if (el.querySelector('img, br')) continue;
    const text = el.textContent ?? '';
    if (text === '' || (el.tagName === 'BLOCKQUOTE' && !text.trim())) el.remove();
  }
}

interface SplitHtml {
  /** Chunk k: the HTML after the k-th sentinel, in pieces. */
  chunks: TextPiece[][];
  marks: InlineMark[][];
  /** By sentinel: the lifted quote it sits in. */
  quotes: Array<number | undefined>;
}

/** Next free group ids; shared by every run of one message. */
export interface GroupIds {
  spoiler: number;
  quote: number;
}

/**
 * Splits sanitized HTML at each PART_SENTINEL; null when the DOM is unavailable or a quote
 * holding a sentinel sits inside another element.
 */
export function splitAtSentinels(html: string, ids: GroupIds = { spoiler: 0, quote: 0 }): SplitHtml | null {
  if (typeof document === 'undefined') return null;
  const template = document.createElement('template');
  template.innerHTML = html;

  const chunks: TextPiece[][] = [];
  const marks: InlineMark[][] = [];
  const quotes: Array<number | undefined> = [];
  const source: Element[] = [];
  let out: Node[] = [document.createElement('div')];
  let pieces: TextPiece[] = [];
  let quote: number | undefined;

  const reopen = () => {
    const next: Node[] = [document.createElement('div')];
    for (const el of source) {
      const clone = el.cloneNode(false);
      next[next.length - 1].appendChild(clone);
      next.push(clone);
    }
    out = next;
  };

  const endPiece = () => {
    const root = out[0] as HTMLElement;
    pruneEmpty(root);
    const piece = sanitizeMessageHtml(root.innerHTML);
    if (piece) pieces.push(quote === undefined ? { html: piece } : { html: piece, quote });
    reopen();
  };

  const atSentinel = () => {
    source.forEach((el, depth) => {
      const classes = el.classList;
      if (!classes.contains('md-spoiler')) return;
      if (Array.from(classes).some((c) => c.startsWith(SPOILER_GROUP_PREFIX))) return;
      const group = `${SPOILER_GROUP_PREFIX}${ids.spoiler++}`;
      classes.add(group);
      (out[depth + 1] as Element).classList.add(group);
    });
    marks.push(source.map(markOf).filter((m): m is InlineMark => m !== null));
    quotes.push(quote);
    endPiece();
    chunks.push(pieces);
    pieces = [];
  };

  let nested = false;
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      const parent = out[out.length - 1];
      if (child.nodeType === 3) {
        const parts = (child as Text).data.split(PART_SENTINEL);
        parts.forEach((piece, i) => {
          if (i > 0) atSentinel();
          if (piece) out[out.length - 1].appendChild(document.createTextNode(piece));
        });
      } else if (child.nodeType === 1) {
        const el = child as Element;
        if (el.tagName === 'BLOCKQUOTE' && (el.textContent ?? '').includes(PART_SENTINEL)) {
          if (source.length > 0 || quote !== undefined) {
            nested = true;
            return;
          }
          endPiece();
          quote = ids.quote++;
          walk(el);
          endPiece();
          quote = undefined;
          continue;
        }
        const clone = el.cloneNode(false);
        parent.appendChild(clone);
        source.push(el);
        out.push(clone);
        walk(el);
        source.pop();
        out.pop();
      }
      if (nested) return;
    }
  };

  walk(template.content);
  if (nested) return null;
  endPiece();
  chunks.push(pieces);
  return { chunks, marks, quotes };
}

function renderAlone(part: { text: string }, render: RenderText): RenderedRunText {
  const { renderedText, codeBlocks } = render(part.text.replace(SENTINEL_RE, ''));
  return { html: renderedText, codeBlocks };
}

/**
 * Renders the text parts of `parts`, letting inline markdown span the non-text parts of
 * each run. A run whose sentinels the renderer did not keep in text (one inside a fenced
 * code block) renders part by part.
 */
export function renderInlineRuns(parts: readonly RunPart[], render: RenderText): InlineRuns {
  const text: InlineRuns['text'] = new Array(parts.length);
  const marks: InlineRuns['marks'] = new Array(parts.length);
  const quotes: InlineRuns['quotes'] = new Array(parts.length);
  const out: InlineRuns = { text, marks, quotes };
  const ids: GroupIds = { spoiler: 0, quote: 0 };

  let start = 0;
  while (start < parts.length) {
    if (parts[start].kind === 'block') {
      start++;
      continue;
    }
    let end = start;
    while (end < parts.length && parts[end].kind !== 'block') end++;
    renderRun(parts, start, end, render, out, ids);
    start = end;
  }
  return out;
}

function renderRun(
  parts: readonly RunPart[],
  start: number,
  end: number,
  render: RenderText,
  { text, marks, quotes }: InlineRuns,
  ids: GroupIds,
): void {
  let inlineCount = 0;
  let textCount = 0;
  for (let i = start; i < end; i++) {
    if (parts[i].kind === 'inline') inlineCount++;
    else textCount++;
  }

  const alone = () => {
    for (let i = start; i < end; i++) {
      const part = parts[i];
      if (part.kind === 'text') text[i] = renderAlone(part, render);
    }
  };
  if (inlineCount === 0 || textCount === 0) {
    alone();
    return;
  }

  let joined = '';
  for (let i = start; i < end; i++) {
    const part = parts[i];
    joined += part.kind === 'text' ? part.text.replace(SENTINEL_RE, '') : PART_SENTINEL;
  }
  const { renderedText, codeBlocks } = render(joined);
  const split = splitAtSentinels(renderedText, ids);
  if (!split || split.chunks.length !== inlineCount + 1) {
    alone();
    return;
  }

  // Chunk k is the text after the k-th non-text part; adjacent text parts share one chunk,
  // held by the first of them.
  let chunk = 0;
  let chunkTaken = false;
  for (let i = start; i < end; i++) {
    const part = parts[i];
    if (part.kind === 'inline') {
      marks[i] = split.marks[chunk];
      quotes[i] = split.quotes[chunk];
      chunk++;
      chunkTaken = false;
    } else {
      const pieces = chunkTaken ? [] : split.chunks[chunk];
      const html = pieces.map((p) => p.html).join('');
      text[i] = pieces.some((p) => p.quote !== undefined) ? { html, codeBlocks, pieces } : { html, codeBlocks };
      chunkTaken = true;
    }
  }
}
