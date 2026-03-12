import { parseMarkdownWithMarkers, type MarkdownToken } from './markdownParser';
import { highlightSyntax } from './syntaxHighlighter';
import { getEmojiUrl } from './emojiUtils';

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

  return html;
}

function renderTokenToHTML(token: MarkdownToken, options: RenderOptions): string {
  const { showMarkers = false, emojiResolver } = options;

  switch (token.type) {
    case 'text':
      // Handle newlines in text
      return escapeHtml(token.content).replace(/\n/g, '<br>');

    case 'bold':
      if (showMarkers) {
        return `<span class="md-marker">**</span><strong class="md-bold">${escapeHtml(token.content)}</strong><span class="md-marker">**</span>`;
      }
      return `<strong class="md-bold">${escapeHtml(token.content)}</strong>`;

    case 'italic':
      if (showMarkers) {
        return `<span class="md-marker">*</span><em class="md-italic">${escapeHtml(token.content)}</em><span class="md-marker">*</span>`;
      }
      return `<em class="md-italic">${escapeHtml(token.content)}</em>`;

    case 'underline':
      if (showMarkers) {
        return `<span class="md-marker">__</span><span class="md-underline">${escapeHtml(token.content)}</span><span class="md-marker">__</span>`;
      }
      return `<span class="md-underline">${escapeHtml(token.content)}</span>`;

    case 'strikethrough':
      if (showMarkers) {
        return `<span class="md-marker">~~</span><span class="md-strikethrough">${escapeHtml(token.content)}</span><span class="md-marker">~~</span>`;
      }
      return `<span class="md-strikethrough">${escapeHtml(token.content)}</span>`;

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
          return `<img class="md-emoji" src="${getEmojiUrl(emoji.url, 48)}" alt=":${token.content}:" title=":${token.content}:" draggable="false">`;
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

// Function to extract plain text from markdown (for notifications, previews, etc.)
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
