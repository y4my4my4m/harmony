/**
 * RFC 9421 HTTP Message Signatures, verifying side, with RFC 9530
 * Content-Digest. Signature-Input and Signature are RFC 8941 dictionaries.
 *
 * Accepted profile, the one Mastodon (4.5+ inbound, 4.7+ outbound) and Fedify
 * emit for ActivityPub:
 *   - rsa-v1_5-sha256 (an absent `alg` means the same);
 *   - `@method` and the target covered: `@target-uri`, or `@authority` with
 *     `@request-target`, or with `@path` and, when the URL has a query,
 *     `@query`;
 *   - a request body covered by `content-digest`, verified;
 *   - `keyid` and `created` present, `created` within the clock-skew window,
 *     `expires` (when present) not passed.
 * Component identifiers carrying parameters (`;sf`, `;key`, `;bs`, `;req`,
 * `@query-param`) are refused.
 */

import crypto from 'crypto';

export type SfBareItem = string | number | boolean | Uint8Array | SfToken;

export class SfToken {
  constructor(readonly value: string) {}
}

type SfParams = Array<[string, SfBareItem]>;

interface SfInnerList {
  items: Array<{ value: SfBareItem; params: SfParams }>;
  params: SfParams;
}

interface SfMember {
  value: SfBareItem | SfInnerList;
  params: SfParams;
}

class SfParseError extends Error {}

/** RFC 8941 §4.2 parser for the dictionary, inner list, item and parameter forms. */
class SfParser {
  private i = 0;

  constructor(private readonly s: string) {}

  private fail(what: string): never {
    throw new SfParseError(`${what} at ${this.i}`);
  }

  private sp(): void {
    while (this.s[this.i] === ' ') this.i++;
  }

  private ows(): void {
    while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i++;
  }

  private key(): string {
    const m = /^[a-z*][a-z0-9_\-.*]*/.exec(this.s.slice(this.i));
    if (!m) this.fail('key expected');
    this.i += m[0].length;
    return m[0];
  }

  private bareItem(): SfBareItem {
    const c = this.s[this.i];
    if (c === '"') {
      let out = '';
      this.i++;
      for (;;) {
        const ch = this.s[this.i++];
        if (ch === undefined) this.fail('unterminated string');
        if (ch === '\\') {
          const next = this.s[this.i++];
          if (next !== '"' && next !== '\\') this.fail('bad escape');
          out += next;
        } else if (ch === '"') {
          return out;
        } else {
          const code = ch.charCodeAt(0);
          if (code < 0x20 || code > 0x7e) this.fail('bad string character');
          out += ch;
        }
      }
    }
    if (c === ':') {
      const end = this.s.indexOf(':', this.i + 1);
      if (end < 0) this.fail('unterminated byte sequence');
      const b64 = this.s.slice(this.i + 1, end);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) this.fail('bad byte sequence');
      this.i = end + 1;
      return new Uint8Array(Buffer.from(b64, 'base64'));
    }
    if (c === '?') {
      const v = this.s[this.i + 1];
      if (v !== '0' && v !== '1') this.fail('bad boolean');
      this.i += 2;
      return v === '1';
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?[0-9]{1,15}(\.[0-9]{1,3})?/.exec(this.s.slice(this.i));
      if (!m) this.fail('bad number');
      this.i += m[0].length;
      return Number(m[0]);
    }
    if (c !== undefined && /[A-Za-z*]/.test(c)) {
      const m = /^[A-Za-z*][!#$%&'*+\-.^_`|~0-9A-Za-z:/]*/.exec(this.s.slice(this.i))!;
      this.i += m[0].length;
      return new SfToken(m[0]);
    }
    this.fail('item expected');
  }

  private params(): SfParams {
    const out: SfParams = [];
    while (this.s[this.i] === ';') {
      this.i++;
      this.sp();
      const k = this.key();
      let v: SfBareItem = true;
      if (this.s[this.i] === '=') {
        this.i++;
        v = this.bareItem();
      }
      const at = out.findIndex(([name]) => name === k);
      if (at >= 0) out[at] = [k, v];
      else out.push([k, v]);
    }
    return out;
  }

  private innerList(): SfInnerList {
    this.i++;
    const items: SfInnerList['items'] = [];
    for (;;) {
      this.sp();
      if (this.s[this.i] === ')') {
        this.i++;
        return { items, params: this.params() };
      }
      items.push({ value: this.bareItem(), params: this.params() });
      const c = this.s[this.i];
      if (c !== ' ' && c !== ')') this.fail('inner list separator expected');
    }
  }

  dictionary(): Map<string, SfMember> {
    const out = new Map<string, SfMember>();
    this.ows();
    while (this.i < this.s.length) {
      const k = this.key();
      let member: SfMember;
      if (this.s[this.i] === '=') {
        this.i++;
        if (this.s[this.i] === '(') {
          const list = this.innerList();
          member = { value: list, params: list.params };
        } else {
          const value = this.bareItem();
          member = { value, params: this.params() };
        }
      } else {
        member = { value: true, params: this.params() };
      }
      out.set(k, member);
      this.ows();
      if (this.i >= this.s.length) break;
      if (this.s[this.i] !== ',') this.fail('comma expected');
      this.i++;
      this.ows();
      if (this.i >= this.s.length) this.fail('trailing comma');
    }
    return out;
  }
}

export function parseSfDictionary(value: string): Map<string, SfMember> | null {
  try {
    return new SfParser(value).dictionary();
  } catch (err) {
    if (err instanceof SfParseError) return null;
    throw err;
  }
}

function isInnerList(value: SfMember['value']): value is SfInnerList {
  return typeof value === 'object' && value !== null && 'items' in value;
}

function serializeBareItem(v: SfBareItem): string {
  if (typeof v === 'string') return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '?1' : '?0';
  if (v instanceof SfToken) return v.value;
  return `:${Buffer.from(v).toString('base64')}:`;
}

function serializeParams(params: SfParams): string {
  return params.map(([k, v]) => (v === true ? `;${k}` : `;${k}=${serializeBareItem(v)}`)).join('');
}

export interface MessageSignature {
  label: string;
  /** Component identifiers in signed order, e.g. `@method`, `content-digest`. */
  components: string[];
  keyId: string;
  created: number;
  expires: number | null;
  alg: string | null;
  /** The `@signature-params` value: the serialized inner list. */
  signatureParams: string;
  signature: Buffer;
}

/**
 * The first signature of Signature-Input that Signature carries, or why none
 * is usable.
 */
export function parseMessageSignature(signatureInput: string, signatureHeader: string): MessageSignature | { error: string } {
  const inputs = parseSfDictionary(signatureInput);
  const values = parseSfDictionary(signatureHeader);
  if (!inputs || !values) return { error: 'Unparseable Signature-Input or Signature' };

  for (const [label, input] of inputs) {
    const value = values.get(label);
    if (!value || !(value.value instanceof Uint8Array)) continue;
    const list = input.value;
    if (!isInnerList(list)) return { error: `Signature-Input ${label} is not an inner list` };

    const components: string[] = [];
    for (const item of list.items) {
      if (typeof item.value !== 'string') return { error: 'Component identifier is not a string' };
      if (item.params.length > 0) return { error: `Component parameters are not supported (${item.value})` };
      if (item.value !== item.value.toLowerCase()) return { error: `Component identifier is not lowercase (${item.value})` };
      if (components.includes(item.value)) return { error: `Component ${item.value} is covered twice` };
      components.push(item.value);
    }

    const param = (name: string) => list.params.find(([k]) => k === name)?.[1];
    const keyId = param('keyid');
    const created = param('created');
    const expires = param('expires');
    const alg = param('alg');
    if (typeof keyId !== 'string' || !keyId) return { error: 'keyid missing' };
    if (typeof created !== 'number' || !Number.isInteger(created)) return { error: 'created missing' };
    if (expires !== undefined && (typeof expires !== 'number' || !Number.isInteger(expires))) return { error: 'bad expires' };
    if (alg !== undefined && typeof alg !== 'string') return { error: 'bad alg' };

    return {
      label,
      components,
      keyId,
      created,
      expires: typeof expires === 'number' ? expires : null,
      alg: typeof alg === 'string' ? alg : null,
      signatureParams: `(${list.items.map((it) => serializeBareItem(it.value)).join(' ')})${serializeParams(list.params)}`,
      signature: Buffer.from(value.value),
    };
  }
  return { error: 'No signature in Signature matches Signature-Input' };
}

export interface SignedRequest {
  method: string;
  /** `http` or `https`. */
  scheme: string;
  /** Path and query as received. */
  target: string;
  /** Header names lowercased, as Node delivers them. */
  headers: Record<string, string | string[] | undefined>;
}

function headerValue(headers: SignedRequest['headers'], name: string): string | null {
  const v = headers[name];
  if (v === undefined) return null;
  return (Array.isArray(v) ? v.join(', ') : v).trim();
}

/** RFC 9421 §2.2.3: lowercase host, default port omitted. */
function authorityOf(req: SignedRequest): string | null {
  const host = headerValue(req.headers, 'host');
  if (!host) return null;
  const lower = host.toLowerCase();
  const defaultPort = req.scheme === 'https' ? ':443' : ':80';
  return lower.endsWith(defaultPort) ? lower.slice(0, -defaultPort.length) : lower;
}

/** RFC 9421 §2.5 signature base; an error when a covered component is absent. */
export function signatureBase(sig: MessageSignature, req: SignedRequest): string | { error: string } {
  const queryAt = req.target.indexOf('?');
  const path = (queryAt >= 0 ? req.target.slice(0, queryAt) : req.target) || '/';
  const query = queryAt >= 0 ? req.target.slice(queryAt) : '?';
  const authority = authorityOf(req);

  const lines: string[] = [];
  for (const c of sig.components) {
    let v: string | null;
    switch (c) {
      case '@method': v = req.method.toUpperCase(); break;
      case '@target-uri': v = authority ? `${req.scheme}://${authority}${req.target}` : null; break;
      case '@authority': v = authority; break;
      case '@scheme': v = req.scheme; break;
      case '@request-target': v = req.target; break;
      case '@path': v = path; break;
      case '@query': v = query; break;
      default:
        if (c.startsWith('@')) return { error: `Unsupported derived component ${c}` };
        v = headerValue(req.headers, c);
    }
    if (v === null) return { error: `Covered component ${c} is absent` };
    lines.push(`"${c}": ${v}`);
  }
  lines.push(`"@signature-params": ${sig.signatureParams}`);
  return lines.join('\n');
}

/** Whether the covered components bind the method and the request target. */
export function coversRequest(sig: MessageSignature, target: string): boolean {
  const has = (c: string) => sig.components.includes(c);
  if (!has('@method')) return false;
  if (has('@target-uri')) return true;
  if (!has('@authority')) return false;
  if (has('@request-target')) return true;
  return has('@path') && (!target.includes('?') || has('@query'));
}

const DIGEST_ALGORITHMS: Record<string, string> = { 'sha-256': 'sha256', 'sha-512': 'sha512' };

/**
 * RFC 9530 Content-Digest check: every supported algorithm listed matches the
 * body, and at least one is listed.
 */
export function contentDigestMatches(header: string, body: Buffer | string): boolean {
  const dict = parseSfDictionary(header);
  if (!dict) return false;
  let checked = 0;
  for (const [alg, member] of dict) {
    const hash = DIGEST_ALGORITHMS[alg];
    if (!hash) continue;
    if (!(member.value instanceof Uint8Array)) return false;
    const expected = crypto.createHash(hash).update(body).digest();
    const got = Buffer.from(member.value);
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return false;
    checked++;
  }
  return checked > 0;
}

/** rsa-v1_5-sha256 verification of the signature base. */
export function verifyRsaV15Sha256(base: string, signature: Buffer, publicKeyPem: string): boolean {
  try {
    return crypto.verify(
      'sha256',
      Buffer.from(base, 'utf-8'),
      { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
      signature,
    );
  } catch {
    return false;
  }
}
