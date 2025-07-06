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
  language?: string; // For code blocks
  raw?: string; // The original text including markers
}

// Regex patterns for markdown syntax
const PATTERNS = {
  // Code blocks (must be checked first)
  codeblock: /```(\w+)?\n?([\s\S]*?)```/g,
  // Inline code
  code: /`([^`]+)`/g,
  // Bold text
  bold: /\*\*([^*]+)\*\*/g,
  // Italic text
  italic: /\*([^*]+)\*/g,
  // Underline text
  underline: /__([^_]+)__/g,
  // Strikethrough text
  strikethrough: /~~([^~]+)~~/g,
  // Custom emoji
  emoji: /:([a-zA-Z0-9_+-]+):/g,
  // Line breaks
  newline: /\n/g
};

export function parseMarkdownToNodes(text: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];

  // Store all matches with their positions
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
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      
      while ((match = regex.exec(text)) !== null) {
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

    // Sort matches by position, with longer matches taking precedence for overlaps
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

  // Process matches and create nodes
  for (const match of filteredMatches) {
    // Add any plain text before this match
    if (match.start > processedUntil) {
      const plainText = text.substring(processedUntil, match.start);
      if (plainText) {
        // Split by newlines and create separate nodes
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

    // Create node for the match
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

  // Add any remaining plain text
  if (processedUntil < text.length) {
    const remainingText = text.substring(processedUntil);
    if (remainingText) {
      // Split by newlines and create separate nodes
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

export function parseMarkdownWithMarkers(text: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];
  
  // Store all matches with their positions
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
    // Complete code blocks
    const completeCodeblockPattern = /```(\w+)?\n?([\s\S]*?)```/g;
    let match: RegExpMatchArray | null;
    while ((match = completeCodeblockPattern.exec(text)) !== null) {
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
    completeCodeblockPattern.lastIndex = 0;

    // Incomplete code blocks (starting with ``` but not closed)
    const incompleteCodeblockPattern = /```(\w+)?(?:\n([\s\S]*))?$/g;
    while ((match = incompleteCodeblockPattern.exec(text)) !== null) {
      // Check if this position is already covered by a complete code block
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
    incompleteCodeblockPattern.lastIndex = 0;

    // Other patterns (skip areas inside code blocks)
    const otherPatterns = {
      code: /`([^`\n]+)`/g, // Don't allow newlines in inline code
      bold: /\*\*([^*\n]+)\*\*/g, // Don't allow newlines in formatting
      italic: /(?<!\*)\*([^*\n]+)\*(?!\*)/g,
      underline: /__([^_\n]+)__/g,
      strikethrough: /~~([^~\n]+)~~/g,
      emoji: /:([a-zA-Z0-9_+-]+):/g
    };

    Object.entries(otherPatterns).forEach(([type, pattern]) => {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const start = match.index;
        const end = match.index + match[0].length;
        
        // Check if this match is inside any code block
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

  // Reset lastIndex for token creation
  lastIndex = 0;

  filteredMatches.forEach(match => {
    // Add text before this match
    if (match.start > lastIndex) {
      const textContent = text.slice(lastIndex, match.start);
      if (textContent) {
        tokens.push({
          type: 'text',
          content: textContent
        });
      }
    }

    // Add the matched token
    if (match.type === 'incomplete_codeblock') {
      // Render incomplete code blocks as text with visible markers
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

  // Add remaining text
  if (lastIndex < text.length) {
    const textContent = text.slice(lastIndex);
    if (textContent) {
      tokens.push({
        type: 'text',
        content: textContent
      });
    }
  }

  return tokens;
}
