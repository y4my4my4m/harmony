<template>
  <div class="demo-container">
    <h2>Rich Text Editor Demo</h2>
    <div class="demo-section">
      <h3>Rich Text Editor</h3>
      <RichTextEditor
        v-model="testText"
        placeholder="Try typing some markdown: **bold**, *italic*, `code`, ```js\ncode block\n```, :emoji:"
        @cursor-position-changed="handleCursorChange"
      />
      <div class="text-output">
        <h4>Plain Text Output:</h4>
        <pre>{{ testText }}</pre>
      </div>
    </div>

    <div class="demo-section">
      <h3>Markdown Parser Test</h3>
      <textarea 
        v-model="markdownTest" 
        placeholder="Type markdown here to see it parsed"
        class="markdown-input"
      ></textarea>
      <div class="parsed-output">
        <h4>Parsed Nodes:</h4>
        <div class="node-list">
          <div 
            v-for="(node, index) in parsedNodes" 
            :key="index" 
            class="node-item"
            :class="`node-${node.type}`"
          >
            <span class="node-type">{{ node.type }}</span>
            <span class="node-content">{{ node.content }}</span>
            <span v-if="node.language" class="node-language">({{ node.language }})</span>
          </div>
        </div>
      </div>
    </div>

    <div class="demo-section">
      <h3>Syntax Highlighter Test</h3>
      <select v-model="selectedLanguage">
        <option v-for="lang in supportedLanguages" :key="lang" :value="lang">
          {{ lang }}
        </option>
      </select>
      <textarea 
        v-model="codeTest" 
        placeholder="Type code here to see syntax highlighting"
        class="code-input"
      ></textarea>
      <div class="highlighted-output">
        <h4>Highlighted Code:</h4>
        <div class="code-preview">
          <span 
            v-for="(token, index) in highlightedTokens" 
            :key="index"
            :class="token.className"
          >{{ token.content }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { debug } from '@/utils/debug'
import RichTextEditor from '@/components/RichTextEditor.vue';
import { parseMarkdownToNodes } from '@/utils/markdownParser';
import { highlightSyntax, getSupportedLanguages } from '@/utils/syntaxHighlighter';

const testText = ref('');
const markdownTest = ref('**Bold text** and *italic text* with `inline code` and:\n\n```javascript\nfunction hello() {\n  debug.log("Hello World!");\n}\n```\n\nAnd some :fire: emoji!');
const codeTest = ref(`function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

const users = [
  { id: 1, name: "Alice" },
  { id: 2, name: "Bob" }
];

// This is a comment
for (const user of users) {
  debug.log(greet(user.name));
}`);

const selectedLanguage = ref('typescript');
const supportedLanguages = getSupportedLanguages();

const parsedNodes = computed(() => {
  return parseMarkdownToNodes(markdownTest.value);
});

const highlightedTokens = computed(() => {
  return highlightSyntax(codeTest.value, selectedLanguage.value);
});

const handleCursorChange = (position: number) => {
  debug.log('Cursor position:', position);
};

// Watch for changes in test text
watch(testText, (newValue) => {
  debug.log('Rich text content changed:', newValue);
});
</script>

<style scoped>
.demo-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px;
  color: var(--h-text, #ffffff);
  background: var(--h-bg, var(--background-secondary));
  min-height: 100vh;
}

.demo-section {
  margin-bottom: 40px;
  padding: 20px;
  border: 1px solid var(--background-quinary);
  border-radius: 8px;
  background: var(--background-secondary, var(--background-tertiary));
}

.demo-section h3 {
  margin-top: 0;
  color: var(--text-primary);
}

.text-output, .parsed-output, .highlighted-output {
  margin-top: 20px;
  padding: 15px;
  border: 1px solid var(--background-quinary);
  border-radius: 4px;
  background: var(--background-tertiary);
}

.text-output pre {
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  color: var(--text-secondary);
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
}

.markdown-input, .code-input {
  width: 100%;
  min-height: 120px;
  padding: 10px;
  border: 1px solid var(--background-quinary);
  border-radius: 4px;
  background: var(--background-quinary);
  color: var(--text-primary);
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  resize: vertical;
}

.node-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.node-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 10px;
  border-radius: 4px;
  background: var(--background-quinary);
}

.node-type {
  font-weight: bold;
  color: #0EA5E9;
  min-width: 80px;
  font-size: 12px;
  text-transform: uppercase;
}

.node-content {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  white-space: pre-wrap;
  flex: 1;
}

.node-language {
  color: #fee75c;
  font-size: 12px;
}

.node-emoji .node-content {
  color: #57f287;
}

.node-bold .node-content {
  font-weight: bold;
  color: var(--text-primary);
}

.node-italic .node-content {
  font-style: italic;
  color: var(--text-primary);
}

.node-code .node-content {
  background: rgba(79, 84, 92, 0.32);
  padding: 2px 4px;
  border-radius: 3px;
  color: var(--text-primary);
}

.node-codeblock .node-content {
  background: var(--background-tertiary);
  padding: 8px;
  border-radius: 4px;
  border: 1px solid var(--background-quinary);
  color: var(--text-secondary);
}

.code-preview {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  line-height: 1.4;
  white-space: pre;
  overflow-x: auto;
}

select {
  padding: 5px 10px;
  margin-bottom: 10px;
  border: 1px solid var(--background-quinary);
  border-radius: 4px;
  background: var(--background-quinary);
  color: var(--text-primary);
}

/* Syntax highlighting classes */
.syntax-keyword {
  color: #0EA5E9;
  font-weight: bold;
}

.syntax-string {
  color: #57f287;
}

.syntax-number {
  color: #fee75c;
}

.syntax-comment {
  color: var(--text-muted);
  font-style: italic;
}

.syntax-operator {
  color: #ed4245;
}

.syntax-punctuation {
  color: var(--text-secondary);
}

.syntax-function {
  color: #57f287;
}

.syntax-variable {
  color: var(--text-primary);
}

.syntax-text {
  color: var(--text-secondary);
}
</style>
