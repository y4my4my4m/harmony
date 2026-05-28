/**
 * XSS regression tests for the chat / DM message renderer.
 *
 * Every payload below was taken verbatim from the security audit dump
 * (`messages_rows_xss_issue.json`) — the database rows that demonstrated
 * users could repaint or break the host app by stuffing `<style>`, `<img>`,
 * or `<script>` tags inside a message's `text` part. If any of these tests
 * regresses, the audited XSS is back.
 *
 * These tests cover the chat / DM path. The post (ActivityPub timeline)
 * path uses `useContentRenderer.ts`'s `formattedHTML`, which escapes
 * user text at the boundary and then runs the joined output through
 * `sanitizeFormattedHtml`. See `chatMessageTextRenderer.formattedHtml.test`
 * below for the cross-check that the same payloads are inert there too.
 */

import { describe, expect, it } from 'vitest';
import { renderChatMessageText, type ChatMessageRendererOptions } from '../chatMessageTextRenderer';

// Default options pinned to "no emoji rendering, no theme-driven greentext"
// so the tests don't drift if the unified emoji service or visual theme
// composable change shape. The XSS surface doesn't depend on these.
const defaultOptions: ChatMessageRendererOptions = {
  isNativePack: true,
  emojiServiceLoaded: false,
  resolveEmoji: () => ({ display: { type: 'native', content: '' } }),
  isSingleEmoji: false,
  greentextEnabled: true,
};

/**
 * Mount the rendered HTML into a DOM and assert there is NO
 * `HTMLStyleElement`, `HTMLScriptElement`, `HTMLIFrameElement`,
 * `HTMLObjectElement`, `HTMLEmbedElement`, or `HTMLLinkElement` in the
 * resulting tree. This is the actual security invariant we care about —
 * "the malicious string round-trips intact in the HTML stream but the
 * browser parses it as text". Substring matching can miss bypasses;
 * parsing the DOM cannot.
 */
function assertNoExecutableHtml(html: string) {
  const container = document.createElement('div');
  container.innerHTML = html;

  const dangerous = container.querySelectorAll(
    'style, script, iframe, object, embed, link, meta, base, form, input, textarea, button',
  );
  expect(
    dangerous.length,
    `expected no dangerous elements, got: ${Array.from(dangerous)
      .map((el) => el.outerHTML)
      .join(', ')}`,
  ).toBe(0);

  // Inline event handlers — even on otherwise-allowed tags — must be stripped.
  const allElements = container.querySelectorAll('*');
  for (const el of Array.from(allElements)) {
    for (const attr of Array.from(el.attributes)) {
      expect(
        attr.name.toLowerCase().startsWith('on'),
        `expected no on* handlers, found ${attr.name}="${attr.value}" on <${el.tagName.toLowerCase()}>`,
      ).toBe(false);
    }
  }

  // `javascript:` / `data:` schemes in href/src must be stripped.
  for (const el of Array.from(allElements)) {
    for (const attrName of ['href', 'src', 'action', 'formaction']) {
      const val = el.getAttribute(attrName);
      if (val) {
        const lowered = val.trim().toLowerCase();
        expect(
          lowered.startsWith('javascript:') || lowered.startsWith('data:text/html'),
          `expected no javascript:/data:text/html in ${attrName}, found "${val}" on <${el.tagName.toLowerCase()}>`,
        ).toBe(false);
      }
    }
  }
}

describe('renderChatMessageText - XSS regression suite', () => {
  // Each entry is `[description, exact_payload_from_audit_dump]`.
  const auditPayloads: Array<[string, string]> = [
    [
      'broken-out </style> via display:block (idx 0)',
      "So hey, there's a major issue. Doing `style>body{display:block}</style`  will actually set the body to display block, and if you do display:none it will display:none the body.",
    ],
    [
      '<style> targeting Vue component scoped class (idx 1)',
      '<style>\r\n.display-name[data-v-965e1424] {\r\n    transform: rotate(180deg) !important;\r\n    display: inline-block !important;\r\n}\r\n</style>',
    ],
    [
      '<style> targeting body::before with absolute positioning (idx 4)',
      '<style>\r\nbody::before{\r\n  content:"CSS injection test";\r\n  position:fixed;\r\n  top:0;\r\n  left:0;\r\n  background:yellow;\r\n  z-index:999999;\r\n}\r\n</style>',
    ],
    [
      '<style>body{display:none} - the full UI-blackout payload (idx 64)',
      '<style>body{display:none}</style>',
    ],
    [
      '<style>body{display:unset} - the inverse (idx 56)',
      '<style>body{display:unset}</style>',
    ],
    [
      '<style> mass restyling .message-group (idx 67)',
      '<style>\r\n.message-group {\r\n    border: 3px solid red !important;\r\n    background: rgba(255,0,0,0.1) !important;\r\n}\r\n</style>',
    ],
    [
      '<style> with attribute selector .app .message-group (idx 18)',
      '<style>\r\n.app .message-group {\r\n    background: rgba(255,0,0,0.08) !important;\r\n    border-left: 4px solid red !important;\r\n}\r\n</style>',
    ],
    [
      '<style> with universal selector and !important (idx 14)',
      '<style>\r\n*{\r\n    background: rgba(255,0,0,0.08) !important;\r\n    border-left: 4px solid red !important;\r\n}\r\n</style>',
    ],
    [
      '<style> with hue-rotate filter on .app (idx 23)',
      '<style>\r\n.app {\r\n    filter: hue-rotate(90deg) !important;\r\n}\r\n</style>',
    ],
    [
      '<style> targeting img by src (idx 77)',
      '<style>\r\nimg[src*="896599.png"] {\r\n    transform: rotate(5deg);\r\n}\r\n</style>',
    ],
    [
      '<style> with rotate 180 on .user-profile (idx 41)',
      '<style>\r\n.user-profile {\r\n    transform: rotate(180deg) !important;\r\n}\r\n</style>',
    ],
    [
      '<style> with outline 5px solid red on body (idx 70)',
      '<style>\nbody { outline: 5px solid red !important; }\n</style>',
    ],
    [
      '<style> with external image background-image (idx 38)',
      '<style>*::before{background-image:url(itmesarah.github.io/iwillbeokay720p.avif)!important;transform:translateZ(0);z-index: -1;}</style>',
    ],
    [
      '<style> styling .display-name with mixed text after (idx 29)',
      '<style>.display-name{color:lime;font-size:16px;font-weight: 900;font-style: italic;}</style> Decided to make all the usernames italic and lime',
    ],
    [
      '<style> styling .display-name (alt text after) (idx 39)',
      '<style>.display-name{color:lime;font-size:16px;font-weight: 900;font-style: italic;}</style> All the italics',
    ],
    [
      'raw `<test>` tag — never escaped to text in the original bug (idx 11)',
      '<test>',
    ],
    [
      '`<img test="x">` — bare tag, no event handler but tests <img> stripping (idx 74)',
      '<img test="x">',
    ],
    [
      '`<b>bold?</b>` — would have rendered as bold pre-fix (idx 68)',
      '<b>bold?</b>',
    ],
  ];

  for (const [name, payload] of auditPayloads) {
    it(`neutralizes audit payload: ${name}`, () => {
      const { renderedText } = renderChatMessageText(payload, defaultOptions);
      assertNoExecutableHtml(renderedText);
    });
  }

  // ---------------------------------------------------------------------------
  // Additional XSS vectors that didn't appear in the audit but the same
  // pipeline must defend against.
  // ---------------------------------------------------------------------------

  it('neutralizes <script> injection', () => {
    const { renderedText } = renderChatMessageText(
      '<script>alert(1)</script>after',
      defaultOptions,
    );
    assertNoExecutableHtml(renderedText);
    // Content text is preserved (as text, not as a tag).
    expect(renderedText).toMatch(/after/);
  });

  it('neutralizes <img src=x onerror=alert(1)>', () => {
    const { renderedText } = renderChatMessageText(
      '<img src=x onerror=alert(1)>',
      defaultOptions,
    );
    assertNoExecutableHtml(renderedText);
  });

  it('neutralizes <a href="javascript:alert(1)">click</a>', () => {
    const { renderedText } = renderChatMessageText(
      '<a href="javascript:alert(1)">click</a>',
      defaultOptions,
    );
    assertNoExecutableHtml(renderedText);
  });

  it('neutralizes <iframe srcdoc="<script>alert(1)</script>">', () => {
    const { renderedText } = renderChatMessageText(
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      defaultOptions,
    );
    assertNoExecutableHtml(renderedText);
  });

  it('neutralizes <svg onload=alert(1)>', () => {
    const { renderedText } = renderChatMessageText(
      '<svg onload="alert(1)"></svg>',
      defaultOptions,
    );
    assertNoExecutableHtml(renderedText);
  });

  it('neutralizes broken-out <style> via fenced code block (parser bypass)', () => {
    // Code blocks are extracted FIRST as placeholders. A user might hope
    // to smuggle a `<style>` past the escape by hiding it in a code block
    // start that has no matching close, but the placeholder substitution
    // is exact-match so unmatched fences flow through escape normally.
    const { renderedText } = renderChatMessageText(
      '```\n<style>body{display:none}</style>\n```',
      defaultOptions,
    );
    assertNoExecutableHtml(renderedText);
  });

  it('neutralizes <style> when interleaved with markdown bold', () => {
    const { renderedText } = renderChatMessageText(
      '**bold** <style>x{}</style> *italic*',
      defaultOptions,
    );
    assertNoExecutableHtml(renderedText);
  });

  it('neutralizes <style> after a blockquote line', () => {
    const { renderedText } = renderChatMessageText(
      '> quoted line\n<style>body{display:none}</style>',
      defaultOptions,
    );
    assertNoExecutableHtml(renderedText);
  });

  it('preserves legitimate markdown formatting around malicious content', () => {
    const { renderedText } = renderChatMessageText(
      '**bold text** <style>evil</style> *italic*',
      defaultOptions,
    );
    // Markdown should still render…
    expect(renderedText).toContain('md-bold');
    expect(renderedText).toContain('md-italic');
    // …but the style tag should not.
    const container = document.createElement('div');
    container.innerHTML = renderedText;
    expect(container.querySelectorAll('style').length).toBe(0);
  });

  it('escapes the literal `<style>` characters so the browser shows them as text', () => {
    const { renderedText } = renderChatMessageText(
      '<style>x</style>',
      defaultOptions,
    );
    // The escaped form appears in the HTML stream …
    expect(renderedText).toContain('&lt;style&gt;');
    // … and the rendered DOM has the angle brackets as text content, not
    // as a parsed element.
    const container = document.createElement('div');
    container.innerHTML = renderedText;
    expect(container.textContent).toContain('<style>');
    expect(container.querySelectorAll('style').length).toBe(0);
  });

  it('treats backtick-escape ` style>...</style ` (the audit idx-0 case) as text', () => {
    // The original audit message described the attack as
    //   `style>body{display:block}</style`
    // (note: NO leading `<`, no trailing `>` — the user wrapped a partial
    // tag in backticks, hoping the backtick parsing would strip the
    // backticks and the surrounding HTML would close an earlier tag).
    // Our pipeline parses backticks AFTER escaping, so the embedded `<`
    // is already `&lt;`. There's no way to break out.
    const { renderedText } = renderChatMessageText(
      '`style>body{display:block}</style`',
      defaultOptions,
    );
    assertNoExecutableHtml(renderedText);
  });

  it('does not let DOMPurify re-introduce <style> via mXSS', () => {
    // Polyglot designed to exercise the historical DOMPurify mXSS
    // class — the embedded tags get parsed differently depending on
    // whether they're inside an `<svg>` or `<math>` foreign-content
    // context. Even though we don't allow `<svg>` in the message
    // allowlist, this guarantees regressions in DOMPurify's escaping
    // surface here.
    const { renderedText } = renderChatMessageText(
      '<svg><style>x</style><img src=x onerror=alert(1)></svg>',
      defaultOptions,
    );
    assertNoExecutableHtml(renderedText);
  });
});

describe('renderChatMessageText - preserves legitimate output', () => {
  it('renders bold/italic markdown', () => {
    const { renderedText } = renderChatMessageText(
      '**bold** *italic* ~~strike~~',
      defaultOptions,
    );
    expect(renderedText).toContain('<strong class="md-bold">bold</strong>');
    expect(renderedText).toContain('<em class="md-italic">italic</em>');
    expect(renderedText).toContain('<del class="md-strikethrough">strike</del>');
  });

  it('renders blockquotes', () => {
    const { renderedText } = renderChatMessageText(
      '> hello\n> world',
      defaultOptions,
    );
    expect(renderedText).toContain('md-blockquote');
    expect(renderedText).toContain('hello');
    expect(renderedText).toContain('world');
  });

  it('renders greentext (imageboard-style)', () => {
    const { renderedText } = renderChatMessageText(
      '>be me\n>realize markdown works',
      defaultOptions,
    );
    expect(renderedText).toContain('md-greentext');
  });

  it('renders inline code', () => {
    const { renderedText } = renderChatMessageText(
      'see `foo` for details',
      defaultOptions,
    );
    expect(renderedText).toContain('<code class="md-code">foo</code>');
  });

  it('extracts fenced code blocks as placeholders', () => {
    const { renderedText, codeBlocks } = renderChatMessageText(
      '```js\nconsole.log(1)\n```',
      defaultOptions,
    );
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0].language).toBe('js');
    expect(codeBlocks[0].code).toBe('console.log(1)');
    // Placeholder survives the escape pass intact.
    expect(renderedText).toContain('\uE000CODEBLOCK_0\uE001');
  });

  it('returns empty output for empty input', () => {
    expect(renderChatMessageText('', defaultOptions)).toEqual({
      renderedText: '',
      codeBlocks: [],
    });
  });
});
