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
 * Stored content is unchanged; this is display only.
 */

import { sanitizeMessageHtml } from './sanitize';
import type { CodeBlock } from './chatMessageTextRenderer';

/** U+FDD0, a Unicode noncharacter: reserved for internal use, never meaningful in text. */
export const PART_SENTINEL = '﷐';
const SENTINEL_RE = /﷐/g;

export type InlineMarkTag = 'strong' | 'em' | 'u' | 'del' | 'span' | 'code';

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

export interface RenderedRunText {
  html: string;
  codeBlocks: CodeBlock[];
}

export interface InlineRuns {
  /** By part index: the text part's HTML, code-block placeholders intact. */
  text: Array<RenderedRunText | undefined>;
  /** By part index: formatting open around the non-text part, outermost first. */
  marks: Array<InlineMark[] | undefined>;
}

type RenderText = (text: string) => { renderedText: string; codeBlocks: CodeBlock[] };

// Elements carried onto a non-text part. Block elements (blockquote) are not: a part cannot
// sit inside a v-html block.
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
  chunks: string[];
  marks: InlineMark[][];
}

/** Splits sanitized HTML at each PART_SENTINEL; null when the DOM is unavailable. */
export function splitAtSentinels(html: string): SplitHtml | null {
  if (typeof document === 'undefined') return null;
  const template = document.createElement('template');
  template.innerHTML = html;

  const chunks: string[] = [];
  const marks: InlineMark[][] = [];
  const source: Element[] = [];
  let out: Node[] = [document.createElement('div')];
  let spoilerGroups = 0;

  const flush = () => {
    const root = out[0] as HTMLElement;
    pruneEmpty(root);
    chunks.push(sanitizeMessageHtml(root.innerHTML));
    const next: Node[] = [document.createElement('div')];
    for (const el of source) {
      const clone = el.cloneNode(false);
      next[next.length - 1].appendChild(clone);
      next.push(clone);
    }
    out = next;
  };

  const atSentinel = () => {
    source.forEach((el, depth) => {
      const classes = el.classList;
      if (!classes.contains('md-spoiler')) return;
      if (Array.from(classes).some((c) => c.startsWith(SPOILER_GROUP_PREFIX))) return;
      const group = `${SPOILER_GROUP_PREFIX}${spoilerGroups++}`;
      classes.add(group);
      (out[depth + 1] as Element).classList.add(group);
    });
    marks.push(source.map(markOf).filter((m): m is InlineMark => m !== null));
    flush();
  };

  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      const parent = out[out.length - 1];
      if (child.nodeType === 3) {
        const pieces = (child as Text).data.split(PART_SENTINEL);
        pieces.forEach((piece, i) => {
          if (i > 0) atSentinel();
          if (piece) out[out.length - 1].appendChild(document.createTextNode(piece));
        });
      } else if (child.nodeType === 1) {
        const clone = child.cloneNode(false);
        parent.appendChild(clone);
        source.push(child as Element);
        out.push(clone);
        walk(child);
        source.pop();
        out.pop();
      }
    }
  };

  walk(template.content);
  const root = out[0] as HTMLElement;
  pruneEmpty(root);
  chunks.push(sanitizeMessageHtml(root.innerHTML));
  return { chunks, marks };
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

  let start = 0;
  while (start < parts.length) {
    if (parts[start].kind === 'block') {
      start++;
      continue;
    }
    let end = start;
    while (end < parts.length && parts[end].kind !== 'block') end++;
    renderRun(parts, start, end, render, text, marks);
    start = end;
  }
  return { text, marks };
}

function renderRun(
  parts: readonly RunPart[],
  start: number,
  end: number,
  render: RenderText,
  text: InlineRuns['text'],
  marks: InlineRuns['marks'],
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
  const split = splitAtSentinels(renderedText);
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
      chunk++;
      chunkTaken = false;
    } else {
      text[i] = { html: chunkTaken ? '' : split.chunks[chunk], codeBlocks };
      chunkTaken = true;
    }
  }
}
