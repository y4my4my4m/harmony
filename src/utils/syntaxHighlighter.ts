export interface SyntaxToken {
  type: 'keyword' | 'string' | 'number' | 'comment' | 'operator' | 'punctuation' | 'function' | 'variable' | 'property' | 'text';
  content: string;
  className: string;
}

// Language definitions
const LANGUAGES: Record<string, {
  keywords: string[];
  operators: string[];
  stringDelimiters: string[];
  singleLineComment?: string;
  multiLineComment?: { start: string; end: string };
}> = {
  javascript: {
    keywords: ['var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'super', 'class', 'extends', 'import', 'export', 'from', 'default', 'async', 'await', 'true', 'false', 'null', 'undefined'],
    operators: ['+', '-', '*', '/', '%', '=', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '&&', '||', '!', '?', ':', '++', '--', '+=', '-=', '*=', '/='],
    stringDelimiters: ['"', "'", '`'],
    singleLineComment: '//',
    multiLineComment: { start: '/*', end: '*/' }
  },
  typescript: {
    keywords: ['var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'super', 'class', 'extends', 'import', 'export', 'from', 'default', 'async', 'await', 'true', 'false', 'null', 'undefined', 'type', 'interface', 'enum', 'namespace', 'declare', 'readonly', 'private', 'public', 'protected', 'static', 'abstract'],
    operators: ['+', '-', '*', '/', '%', '=', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '&&', '||', '!', '?', ':', '++', '--', '+=', '-=', '*=', '/='],
    stringDelimiters: ['"', "'", '`'],
    singleLineComment: '//',
    multiLineComment: { start: '/*', end: '*/' }
  },
  python: {
    keywords: ['def', 'class', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'return', 'try', 'except', 'finally', 'raise', 'import', 'from', 'as', 'with', 'pass', 'lambda', 'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is', 'global', 'nonlocal'],
    operators: ['+', '-', '*', '/', '//', '%', '**', '=', '==', '!=', '<', '>', '<=', '>=', 'and', 'or', 'not', '+=', '-=', '*=', '/='],
    stringDelimiters: ['"', "'"],
    singleLineComment: '#'
  },
  json: {
    keywords: ['true', 'false', 'null'],
    operators: [':'],
    stringDelimiters: ['"']
  },
  css: {
    keywords: ['color', 'background', 'font', 'margin', 'padding', 'border', 'width', 'height', 'display', 'position', 'top', 'left', 'right', 'bottom'],
    operators: [':'],
    stringDelimiters: ['"', "'"],
    singleLineComment: '//',
    multiLineComment: { start: '/*', end: '*/' }
  },
  html: {
    keywords: ['div', 'span', 'p', 'a', 'img', 'ul', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'body', 'head', 'title', 'meta', 'link', 'script', 'style'],
    operators: ['='],
    stringDelimiters: ['"', "'"],
    multiLineComment: { start: '<!--', end: '-->' }
  }
};

export function highlightSyntax(code: string, language: string = 'text'): SyntaxToken[] {
  if (!LANGUAGES[language]) {
    return [{ type: 'text', content: code, className: '' }];
  }

  const tokens: SyntaxToken[] = [];
  const lang = LANGUAGES[language];
  let remaining = code;

  while (remaining.length > 0) {
    let matched = false;

    // Check for multi-line comments first
    if (lang.multiLineComment) {
      const commentStart = remaining.indexOf(lang.multiLineComment.start);
      if (commentStart === 0) {
        const commentEnd = remaining.indexOf(lang.multiLineComment.end, lang.multiLineComment.start.length);
        if (commentEnd !== -1) {
          const comment = remaining.substring(0, commentEnd + lang.multiLineComment.end.length);
          tokens.push({ type: 'comment', content: comment, className: 'token comment' });
          remaining = remaining.substring(comment.length);
          matched = true;
          continue;
        }
      }
    }

    // Check for single-line comments
    if (lang.singleLineComment && remaining.startsWith(lang.singleLineComment)) {
      const lineEnd = remaining.indexOf('\n');
      const comment = lineEnd === -1 ? remaining : remaining.substring(0, lineEnd);
      tokens.push({ type: 'comment', content: comment, className: 'token comment' });
      remaining = remaining.substring(comment.length);
      matched = true;
      continue;
    }

    // Check for strings
    for (const delimiter of lang.stringDelimiters) {
      if (remaining.startsWith(delimiter)) {
        let stringEnd = 1;
        let escaped = false;
        
        while (stringEnd < remaining.length) {
          const char = remaining[stringEnd];
          if (escaped) {
            escaped = false;
          } else if (char === '\\') {
            escaped = true;
          } else if (char === delimiter) {
            stringEnd++;
            break;
          }
          stringEnd++;
        }
        
        const string = remaining.substring(0, stringEnd);
        tokens.push({ type: 'string', content: string, className: 'token string' });
        remaining = remaining.substring(stringEnd);
        matched = true;
        break;
      }
    }

    if (matched) continue;

    // Check for numbers
    const numberMatch = remaining.match(/^(\d+\.?\d*|\.\d+)/);
    if (numberMatch) {
      tokens.push({ type: 'number', content: numberMatch[0], className: 'token number' });
      remaining = remaining.substring(numberMatch[0].length);
      matched = true;
      continue;
    }

    // Check for keywords and identifiers
    const wordMatch = remaining.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
    if (wordMatch) {
      const word = wordMatch[0];
      if (lang.keywords.includes(word)) {
        tokens.push({ type: 'keyword', content: word, className: 'token keyword' });
      } else {
        const nextChar = remaining[word.length];
        if (nextChar === '(') {
          tokens.push({ type: 'function', content: word, className: 'token function' });
        } else {
          tokens.push({ type: 'variable', content: word, className: 'token variable' });
        }
      }
      remaining = remaining.substring(word.length);
      matched = true;
      continue;
    }

    // Check for operators
    for (const op of lang.operators.sort((a, b) => b.length - a.length)) {
      if (remaining.startsWith(op)) {
        tokens.push({ type: 'operator', content: op, className: 'token operator' });
        remaining = remaining.substring(op.length);
        matched = true;
        break;
      }
    }

    if (matched) continue;

    // Check for punctuation
    const punctuationMatch = remaining.match(/^[{}[\]();,.:]/);
    if (punctuationMatch) {
      tokens.push({ type: 'punctuation', content: punctuationMatch[0], className: 'token punctuation' });
      remaining = remaining.substring(1);
      matched = true;
      continue;
    }

    // Default: add single character as text
    const char = remaining[0];
    tokens.push({ type: 'text', content: char, className: '' });
    remaining = remaining.substring(1);
  }

  return tokens;
}

export function getSupportedLanguages(): string[] {
  return Object.keys(LANGUAGES);
}
