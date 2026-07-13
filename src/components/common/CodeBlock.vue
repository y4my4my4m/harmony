<template>
  <div class="code-block-wrapper" @mouseenter="showCopyButton = true" @mouseleave="showCopyButton = false">
    <div class="code-block-header">
      <span class="language-label" v-if="language && language !== 'text'">{{ language }}</span>
      <button 
        v-show="showCopyButton || copied"
        class="copy-button"
        @click="copyCode"
        :class="{ 'copied': copied }"
        :title="copied ? 'Copied!' : 'Copy code'"
      >
        <CopyIcon v-if="!copied" />
        <CheckIcon v-else />
        <span class="copy-text">{{ copied ? 'Copied!' : 'Copy' }}</span>
      </button>
    </div>
    <pre class="code-block" :data-language="language">
      <code 
        :class="`language-${language}`"
        v-html="highlightedCode"
        ref="codeElement"
      ></code>
    </pre>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed } from 'vue';
import { debug } from '@/utils/debug';
import CopyIcon from '@/components/icons/Copy.vue';
import CheckIcon from '@/components/icons/Check.vue';

export default defineComponent({
  name: 'CodeBlock',
  components: {
    CopyIcon,
    CheckIcon
  },
  props: {
    code: {
      type: String,
      required: true
    },
    language: {
      type: String,
      default: 'text'
    }
  },
  setup(props) {
    const showCopyButton = ref(false);
    const copied = ref(false);
    const codeElement = ref<HTMLElement | null>(null);

    const copyCode = async () => {
      try {
        await navigator.clipboard.writeText(props.code);
        copied.value = true;
        
        setTimeout(() => {
          copied.value = false;
        }, 2000);
      } catch (error) {
        debug.error('Failed to copy code:', error);
        fallbackCopyTextToClipboard(props.code);
      }
    };

    const fallbackCopyTextToClipboard = (text: string) => {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      
      try {
        const successful = document.execCommand('copy');
        if (successful) {
          copied.value = true;
          setTimeout(() => {
            copied.value = false;
          }, 2000);
        }
      } catch (err) {
        debug.error('Fallback: Oops, unable to copy', err);
      }
      
      document.body.removeChild(textArea);
    };

    const highlightedCode = computed(() => {
      return highlightCode(props.code, props.language);
    });

    const highlightCode = (code: string, language: string): string => {
      if (!code) return '';
      
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
        case 'bash':
        case 'shell':
        case 'sh':
          return highlightBash(code);
        case 'sql':
          return highlightSQL(code);
        case 'vue':
          return highlightVue(code);
        case 'xml':
          return highlightXML(code);
        default:
          return escapeHtml(code);
      }
    };

    const escapeHtml = (text: string): string => {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };

    const highlightJavaScript = (code: string): string => {
      code = code.replace(/\b(const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|class|extends|implements|export|import|from|as|async|await|try|catch|finally|throw|new|this|typeof|instanceof|in|of|delete|void|null|undefined|true|false)\b/g, '___KEYWORD_START___$1___KEYWORD_END___');
      
      code = code.replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g, '___FUNCTION_START___$1___FUNCTION_END___');
      
      code = code.replace(/(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g, '___STRING_START___$1$2$1___STRING_END___');
      
      code = code.replace(/\b(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\b/g, '___NUMBER_START___$1___NUMBER_END___');
      
      code = code.replace(/(\/\/.*$)/gm, '___COMMENT_START___$1___COMMENT_END___');
      code = code.replace(/(\/\*[\s\S]*?\*\/)/g, '___COMMENT_START___$1___COMMENT_END___');
      
      code = code.replace(/([+\-*/%=<>!&|?:;,])/g, '___OPERATOR_START___$1___OPERATOR_END___');
      
      code = escapeHtml(code);
      
      code = code.replace(/___KEYWORD_START___(.*?)___KEYWORD_END___/g, '<span class="hl-keyword">$1</span>');
      code = code.replace(/___FUNCTION_START___(.*?)___FUNCTION_END___/g, '<span class="hl-function">$1</span>');
      code = code.replace(/___STRING_START___(.*?)___STRING_END___/g, '<span class="hl-string">$1</span>');
      code = code.replace(/___NUMBER_START___(.*?)___NUMBER_END___/g, '<span class="hl-number">$1</span>');
      code = code.replace(/___COMMENT_START___(.*?)___COMMENT_END___/g, '<span class="hl-comment">$1</span>');
      code = code.replace(/___OPERATOR_START___(.*?)___OPERATOR_END___/g, '<span class="hl-operator">$1</span>');
      
      return code;
    };

    const highlightTypeScript = (code: string): string => {
      code = highlightJavaScript(code);
      
      code = code.replace(/\b(interface|type|enum|namespace|declare|abstract|implements|extends|public|private|protected|readonly|static|readonly|keyof|infer|never|unknown)\b/g, '<span class="hl-keyword">$1</span>');
      
      return code;
    };

    const highlightHTML = (code: string): string => {
      code = escapeHtml(code);
      
      code = code.replace(/(&lt;\/?)([\w-]+)([^&gt;]*?)(&gt;)/g, '<span class="hl-tag">$1</span><span class="hl-tag-name">$2</span><span class="hl-attr">$3</span><span class="hl-tag">$4</span>');
      
      code = code.replace(/(\w+)=(["'])([^"']*?)\2/g, '<span class="hl-attr-name">$1</span>=<span class="hl-string">$2$3$2</span>');
      
      return code;
    };

    const highlightCSS = (code: string): string => {
      code = code.replace(/([a-zA-Z-]+)\s*:/g, '___PROPERTY_START___$1___PROPERTY_END___:');
      
      code = code.replace(/:\s*([^;{]+)/g, ': ___VALUE_START___$1___VALUE_END___');
      
      code = code.replace(/([.#]?[a-zA-Z-_][a-zA-Z0-9-_]*)\s*{/g, '___SELECTOR_START___$1___SELECTOR_END___ {');
      
      code = code.replace(/(\/\*[\s\S]*?\*\/)/g, '___COMMENT_START___$1___COMMENT_END___');
      
      code = escapeHtml(code);
      
      code = code.replace(/___PROPERTY_START___(.*?)___PROPERTY_END___/g, '<span class="hl-property">$1</span>');
      code = code.replace(/___VALUE_START___(.*?)___VALUE_END___/g, '<span class="hl-value">$1</span>');
      code = code.replace(/___SELECTOR_START___(.*?)___SELECTOR_END___/g, '<span class="hl-selector">$1</span>');
      code = code.replace(/___COMMENT_START___(.*?)___COMMENT_END___/g, '<span class="hl-comment">$1</span>');
      
      return code;
    };

    const highlightJSON = (code: string): string => {
      code = code.replace(/"([^"]+)"(\s*:)/g, '___KEY_START___"$1"___KEY_END___$2');
      
      code = code.replace(/:\s*"([^"]*?)"/g, ': ___STRING_START___"$1"___STRING_END___');
      
      code = code.replace(/:\s*(\d+(?:\.\d+)?)/g, ': ___NUMBER_START___$1___NUMBER_END___');
      
      code = code.replace(/:\s*(true|false|null)/g, ': ___KEYWORD_START___$1___KEYWORD_END___');
      
      code = escapeHtml(code);
      
      code = code.replace(/___KEY_START___(.*?)___KEY_END___/g, '<span class="hl-property">$1</span>');
      code = code.replace(/___STRING_START___(.*?)___STRING_END___/g, '<span class="hl-string">$1</span>');
      code = code.replace(/___NUMBER_START___(.*?)___NUMBER_END___/g, '<span class="hl-number">$1</span>');
      code = code.replace(/___KEYWORD_START___(.*?)___KEYWORD_END___/g, '<span class="hl-keyword">$1</span>');
      
      return code;
    };

    const highlightPython = (code: string): string => {
      code = code.replace(/\b(def|class|if|elif|else|for|while|try|except|finally|with|as|import|from|return|yield|lambda|and|or|not|in|is|True|False|None|pass|break|continue|global|nonlocal|assert|del|raise)\b/g, '___KEYWORD_START___$1___KEYWORD_END___');
      
      code = code.replace(/\bdef\s+([a-zA-Z_][a-zA-Z0-9_]*)/g, 'def <span class="hl-function">$1</span>');
      
      code = code.replace(/(["'])((?:\\.|(?!\1)[^\\])*?)\1/g, '___STRING_START___$1$2$1___STRING_END___');
      code = code.replace(/("""[\s\S]*?""")/g, '___STRING_START___$1___STRING_END___');
      
      code = code.replace(/\b(\d+(?:\.\d+)?)\b/g, '___NUMBER_START___$1___NUMBER_END___');
      
      code = code.replace(/(#.*$)/gm, '___COMMENT_START___$1___COMMENT_END___');
      
      code = escapeHtml(code);
      
      code = code.replace(/___KEYWORD_START___(.*?)___KEYWORD_END___/g, '<span class="hl-keyword">$1</span>');
      code = code.replace(/___STRING_START___(.*?)___STRING_END___/g, '<span class="hl-string">$1</span>');
      code = code.replace(/___NUMBER_START___(.*?)___NUMBER_END___/g, '<span class="hl-number">$1</span>');
      code = code.replace(/___COMMENT_START___(.*?)___COMMENT_END___/g, '<span class="hl-comment">$1</span>');
      
      return code;
    };

    const highlightBash = (code: string): string => {
      code = code.replace(/\b(ls|cd|pwd|mkdir|rmdir|rm|cp|mv|cat|grep|find|chmod|chown|ps|top|kill|sudo|apt|yum|git|npm|yarn|docker|kubectl)\b/g, '___KEYWORD_START___$1___KEYWORD_END___');
      
      code = code.replace(/(["'])((?:\\.|(?!\1)[^\\])*?)\1/g, '___STRING_START___$1$2$1___STRING_END___');
      
      code = code.replace(/(#.*$)/gm, '___COMMENT_START___$1___COMMENT_END___');
      
      code = code.replace(/(\$\w+)/g, '___VARIABLE_START___$1___VARIABLE_END___');
      
      code = escapeHtml(code);
      
      code = code.replace(/___KEYWORD_START___(.*?)___KEYWORD_END___/g, '<span class="hl-keyword">$1</span>');
      code = code.replace(/___STRING_START___(.*?)___STRING_END___/g, '<span class="hl-string">$1</span>');
      code = code.replace(/___COMMENT_START___(.*?)___COMMENT_END___/g, '<span class="hl-comment">$1</span>');
      code = code.replace(/___VARIABLE_START___(.*?)___VARIABLE_END___/g, '<span class="hl-variable">$1</span>');
      
      return code;
    };

    const highlightSQL = (code: string): string => {
      code = code.replace(/\b(SELECT|FROM|WHERE|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|ON|GROUP|BY|ORDER|HAVING|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|DATABASE|SCHEMA|PRIMARY|KEY|FOREIGN|REFERENCES|NOT|NULL|UNIQUE|DEFAULT|AUTO_INCREMENT|CONSTRAINT)\b/gi, '___KEYWORD_START___$1___KEYWORD_END___');
      
      code = code.replace(/(["'])((?:\\.|(?!\1)[^\\])*?)\1/g, '___STRING_START___$1$2$1___STRING_END___');
      
      code = code.replace(/(--.*$)/gm, '___COMMENT_START___$1___COMMENT_END___');
      code = code.replace(/(\/\*[\s\S]*?\*\/)/g, '___COMMENT_START___$1___COMMENT_END___');
      
      code = code.replace(/\b(\d+(?:\.\d+)?)\b/g, '___NUMBER_START___$1___NUMBER_END___');
      
      code = escapeHtml(code);
      
      code = code.replace(/___KEYWORD_START___(.*?)___KEYWORD_END___/g, '<span class="hl-keyword">$1</span>');
      code = code.replace(/___STRING_START___(.*?)___STRING_END___/g, '<span class="hl-string">$1</span>');
      code = code.replace(/___COMMENT_START___(.*?)___COMMENT_END___/g, '<span class="hl-comment">$1</span>');
      code = code.replace(/___NUMBER_START___(.*?)___NUMBER_END___/g, '<span class="hl-number">$1</span>');
      
      return code;
    };

    const highlightVue = (code: string): string => {
      return highlightHTML(code);
    };

    const highlightXML = (code: string): string => {
      return highlightHTML(code);
    };

    return {
      showCopyButton,
      copied,
      codeElement,
      copyCode,
      highlightedCode
    };
  }
});
</script>

<style scoped>
.code-block-wrapper {
  position: relative;
  margin: 4px 0;
  background-color: var(--background-tertiary);
  border-radius: 8px;
  border: 1px solid var(--background-quinary);
  overflow: hidden;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'source-code-pro', monospace;
}

.code-block-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 12px;
  background-color: var(--background-secondary-alpha);
  border-bottom: 1px solid var(--border-primary);
  min-height: 28px;
}

.language-label {
  font-size: 0.75rem;
  color: var(--text-secondary);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.copy-button {
  display: flex;
  align-items: center;
  /* gap: 4px; */
  padding: 4px 8px;
  margin-right: 180px;
  background-color: var(--background-quinary);
  border: 1px solid #0EA5E9;
  border-radius: 4px;
  color: #0EA5E9;
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  opacity: 0;
  transform: translateY(-2px);
  animation: fadeInDown 0.2s ease forwards;
}

.copy-button:hover {
  background-color: var(--harmony-primary);
  color: var(--text-primary);
  transform: translateY(0);
}

.copy-button.copied {
  background-color: #3ba55c;
  border-color: #3ba55c;
  color: var(--text-primary);
}

.copy-button :deep(svg) {
  width: 14px;
  height: 14px;
}

.copy-text {
  user-select: none;
}

.code-block {
  margin: 0;
  padding: 12px;
  /* background-color: var(--background-tertiary); */
  background-color: var(--background-primary-alpha);
  /* color: var(--text-secondary); */
  color: var(--text-primary);
  font-size: 0.875rem;
  line-height: 1.125rem;
  overflow-x: auto;
  white-space: pre;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.code-block code {
  font-family: inherit;
  background: none;
  padding: 0;
  border-radius: 0;
  color: inherit;
  display: block;
  white-space: pre;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

/* Syntax highlighting styles */
.code-block :deep(.hl-keyword) {
  color: #c586c0;
  font-weight: 600;
}

.code-block :deep(.hl-string) {
  color: #ce9178;
}

.code-block :deep(.hl-number) {
  color: #b5cea8;
}

.code-block :deep(.hl-comment) {
  color: #6a9955;
  font-style: italic;
}

.code-block :deep(.hl-function) {
  color: #dcdcaa;
  font-weight: 500;
}

.code-block :deep(.hl-variable) {
  color: #9cdcfe;
}

.code-block :deep(.hl-tag) {
  color: #569cd6;
}

.code-block :deep(.hl-tag-name) {
  color: #4fc1ff;
  font-weight: 500;
}

.code-block :deep(.hl-attr) {
  color: #92c5f5;
}

.code-block :deep(.hl-attr-name) {
  color: #92c5f5;
}

.code-block :deep(.hl-value) {
  color: #ce9178;
}

.code-block :deep(.hl-property) {
  color: #9cdcfe;
}

.code-block :deep(.hl-operator) {
  color: #d4d4d4;
}

.code-block :deep(.hl-selector) {
  color: #d7ba7d;
}

/* Scrollbar styling for code blocks */
.code-block::-webkit-scrollbar {
  height: 8px;
}

.code-block::-webkit-scrollbar-track {
  background: var(--background-tertiary);
}

.code-block::-webkit-scrollbar-thumb {
  background: #555b68;
  border-radius: 4px;
}

.code-block::-webkit-scrollbar-thumb:hover {
  background: #6a7080;
}

@keyframes fadeInDown {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Responsive design */
@media (max-width: 768px) {
  .code-block-header {
    padding: 6px 8px;
  }
  
  .copy-button {
    padding: 3px 6px;
    font-size: 0.7rem;
  }
  
  .copy-button .copy-text {
    display: none;
  }
  
  .code-block {
    padding: 8px;
    font-size: 0.8125rem;
  }
}
</style>
