/**
 * Pure rendering pipeline for the `text` parts of a chat / DM message.
 *
 * This is the canonical implementation used by `UnifiedMessageContent.vue`'s
 * `renderTextContent`. It lives here rather than inline in the component so
 * the XSS-relevant logic is testable in isolation - every `<style>`,
 * `<script>`, `<img onerror=...>` payload that ever appeared in the audit
 * (`messages_rows_xss_issue.json`) has a corresponding regression test
 * against this function.
 *
 * Pipeline contract (DO NOT reorder without re-running the XSS test suite):
 *
 *   1. Carve out fenced code blocks (` ``` `) and replace them with a
 *      private-use unicode placeholder. They re-appear later as
 *      `<CodeBlock>` components - none of their inner text is rendered as
 *      HTML.
 *   2. **HTML-escape the entire remaining string.** Every character that
 *      arrives here is potentially user input (or worse: federated server
 *      input); after step 2 the string is HTML-safe text. Every later
 *      transformation operates on already-escaped text and inserts only
 *      tags WE chose, so user content can never become HTML.
 *   3. Replace native unicode emojis with our own trusted `<img>` /
 *      `<span>` markup. Emoji sources come from the bundled asset pack;
 *      attribute values are re-escaped because resolved shortcodes /
 *      emoji names are user/federation-controlled.
 *   4. Apply markdown inline formatting (`**bold**`, `*italic*`,
 *      `~~strike~~`, ` ``code`` `, etc.). Regexes match against escaped
 *      text and emit known-safe tags.
 *   5. Convert Discord-style blockquotes (`> `) and imageboard greentext
 *      (`>foo`) into `<blockquote>` / `<span class="md-greentext">`. The
 *      preceding escape turned the user's `>` into `&gt;`; we unescape it
 *      ONLY at the start of a line so the blockquote parser can match,
 *      while `&gt;` in body text stays escaped.
 *   6. Final pass: run the result through DOMPurify (`sanitizeMessageHtml`)
 *      to strip anything that doesn't match our message allowlist. This
 *      is defense-in-depth - earlier escaping should already have made
 *      this a no-op - but it guarantees a future regression in steps
 *      3-5 cannot turn into XSS.
 *
 * The historic bug this replaces was the "protect HTML tags from
 * escaping" pattern, which carved out user-supplied `<style>` /
 * `<img onerror=...>` tags BEFORE escaping and re-spliced them AFTER, so
 * arbitrary HTML round-tripped intact.
 */

import { escapeHtml, sanitizeMessageHtml } from './sanitize';
import { renderTextWithBlockquotes } from './chatBlockquotes';

export interface CodeBlock {
  id: string;
  code: string;
  language: string;
}

export interface EmojiResolution {
  display: { type: 'svg' | 'native'; content: string };
  // Some upstream resolvers (e.g. `unifiedEmojiService.resolveEmoji`)
  // return `string | null`; treat null and undefined identically.
  shortcode?: string | null;
}

export interface ChatMessageRendererOptions {
  /** True when the active emoji pack is the system/native pack. */
  isNativePack: boolean;
  /** True once the emoji service has finished loading its data. */
  emojiServiceLoaded: boolean;
  /** Resolves a unicode emoji to an SVG / native display. */
  resolveEmoji: (input: string) => EmojiResolution;
  /** True when the entire message is a single emoji (bigger styling). */
  isSingleEmoji: boolean;
  /** True when greentext (`>foo` without space) should render styled. */
  greentextEnabled: boolean;
}

const UNICODE_EMOJI_REGEX =
  /[\u{1F1E6}-\u{1F1FF}]{2}|(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/gu;

/**
 * Render a single message text part to safe HTML. See the file header for
 * the pipeline contract.
 *
 * Returns:
 *   - `renderedText`: HTML string safe to drop into `v-html`. Code blocks
 *     are represented as opaque private-use placeholders so the caller can
 *     split on them and mount real `<CodeBlock>` components in their slots.
 *   - `codeBlocks`: the extracted code blocks, in order.
 */
export function renderChatMessageText(
  text: string,
  options: ChatMessageRendererOptions,
): { renderedText: string; codeBlocks: CodeBlock[] } {
  if (!text) return { renderedText: '', codeBlocks: [] };

  const { isNativePack, emojiServiceLoaded, resolveEmoji, isSingleEmoji, greentextEnabled } = options;

  // 1. Extract fenced code blocks. Placeholders use private-use code
  //    points (U+E000 / U+E001) that can't appear in user input and pass
  //    HTML-escape untouched.
  const codeBlocks: CodeBlock[] = [];
  let rendered = text.replace(/```(\w+)?(?:\n)?([\s\S]*?)```/g, (_match, language, code) => {
    const lang = language || 'text';
    const blockId = `\uE000CODEBLOCK_${codeBlocks.length}\uE001`;
    const cleanCode = code.replace(/^\n+/, '').replace(/\n+$/, '');
    codeBlocks.push({ id: blockId, code: cleanCode, language: lang });
    return blockId;
  });

  // 2. ESCAPE.
  rendered = escapeHtml(rendered);

  // 3. Emoji rendering on already-escaped text.
  if (!isNativePack && emojiServiceLoaded) {
    rendered = rendered.replace(UNICODE_EMOJI_REGEX, (match) => {
      const resolved = resolveEmoji(match);
      if (resolved.display.type === 'svg') {
        const sizeClass = isSingleEmoji ? 'inline-emoji single' : 'inline-emoji';
        const altRaw = resolved.shortcode || match;
        return `<img class="${sizeClass}" src="${escapeHtml(resolved.display.content)}" alt="${escapeHtml(altRaw)}" draggable="false" />`;
      }
      return match;
    });
  } else if (isSingleEmoji) {
    rendered = rendered.replace(UNICODE_EMOJI_REGEX, (match) => {
      return `<span class="native-emoji single">${match}</span>`;
    });
  }

  // 4. Markdown inline formatting.
  rendered = rendered.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  rendered = rendered.replace(/\*\*(.*?)\*\*/g, '<strong class="md-bold">$1</strong>');
  rendered = rendered.replace(/__(.*?)__/g, '<u class="md-underline">$1</u>');
  rendered = rendered.replace(/(?<![\w/:])_([^_]+)_(?![\w])/g, '<em class="md-italic">$1</em>');
  rendered = rendered.replace(/(?<![\w*])\*([^*]+)\*(?![\w*])/g, '<em class="md-italic">$1</em>');
  rendered = rendered.replace(/~~(.*?)~~/g, '<del class="md-strikethrough">$1</del>');
  rendered = rendered.replace(/\+\+(.*?)\+\+/g, '<u class="md-underline">$1</u>');

  // 5. Blockquotes / greentext. Restore `&gt;` -> `>` ONLY at line starts.
  rendered = rendered.replace(/(^|\n)((?:&gt;){1,3})/g, (_, lead: string, marker: string) =>
    lead + marker.replace(/&gt;/g, '>'),
  );
  rendered = renderTextWithBlockquotes(rendered, (line) => line, { greentext: greentextEnabled });

  // 6. Defense-in-depth: strip anything not on the message allowlist.
  rendered = sanitizeMessageHtml(rendered);

  return { renderedText: rendered, codeBlocks };
}
