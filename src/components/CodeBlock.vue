<template>
  <div class="code-block-container" :data-language="language">
    <div class="code-block-header">
      <span class="language-label">{{ language }}</span>
      <button 
        class="copy-code-btn" 
        @click="copyCode" 
        :class="{ copied: isCopied }"
        title="Copy code"
      >
        <svg v-if="!isCopied" width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M8 3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1h1a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3h-2zm2 2h4V4H10v1z" fill="currentColor"/>
          <path d="M5 7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-1H9a2 2 0 0 1-2-2V7H5z" fill="currentColor"/>
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="currentColor"/>
        </svg>
      </button>
    </div>
    <pre class="md-codeblock" :data-language="language">
      <code :class="`language-${language}`" v-html="highlightedCode"></code>
    </pre>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

interface Props {
  code: string;
  language?: string;
}

const props = withDefaults(defineProps<Props>(), {
  language: 'text'
});

const isCopied = ref(false);

const highlightedCode = computed(() => {
  return highlightCode(props.code.trim(), props.language);
});

const copyCode = async () => {
  try {
    await navigator.clipboard.writeText(props.code);
    isCopied.value = true;
    setTimeout(() => {
      isCopied.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy code:', err);
    // Fallback for older browsers
    const textArea = document.createElement('textarea');
    textArea.value = props.code;
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      isCopied.value = true;
      setTimeout(() => {
        isCopied.value = false;
      }, 2000);
    } catch (fallbackErr) {
      console.error('Fallback copy failed:', fallbackErr);
    }
    document.body.removeChild(textArea);
  }
};

// Basic syntax highlighting function
const highlightCode = (code: string, language: string): string => {
  switch (language.toLowerCase()) {
    case 'javascript':
    case 'js':
      return highlightJavaScript(code);
    case 'typescript':
    case 'ts':
      return highlightTypeScript(code);
    case 'html':
      return highlightHTML(code);
    case 'css':
      return highlightCSS(code);
    case 'json':
      return highlightJSON(code);
    case 'python':
    case 'py':
      return highlightPython(code);
    default:
      return escapeHtml(code);
  }
};

// Helper function to escape HTML
const escapeHtml = (text: string): string => {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

const highlightJavaScript = (code: string): string => {
  // Keywords
  code = code.replace(/\b(const|let|var|function|return|if|else|for|while|class|export|import|from|async|await|try|catch|finally|throw|new|this|typeof|instanceof)\b/g, '___KEYWORD_START___$1___KEYWORD_END___');
  
  // Strings (handle template literals, single and double quotes)
  code = code.replace(/(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g, '___STRING_START___$1$2$1___STRING_END___');
  
  // Numbers
  code = code.replace(/\b(\d+(?:\.\d+)?)\b/g, '___NUMBER_START___$1___NUMBER_END___');
  
  // Comments
  code = code.replace(/(\/\/.*$)/gm, '___COMMENT_START___$1___COMMENT_END___');
  code = code.replace(/(\/\*[\s\S]*?\*\/)/g, '___COMMENT_START___$1___COMMENT_END___');
  
  // Now escape HTML
  code = escapeHtml(code);
  
  // Replace placeholders with HTML tags
  code = code.replace(/___KEYWORD_START___(.*?)___KEYWORD_END___/g, '<span class="hl-keyword">$1</span>');
  code = code.replace(/___STRING_START___(.*?)___STRING_END___/g, '<span class="hl-string">$1</span>');
  code = code.replace(/___NUMBER_START___(.*?)___NUMBER_END___/g, '<span class="hl-number">$1</span>');
  code = code.replace(/___COMMENT_START___(.*?)___COMMENT_END___/g, '<span class="hl-comment">$1</span>');
  
  return code;
};

const highlightTypeScript = (code: string): string => {
  // Use JavaScript highlighting as base
  code = highlightJavaScript(code);
  
  // TypeScript specific keywords (after HTML escaping)
  code = code.replace(/\b(interface|type|enum|namespace|declare|abstract|implements|extends|public|private|protected|readonly|static)\b/g, '<span class="hl-keyword">$1</span>');
  
  return code;
};

const highlightHTML = (code: string): string => {
  // Escape HTML first
  code = escapeHtml(code);
  
  // Tags
  code = code.replace(/(&lt;\/?)([\w-]+)([^&gt;]*?)(&gt;)/g, '<span class="hl-tag">$1</span><span class="hl-tag-name">$2</span><span class="hl-attr">$3</span><span class="hl-tag">$4</span>');
  
  // Attributes
  code = code.replace(/(\w+)=(["'])([^"']*?)\2/g, '<span class="hl-attr-name">$1</span>=<span class="hl-string">$2$3$2</span>');
  
  return code;
};

const highlightCSS = (code: string): string => {
  // Selectors
  code = code.replace(/^([.#]?[\w-]+)(\s*{)/gm, '___SELECTOR_START___$1___SELECTOR_END___$2');
  
  // Properties
  code = code.replace(/(\w+[-]?\w*)(\s*:)/g, '___PROPERTY_START___$1___PROPERTY_END___$2');
  
  // Values
  code = code.replace(/:(\s*)([^;]+)(;)/g, ':$1___VALUE_START___$2___VALUE_END___$3');
  
  // Escape HTML
  code = escapeHtml(code);
  
  // Replace placeholders
  code = code.replace(/___SELECTOR_START___(.*?)___SELECTOR_END___/g, '<span class="hl-selector">$1</span>');
  code = code.replace(/___PROPERTY_START___(.*?)___PROPERTY_END___/g, '<span class="hl-property">$1</span>');
  code = code.replace(/___VALUE_START___(.*?)___VALUE_END___/g, '<span class="hl-value">$1</span>');
  
  return code;
};

const highlightJSON = (code: string): string => {
  // Strings (keys and values)
  code = code.replace(/(")([^"]*?)(")/g, '___STRING_START___$1$2$3___STRING_END___');
  
  // Numbers
  code = code.replace(/:\s*(-?\d+(?:\.\d+)?)/g, ': ___NUMBER_START___$1___NUMBER_END___');
  
  // Booleans and null
  code = code.replace(/\b(true|false|null)\b/g, '___KEYWORD_START___$1___KEYWORD_END___');
  
  // Escape HTML
  code = escapeHtml(code);
  
  // Replace placeholders
  code = code.replace(/___STRING_START___(.*?)___STRING_END___/g, '<span class="hl-string">$1</span>');
  code = code.replace(/___NUMBER_START___(.*?)___NUMBER_END___/g, '<span class="hl-number">$1</span>');
  code = code.replace(/___KEYWORD_START___(.*?)___KEYWORD_END___/g, '<span class="hl-keyword">$1</span>');
  
  return code;
};

const highlightPython = (code: string): string => {
  // Keywords
  code = code.replace(/\b(def|class|if|elif|else|for|while|try|except|finally|import|from|as|return|yield|lambda|with|assert|break|continue|pass|global|nonlocal|and|or|not|in|is)\b/g, '___KEYWORD_START___$1___KEYWORD_END___');
  
  // Strings
  code = code.replace(/(["']{1,3})((?:\\.|(?!\1)[^\\])*?)\1/g, '___STRING_START___$1$2$1___STRING_END___');
  
  // Numbers
  code = code.replace(/\b(\d+(?:\.\d+)?)\b/g, '___NUMBER_START___$1___NUMBER_END___');
  
  // Comments
  code = code.replace(/(#.*$)/gm, '___COMMENT_START___$1___COMMENT_END___');
  
  // Escape HTML
  code = escapeHtml(code);
  
  // Replace placeholders
  code = code.replace(/___KEYWORD_START___(.*?)___KEYWORD_END___/g, '<span class="hl-keyword">$1</span>');
  code = code.replace(/___STRING_START___(.*?)___STRING_END___/g, '<span class="hl-string">$1</span>');
  code = code.replace(/___NUMBER_START___(.*?)___NUMBER_END___/g, '<span class="hl-number">$1</span>');
  code = code.replace(/___COMMENT_START___(.*?)___COMMENT_END___/g, '<span class="hl-comment">$1</span>');
  
  return code;
};
</script>

<style scoped>
.code-block-container {
  position: relative;
  margin: 8px 0;
  border-radius: 8px;
  background-color: #2b2d31;
  border: 1px solid #3c3f44;
  overflow: hidden;
  font-family: 'JetBrains Mono', 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'source-code-pro', monospace;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.code-block-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background-color: #36393f;
  border-bottom: 1px solid #3c3f44;
  min-height: 36px;
  box-sizing: border-box;
}

.language-label {
  color: #b5bac1;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 12px;
  line-height: 1;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.copy-code-btn {
  background: transparent;
  border: 1px solid #4f545c;
  border-radius: 4px;
  color: #b5bac1;
  padding: 6px 8px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 24px;
  opacity: 0.7;
  font-size: 12px;
}

.copy-code-btn:hover {
  opacity: 1;
  background-color: #404249;
  border-color: #5865f2;
  color: #ffffff;
  transform: translateY(-1px);
}

.copy-code-btn.copied {
  background-color: #23a559;
  border-color: #23a559;
  color: #ffffff;
  opacity: 1;
}

.md-codeblock {
  margin: 0;
  padding: 16px;
  background-color: #2b2d31;
  border-radius: 0;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.4;
  overflow-x: auto;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
  color: #dbdee1;
  border: none;
}

.md-codeblock code {
  font-family: inherit;
  background: none;
  padding: 0;
  border-radius: 0;
  color: inherit;
  white-space: pre;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
  font-size: inherit;
  line-height: inherit;
}

/* Syntax highlighting styles - Discord/VS Code inspired */
.md-codeblock :deep(.hl-keyword) {
  color: #ff7b72;
  font-weight: 600;
}

.md-codeblock :deep(.hl-string) {
  color: #a5d6ff;
}

.md-codeblock :deep(.hl-number) {
  color: #79c0ff;
}

.md-codeblock :deep(.hl-comment) {
  color: #8b949e;
  font-style: italic;
}

.md-codeblock :deep(.hl-function) {
  color: #d2a8ff;
  font-weight: 500;
}

.md-codeblock :deep(.hl-variable) {
  color: #ffa657;
}

.md-codeblock :deep(.hl-tag) {
  color: #7ee787;
}

.md-codeblock :deep(.hl-tag-name) {
  color: #7ee787;
  font-weight: 600;
}

.md-codeblock :deep(.hl-attr) {
  color: #79c0ff;
}

.md-codeblock :deep(.hl-attr-name) {
  color: #79c0ff;
}

.md-codeblock :deep(.hl-value) {
  color: #a5d6ff;
}

.md-codeblock :deep(.hl-property) {
  color: #ffa657;
}

.md-codeblock :deep(.hl-operator) {
  color: #d4d4d4;
}

.md-codeblock :deep(.hl-selector) {
  color: #d7ba7d;
}
</style>
