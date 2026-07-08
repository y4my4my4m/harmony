import { parseMarkdownWithMarkers, type MarkdownToken } from './markdownParser';
import { highlightSyntax } from './syntaxHighlighter';
import { getEmojiUrl } from './emojiUtils';
import { sanitizeMessageHtml } from './sanitize';

export interface RenderOptions {
  showMarkers?: boolean; // Whether to show markdown markers
  singleLine?: boolean; // Render as single line (for previews)
  allowImages?: boolean; // Whether to render images
  allowVideos?: boolean; // Whether to render videos
  emojiResolver?: (name: string) => { url: string; id: string } | null;
}

export function renderMarkdownToHTML(text: string, options: RenderOptions = {}): string {
  const {
    showMarkers = false,
    singleLine = false,
    allowImages = true,
    allowVideos = true,
    emojiResolver
  } = options;

  if (singleLine) {
    // For single line rendering (like reply previews), strip formatting and truncate
    const plainText = text.replace(/\*\*([^*]+)\*\*/g, '$1')
                         .replace(/\*([^*]+)\*/g, '$1')
                         .replace(/__([^_]+)__/g, '$1')
                         .replace(/~~([^~]+)~~/g, '$1')
                         .replace(/`([^`]+)`/g, '$1')
                         .replace(/```[\s\S]*?```/g, '[code block]')
                         .replace(/:([a-zA-Z0-9_+-]+):/g, ':$1:')
                         .replace(/\n/g, ' ')
                         .trim();
    
    return escapeHtml(plainText.length > 50 ? plainText.substring(0, 50) + '...' : plainText);
  }

  const tokens = parseMarkdownWithMarkers(text);
  let html = '';

  for (const token of tokens) {
    html += renderTokenToHTML(token, { showMarkers, allowImages, allowVideos, emojiResolver });
  }

  // Defense-in-depth: this renderer escapes user text in every branch (see
  // `escapeHtml` calls in `renderTokenToHTML`), but a regression in any
  // branch - or a parser bug emitting unescaped content - could re-introduce
  // XSS. The sanitizer is a cheap last line of defense.
  return sanitizeMessageHtml(html);
}

function renderTokenToHTML(token: MarkdownToken, options: RenderOptions): string {
  const { showMarkers = false, emojiResolver } = options;

  switch (token.type) {
    case 'text':
      return escapeHtml(token.content).replace(/\n/g, '<br>');

    case 'bold': {
      const inner = token.children
        ? token.children.map(c => renderTokenToHTML(c, options)).join('')
        : escapeHtml(token.content);
      if (showMarkers) {
        return `<span class="md-marker">**</span><strong class="md-bold">${inner}</strong><span class="md-marker">**</span>`;
      }
      return `<strong class="md-bold">${inner}</strong>`;
    }

    case 'italic': {
      const inner = token.children
        ? token.children.map(c => renderTokenToHTML(c, options)).join('')
        : escapeHtml(token.content);
      if (showMarkers) {
        return `<span class="md-marker">*</span><em class="md-italic">${inner}</em><span class="md-marker">*</span>`;
      }
      return `<em class="md-italic">${inner}</em>`;
    }

    case 'underline': {
      const inner = token.children
        ? token.children.map(c => renderTokenToHTML(c, options)).join('')
        : escapeHtml(token.content);
      if (showMarkers) {
        return `<span class="md-marker">__</span><span class="md-underline">${inner}</span><span class="md-marker">__</span>`;
      }
      return `<span class="md-underline">${inner}</span>`;
    }

    case 'strikethrough': {
      const inner = token.children
        ? token.children.map(c => renderTokenToHTML(c, options)).join('')
        : escapeHtml(token.content);
      if (showMarkers) {
        return `<span class="md-marker">~~</span><span class="md-strikethrough">${inner}</span><span class="md-marker">~~</span>`;
      }
      return `<span class="md-strikethrough">${inner}</span>`;
    }

    case 'code':
      if (showMarkers) {
        return `<span class="md-marker">\`</span><code class="md-code">${escapeHtml(token.content)}</code><span class="md-marker">\`</span>`;
      }
      return `<code class="md-code">${escapeHtml(token.content)}</code>`;

    case 'codeblock': {
      const language = token.language || 'text';
      const syntaxTokens = highlightSyntax(token.content, language);
      
      let codeContent = '';
      for (const syntaxToken of syntaxTokens) {
        const content = escapeHtml(syntaxToken.content).replace(/\n/g, '<br>');
        codeContent += `<span class="${syntaxToken.className}">${content}</span>`;
      }

      if (showMarkers) {
        return `
          <div class="md-codeblock">
            <div class="md-codeblock-header">
              <span class="md-marker">\`\`\`${language}</span>
            </div>
            <div class="md-codeblock-content">
              ${codeContent}
            </div>
            <div class="md-codeblock-footer">
              <span class="md-marker">\`\`\`</span>
            </div>
          </div>
        `;
      }
      return `
        <div class="md-codeblock">
          <div class="md-codeblock-header">
            <span class="md-codeblock-lang">${language}</span>
          </div>
          <div class="md-codeblock-content">
            ${codeContent}
          </div>
        </div>
      `;
    }

    case 'emoji': {
      if (emojiResolver) {
        const emoji = emojiResolver(token.content);
        if (emoji) {
          // Always escape `token.content` (user-controlled emoji shortcode)
          // and `emoji.url` before splicing into attributes. The previous
          // implementation inlined `token.content` into an `onerror`
          // JavaScript string which was a JS-context injection vector
          // (sanitizeMessageHtml now also strips the handler). Custom error
          // fallback is handled by the consumer via @error in Vue templates.
          const safeName = escapeHtml(token.content);
          const safeUrl = escapeHtml(getEmojiUrl(emoji.url, 48));
          return `<img class="md-emoji" src="${safeUrl}" alt=":${safeName}:" title=":${safeName}:" draggable="false">`;
        }
      }
      return `:${escapeHtml(token.content)}:`;
    }

    default:
      return escapeHtml(token.content);
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Plain-text extraction for notifications, previews, etc.
export function extractPlainText(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, '$1')
             .replace(/\*([^*]+)\*/g, '$1')
             .replace(/__([^_]+)__/g, '$1')
             .replace(/~~([^~]+)~~/g, '$1')
             .replace(/`([^`]+)`/g, '$1')
             .replace(/```[\s\S]*?```/g, '[code]')
             .replace(/:([a-zA-Z0-9_+-]+):/g, ':$1:')
             .trim();
}
