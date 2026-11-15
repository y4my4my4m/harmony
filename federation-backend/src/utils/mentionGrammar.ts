/**
 * User handle grammar. Mirror of src/utils/mentionGrammar.ts (frontend);
 * src/utils/__tests__/mentionGrammar.parity.test.ts asserts the two agree.
 *
 *   handle = "@" word [ "@" host ] / "@" word 1*( "." word ) "@" host
 *   word   = 1*( ALPHA / DIGIT / "_" / "-" )
 *   host   = label *( "." label )        ; any number of labels, no port
 *   label  = alnum [ *( alnum / "-" ) alnum ]
 *
 * A dotted user stands only before a host: Bluesky accounts bridged by
 * Bridgy Fed (`@alice.bsky.social@bsky.brid.gy`), Threads, and other
 * software name remote accounts so, as Mastodon's Account::USERNAME_RE
 * allows. Local usernames carry no dot.
 *
 * Left boundary: start of text, or a character other than a letter, digit,
 * "_", "@", "/" or "\\". `bob@example.com`, `@@bob` and `\\@bob` are not handles.
 * Right boundary: end of text, or a character other than a letter, digit,
 * "_", "-" or "@", and not "." followed by a letter or digit. Trailing
 * ".", ",", "!", "?", ")", ":" end the handle; `@bob.example.com` is not a
 * handle. Hosts compare case-insensitively and are returned lowercased.
 */

const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const WORD = '[A-Za-z0-9_-]+';

// Exactly two capture groups (user, host): callers splice the pattern into larger ones.
export const HANDLE_PATTERN =
  `(?<![\\p{L}\\p{N}_@/\\\\])@(${WORD}(?:\\.${WORD})+(?=@${LABEL})|${WORD})` +
  `(?:@(${LABEL}(?:\\.${LABEL})*))?` +
  '(?![\\p{L}\\p{N}_@-]|\\.[\\p{L}\\p{N}_-])';

export interface HandleMatch {
  /** Offset of the leading "@". */
  start: number;
  /** Offset one past the last character. */
  end: number;
  raw: string;
  username: string;
  /** Lowercased host; absent for a bare `@user`. */
  domain?: string;
}

/** Fresh global regex; group 1 is the user, group 2 the host. Requires the `u` flag. */
export function createHandleRegex(): RegExp {
  return new RegExp(HANDLE_PATTERN, 'gu');
}

const EXACT_HANDLE = new RegExp(`^${HANDLE_PATTERN}$`, 'u');
const EXACT_HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

export function findHandles(text: string): HandleMatch[] {
  if (!text) return [];
  const re = createHandleRegex();
  const out: HandleMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      username: m[1],
      domain: m[2] ? m[2].toLowerCase() : undefined,
    });
  }
  return out;
}

/** Parses a whole string as one handle; null when it is not exactly one. */
export function parseHandle(text: string): { username: string; domain?: string } | null {
  const m = EXACT_HANDLE.exec(text);
  if (!m) return null;
  return { username: m[1], domain: m[2] ? m[2].toLowerCase() : undefined };
}

export function isValidHost(host: string): boolean {
  return EXACT_HOST.test(host);
}
