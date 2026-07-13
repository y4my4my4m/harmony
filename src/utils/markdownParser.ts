export interface MarkdownNode {
  type: 'text' | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'codeblock' | 'emoji' | 'newline';
  content: string;
  language?: string; // For code blocks
  emojiData?: { name: string; url: string; id: string };
  children?: MarkdownNode[];
}

export interface ParsedContent {
  text: string;
  nodes: MarkdownNode[];
}

export interface MarkdownToken {
  type: 'text' | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'codeblock' | 'emoji';
  content: string;
  language?: string;
  raw?: string;
  children?: MarkdownToken[];
}

const PATTERNS = {
  codeblock: /```(\w+)?\n?([\s\S]*?)```/g,
  code: /`([^`]+)`/g,
  bold: /\*\*(.+?)\*\*/g,
  italic: /\*([^*]+)\*/g,
  underline: /__((?:(?!__).)+?)__/g,
  strikethrough: /~~((?:(?!~~).)+?)~~/g,
  emoji: /:([a-zA-Z0-9_+~-]+):/g,
  newline: /\n/g
};

// Hoisted to module scope so they aren't re-allocated on every call to
// `parseMarkdownWithMarkers`. Stateful 'g' regexes require lastIndex resets
// before each use, which we do at the call sites.
const COMPLETE_CODEBLOCK_PATTERN = /```(\w+)?\n?([\s\S]*?)```/g;
const INCOMPLETE_CODEBLOCK_PATTERN = /```(\w+)?(?:\n([\s\S]*))?$/g;
const STREAMING_OTHER_PATTERNS = {
  code: /`([^`\n]+)`/g,
  bold: /\*\*(.+?)\*\*/g,
  italic: /(?<!\*)\*([^*\n]+)\*(?!\*)/g,
  underline: /__((?:(?!__).)+?)__/g,
  strikethrough: /~~((?:(?!~~).)+?)~~/g,
  emoji: /:([a-zA-Z0-9_+-]+):/g
} as const;

export function parseMarkdownToNodes(text: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];

  interface Match {
    type: keyof typeof PATTERNS;
    match: RegExpMatchArray;
    start: number;
    end: number;
    content: string;
    language?: string;
  }

  const findAllMatches = (text: string): Match[] => {
    const matches: Match[] = [];

    Object.entries(PATTERNS).forEach(([type, pattern]) => {
      // Reuse the module-level regex; reset lastIndex so the stateful 'g'
      // pattern starts from the beginning of the input. Avoids the per-call
      // `new RegExp(...)` allocation that this code used to do.
      pattern.lastIndex = 0;
      let match;
      
      while ((match = pattern.exec(text)) !== null) {
        let content = '';
        let language = undefined;
        
        if (type === 'codeblock') {
          // For codeblock: match[1] is language, match[2] is content
          content = match[2] || '';
          language = match[1] || 'text';
        } else {
          // For other types: match[1] is the content
          content = match[1] || match[0];
        }
        
        matches.push({
          type: type as keyof typeof PATTERNS,
          match,
          start: match.index,
          end: match.index + match[0].length,
          content,
          language
        });
      }
    });

    return matches.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return (b.end - b.start) - (a.end - a.start);
    });
  };

  const matches = findAllMatches(text);
  let processedUntil = 0;

  // Remove overlapping matches (keep the first one found at each position)
  const filteredMatches: Match[] = [];
  let lastEnd = 0;

  for (const match of matches) {
    if (match.start >= lastEnd) {
      filteredMatches.push(match);
      lastEnd = match.end;
    }
  }

  for (const match of filteredMatches) {
    if (match.start > processedUntil) {
      const plainText = text.substring(processedUntil, match.start);
      if (plainText) {
        const textParts = plainText.split('\n');
        textParts.forEach((part, index) => {
          if (part) {
            nodes.push({ type: 'text', content: part });
          }
          if (index < textParts.length - 1) {
            nodes.push({ type: 'newline', content: '\n' });
          }
        });
      }
    }

    switch (match.type) {
      case 'codeblock':
        nodes.push({
          type: 'codeblock',
          content: match.content,
          language: match.language || 'text'
        });
        break;
      case 'code':
        nodes.push({ type: 'code', content: match.content });
        break;
      case 'bold':
        nodes.push({ type: 'bold', content: match.content });
        break;
      case 'italic':
        nodes.push({ type: 'italic', content: match.content });
        break;
      case 'underline':
        nodes.push({ type: 'underline', content: match.content });
        break;
      case 'strikethrough':
        nodes.push({ type: 'strikethrough', content: match.content });
        break;
      case 'emoji':
        nodes.push({ 
          type: 'emoji', 
          content: match.content,
          // Emoji data will be resolved separately
        });
        break;
      case 'newline':
        nodes.push({ type: 'newline', content: '\n' });
        break;
    }

    processedUntil = match.end;
  }

  if (processedUntil < text.length) {
    const remainingText = text.substring(processedUntil);
    if (remainingText) {
      const textParts = remainingText.split('\n');
      textParts.forEach((part, index) => {
        if (part) {
          nodes.push({ type: 'text', content: part });
        }
        if (index < textParts.length - 1) {
          nodes.push({ type: 'newline', content: '\n' });
        }
      });
    }
  }

  return nodes;
}

export function nodesToText(nodes: MarkdownNode[]): string {
  return nodes.map(node => {
    switch (node.type) {
      case 'text':
      case 'newline':
        return node.content;
      case 'bold':
        return `**${node.content}**`;
      case 'italic':
        return `*${node.content}*`;
      case 'underline':
        return `__${node.content}__`;
      case 'strikethrough':
        return `~~${node.content}~~`;
      case 'code':
        return `\`${node.content}\``;
      case 'codeblock':
        return `\`\`\`${node.language || ''}\n${node.content}\`\`\``;
      case 'emoji':
        return `:${node.content}:`;
      default:
        return node.content;
    }
  }).join('');
}

export function getPlainText(nodes: MarkdownNode[]): string {
  return nodes.map(node => {
    switch (node.type) {
      case 'emoji':
        return `:${node.content}:`;
      case 'newline':
        return '\n';
      default:
        return node.content;
    }
  }).join('');
}

const FORMATTING_TYPES = new Set(['bold', 'italic', 'underline', 'strikethrough']);

function parseInlineChildren(content: string, parentType: string): MarkdownToken[] | undefined {
  const innerPatterns: Record<string, RegExp> = {};
  if (parentType !== 'bold') innerPatterns.bold = /\*\*(.+?)\*\*/g;
  if (parentType !== 'italic') innerPatterns.italic = /(?<!\*)\*([^*\n]+)\*(?!\*)/g;
  if (parentType !== 'underline') innerPatterns.underline = /__((?:(?!__).)+?)__/g;
  if (parentType !== 'strikethrough') innerPatterns.strikethrough = /~~((?:(?!~~).)+?)~~/g;
  innerPatterns.code = /`([^`\n]+)`/g;
  innerPatterns.emoji = /:([a-zA-Z0-9_+~-]+):/g;

  interface InnerMatch {
    type: string;
    start: number;
    end: number;
    content: string;
    raw: string;
  }

  const matches: InnerMatch[] = [];
  for (const [type, pattern] of Object.entries(innerPatterns)) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      matches.push({
        type,
        start: match.index!,
        end: match.index! + match[0].length,
        content: match[1] || '',
        raw: match[0]
      });
    }
    pattern.lastIndex = 0;
  }

  if (matches.length === 0) return undefined;

  matches.sort((a, b) => a.start !== b.start ? a.start - b.start : (b.end - b.start) - (a.end - a.start));
  const filtered: InnerMatch[] = [];
  let lastEnd = 0;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      filtered.push(m);
      lastEnd = m.end;
    }
  }

  if (filtered.length === 0) return undefined;

  const tokens: MarkdownToken[] = [];
  let idx = 0;

  for (const m of filtered) {
    if (m.start > idx) {
      tokens.push({ type: 'text', content: content.slice(idx, m.start) });
    }

    const token: MarkdownToken = {
      type: m.type as MarkdownToken['type'],
      content: m.content,
      raw: m.raw
    };

    if (FORMATTING_TYPES.has(m.type)) {
      const children = parseInlineChildren(m.content, m.type);
      if (children) token.children = children;
    }

    tokens.push(token);
    idx = m.end;
  }

  if (idx < content.length) {
    tokens.push({ type: 'text', content: content.slice(idx) });
  }

  const hasFormatting = tokens.some(t => t.type !== 'text');
  return hasFormatting ? tokens : undefined;
}

export function parseMarkdownWithMarkers(text: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];
  
  interface Match {
    type: keyof typeof PATTERNS | 'incomplete_codeblock';
    match: RegExpMatchArray;
    start: number;
    end: number;
    content: string;
    language?: string;
    raw: string;
    isIncomplete?: boolean;
  }

  const findAllMatches = (text: string): Match[] => {
    const matches: Match[] = [];

    // Handle code blocks first (they take precedence)
    // Complete code blocks. Reuse hoisted pattern; reset lastIndex per call.
    COMPLETE_CODEBLOCK_PATTERN.lastIndex = 0;
    let match: RegExpMatchArray | null;
    while ((match = COMPLETE_CODEBLOCK_PATTERN.exec(text)) !== null) {
      matches.push({
        type: 'codeblock',
        match,
        start: match.index!,
        end: match.index! + match[0].length,
        content: match[2] || '',
        language: match[1] || '',
        raw: match[0],
        isIncomplete: false
      });
    }
    COMPLETE_CODEBLOCK_PATTERN.lastIndex = 0;

    // Incomplete code blocks (starting with ``` but not closed)
    INCOMPLETE_CODEBLOCK_PATTERN.lastIndex = 0;
    while ((match = INCOMPLETE_CODEBLOCK_PATTERN.exec(text)) !== null) {
      const isAlreadyCovered = matches.some(existingMatch => 
        match!.index! >= existingMatch.start && match!.index! < existingMatch.end
      );
      
      if (!isAlreadyCovered) {
        matches.push({
          type: 'incomplete_codeblock',
          match,
          start: match.index!,
          end: match.index! + match[0].length,
          content: match[2] || '',
          language: match[1] || '',
          raw: match[0],
          isIncomplete: true
        });
      }
    }
    INCOMPLETE_CODEBLOCK_PATTERN.lastIndex = 0;

    Object.entries(STREAMING_OTHER_PATTERNS).forEach(([type, pattern]) => {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const start = match.index;
        const end = match.index + match[0].length;
        
        const insideCodeBlock = matches.some(codeMatch => 
          (codeMatch.type === 'codeblock' || codeMatch.type === 'incomplete_codeblock') && 
          start >= codeMatch.start && end <= codeMatch.end
        );
        
        if (!insideCodeBlock) {
          matches.push({
            type: type as keyof typeof PATTERNS,
            match,
            start,
            end,
            content: match[1] || '',
            raw: match[0]
          });
        }
      }
      pattern.lastIndex = 0;
    });

    // Sort by start position, longer matches first for overlaps
    return matches.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return (b.end - b.start) - (a.end - a.start);
    });
  };

  const matches = findAllMatches(text);
  let lastIndex = 0;

  // Remove overlapping matches (keep the first/longest at each position)
  const filteredMatches: Match[] = [];
  for (const match of matches) {
    if (match.start >= lastIndex) {
      filteredMatches.push(match);
      lastIndex = match.end;
    }
  }

  lastIndex = 0;

  filteredMatches.forEach(match => {
    if (match.start > lastIndex) {
      const textContent = text.slice(lastIndex, match.start);
      if (textContent) {
        tokens.push({
          type: 'text',
          content: textContent
        });
      }
    }

    if (match.type === 'incomplete_codeblock') {
      tokens.push({
        type: 'text',
        content: match.raw
      });
    } else {
      tokens.push({
        type: match.type as MarkdownToken['type'],
        content: match.content,
        language: match.language,
        raw: match.raw
      });
    }

    lastIndex = match.end;
  });

  if (lastIndex < text.length) {
    const textContent = text.slice(lastIndex);
    if (textContent) {
      tokens.push({
        type: 'text',
        content: textContent
      });
    }
  }

  // Post-process: recursively parse children for formatting tokens
  for (const token of tokens) {
    if (FORMATTING_TYPES.has(token.type)) {
      const children = parseInlineChildren(token.content, token.type);
      if (children) token.children = children;
    }
  }

  return tokens;
}
