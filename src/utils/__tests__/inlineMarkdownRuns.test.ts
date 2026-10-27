import { describe, expect, it } from 'vitest';
import { renderChatMessageText, type ChatMessageRendererOptions } from '../chatMessageTextRenderer';
import { PART_SENTINEL, renderInlineRuns, splitAtSentinels, type RunPart } from '../inlineMarkdownRuns';

const options: ChatMessageRendererOptions = {
  isNativePack: true,
  emojiServiceLoaded: false,
  resolveEmoji: () => ({ display: { type: 'native', content: '' } }),
  isSingleEmoji: false,
  greentextEnabled: true,
};
const render = (text: string) => renderChatMessageText(text, options);

const text = (t: string): RunPart => ({ kind: 'text', text: t });
const inline: RunPart = { kind: 'inline' };
const block: RunPart = { kind: 'block' };

function htmlOf(parts: RunPart[]) {
  const runs = renderInlineRuns(parts, render);
  return { runs, html: runs.text.map((r) => r?.html) };
}

describe('renderInlineRuns', () => {
  it('bold spans a link: both text parts are bold, the link carries the mark', () => {
    const { runs, html } = htmlOf([text('**bold '), inline, text(' still bold**')]);
    expect(html[0]).toBe('<strong class="md-bold">bold </strong>');
    expect(html[2]).toBe('<strong class="md-bold"> still bold</strong>');
    expect(runs.marks[1]).toEqual([{ tag: 'strong', className: 'md-bold' }]);
    expect(html.join('')).not.toContain('**');
  });

  it('a masked link inside ** **: markers vanish, empty halves render nothing', () => {
    const { runs, html } = htmlOf([text('**'), inline, text('**')]);
    expect(html[0]).toBe('');
    expect(html[2]).toBe('');
    expect(runs.marks[1]).toEqual([{ tag: 'strong', className: 'md-bold' }]);
  });

  it('nested marks are listed outermost first', () => {
    const { runs } = htmlOf([text('**_a '), inline, text(' b_**')]);
    expect(runs.marks[1]).toEqual([
      { tag: 'strong', className: 'md-bold' },
      { tag: 'em', className: 'md-italic' },
    ]);
  });

  it('italic, underline, strikethrough and inline code span a mention', () => {
    expect(htmlOf([text('*x '), inline, text('*')]).runs.marks[1]).toEqual([{ tag: 'em', className: 'md-italic' }]);
    expect(htmlOf([text('__x '), inline, text('__')]).runs.marks[1]).toEqual([{ tag: 'u', className: 'md-underline' }]);
    expect(htmlOf([text('~~x '), inline, text('~~')]).runs.marks[1]).toEqual([{ tag: 'del', className: 'md-strikethrough' }]);
    expect(htmlOf([text('`x '), inline, text('`')]).runs.marks[1]).toEqual([{ tag: 'code', className: 'md-code' }]);
  });

  it('a spoiler split around a part shares one group class across its pieces', () => {
    const { runs, html } = htmlOf([text('||secret '), inline, text(' more||')]);
    const group = /md-spoiler-group-\d+/.exec(html[0] ?? '')?.[0];
    expect(group).toBeTruthy();
    expect(html[2]).toContain(group!);
    expect(runs.marks[1]).toEqual([{ tag: 'span', className: `md-spoiler ${group}` }]);
  });

  it('unpaired markers stay literal, as in a single part', () => {
    const { runs, html } = htmlOf([text('2 ** 3 '), inline, text(' end')]);
    expect(html[0]).toBe('2 ** 3 ');
    expect(html[2]).toBe(' end');
    expect(runs.marks[1]).toEqual([]);
  });

  it('formatting closes at a block part', () => {
    const { runs, html } = htmlOf([text('**a '), block, text(' b**')]);
    expect(html[0]).toBe('**a ');
    expect(html[2]).toBe(' b**');
    expect(runs.marks[1]).toBeUndefined();
  });

  it('a lone text part renders as before', () => {
    const { html } = htmlOf([text('**bold** and *it*')]);
    expect(html[0]).toBe(render('**bold** and *it*').renderedText);
  });

  it('a sentinel the user typed is dropped, not taken for a part', () => {
    const { runs, html } = htmlOf([text(`**a${PART_SENTINEL} `), inline, text(' b**')]);
    expect(html[0]).toBe('<strong class="md-bold">a </strong>');
    expect(runs.marks[1]).toEqual([{ tag: 'strong', className: 'md-bold' }]);
  });

  it('a part inside a fenced code block falls back to part-by-part rendering', () => {
    const { runs, html } = htmlOf([text('```\ncode '), inline, text(' more\n```')]);
    expect(runs.marks[1]).toBeUndefined();
    expect(html[0]).toBe(render('```\ncode ').renderedText);
    expect(html[2]).toBe(render(' more\n```').renderedText);
  });

  it('adjacent text parts share one slice, held by the first', () => {
    const { html } = htmlOf([text('**a '), text('b '), inline, text(' c**')]);
    expect(html[0]).toBe('<strong class="md-bold">a b </strong>');
    expect(html[1]).toBe('');
    expect(html[3]).toBe('<strong class="md-bold"> c</strong>');
  });

  it('a quote holding a part is lifted: its text and the part name one quote', () => {
    const { runs } = htmlOf([text('> quote '), inline, text(' rest')]);
    expect(runs.text[0]?.pieces).toEqual([{ html: 'quote ', quote: 0 }]);
    expect(runs.quotes[1]).toBe(0);
    expect(runs.marks[1]).toEqual([]);
    expect(runs.text[2]?.pieces).toEqual([{ html: ' rest', quote: 0 }]);
    expect(runs.text.map((r) => r?.html).join('')).not.toContain('blockquote');
  });

  it('text around a lifted quote stays outside it', () => {
    const { runs } = htmlOf([text('intro\n> quote '), inline, text(' rest\nafter')]);
    expect(runs.text[0]?.pieces).toEqual([{ html: 'intro<br>' }, { html: 'quote ', quote: 0 }]);
    expect(runs.quotes[1]).toBe(0);
    expect(runs.text[2]?.pieces).toEqual([{ html: ' rest', quote: 0 }, { html: '<br>after' }]);
  });

  it('a quote line ending at a part leaves no empty piece behind', () => {
    const { runs } = htmlOf([text('> quote '), inline, text('\nplain')]);
    expect(runs.text[0]?.pieces).toEqual([{ html: 'quote ', quote: 0 }]);
    expect(runs.quotes[1]).toBe(0);
    expect(runs.text[2]?.pieces).toBeUndefined();
    expect(runs.text[2]?.html).toBe('<br>plain');
  });

  it('formatting inside a lifted quote is carried as usual', () => {
    const { runs } = htmlOf([text('> **q '), inline, text('** r')]);
    expect(runs.quotes[1]).toBe(0);
    expect(runs.marks[1]).toEqual([{ tag: 'strong', className: 'md-bold' }]);
    expect(runs.text[2]?.pieces).toEqual([{ html: ' r', quote: 0 }]);
  });

  it('a quote without a part stays in the HTML', () => {
    const { runs } = htmlOf([text('> plain quote\nx '), inline, text(' y')]);
    expect(runs.text[0]?.html).toContain('<blockquote class="md-blockquote">plain quote</blockquote>');
    expect(runs.text[0]?.pieces).toBeUndefined();
    expect(runs.quotes[1]).toBeUndefined();
  });

  it('spoiler and quote groups are unique across the runs of a message', () => {
    const { runs, html } = htmlOf([
      text('||a '), inline, text(' b||'), block,
      text('||c '), inline, text(' d|| \n> e '), inline, block,
      text('> f '), inline,
    ]);
    const groupOf = (h: string | undefined) => /md-spoiler-group-\d+/.exec(h ?? '')?.[0];
    expect(groupOf(html[0])).toBeTruthy();
    expect(groupOf(html[4])).toBeTruthy();
    expect(groupOf(html[4])).not.toBe(groupOf(html[0]));
    expect(runs.marks[5]?.[0].className).toContain(groupOf(html[4])!);
    expect(runs.quotes[7]).toBeDefined();
    expect(runs.quotes[10]).toBeDefined();
    expect(runs.quotes[10]).not.toBe(runs.quotes[7]);
  });

  it('a part right after a line start is no quote marker', () => {
    const { html } = htmlOf([inline, text('>not green')]);
    expect(html[1]).not.toContain('md-greentext');
  });

  it('HTML in text stays text across the split', () => {
    const { html } = htmlOf([text('**<img src=x onerror=alert(1)> '), inline, text(' <script>x</script>**')]);
    const container = document.createElement('div');
    container.innerHTML = (html[0] ?? '') + (html[2] ?? '');
    expect(container.querySelector('img, script')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('splitAtSentinels', () => {
  it('leaves a quote holding a sentinel inside another element to part-by-part rendering', () => {
    expect(splitAtSentinels(`<span class="md-spoiler"><blockquote class="md-blockquote">a${PART_SENTINEL}</blockquote></span>`)).toBeNull();
  });

  it('closes and reopens the open elements at each sentinel', () => {
    const split = splitAtSentinels(`<strong class="md-bold">a${PART_SENTINEL}b${PART_SENTINEL}c</strong>`);
    expect(split?.chunks).toEqual([
      [{ html: '<strong class="md-bold">a</strong>' }],
      [{ html: '<strong class="md-bold">b</strong>' }],
      [{ html: '<strong class="md-bold">c</strong>' }],
    ]);
    expect(split?.marks).toHaveLength(2);
  });

  it('keeps an inline emoji image in an otherwise empty slice', () => {
    const split = splitAtSentinels(`<strong class="md-bold"><img class="inline-emoji" src="a.svg" alt="x">${PART_SENTINEL}</strong>`);
    expect(split?.chunks[0][0].html).toContain('<img');
  });
});
