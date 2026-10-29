// A streaming XML tokenizer: text given in pieces, elements and text handed on as they complete, so no document is
// held whole (a 3MF model part can be hundreds of megabytes; the user, 2026-10-29: our own reader). Tags are matched
// by regular expressions (V8 runs them natively, much faster than a loop over characters in JavaScript), with a
// quote-aware scan only where one fails, to tell a tag cut off at the end of a piece from a malformed one. It reads
// what 3MF uses: elements, attributes, text with entities and character references, comments, CDATA, processing
// instructions; a document type declaration is skipped (3MF forbids them). Namespaces are the caller's (`Scopes`).

export interface XmlHandler {
  /** An element's start: its qualified name, its attributes as [name, value, name, value, ...], whether it's empty. */
  start(name: string, attrs: string[], empty: boolean): void;
  end(name: string): void;
  /** Text content (decoded), possibly in several calls; only asked for while `wantText` says so. */
  text?(s: string): void;
  wantText?(): boolean;
  /** A problem in the document; reading goes on where it can. */
  problem(message: string): void;
}

const TAG = /<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const ATTR = /\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const END = /<\/([^\s>]+)\s*>/y;
/** A tag longer than this that doesn't complete is malformed, not cut off. */
const LONGEST = 1 << 22;

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
const REFERENCE = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z]+));/g;

/** Entities and character references replaced (unknown ones kept as they are). */
export function decodeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(REFERENCE, (all, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name !== undefined) return ENTITY[name] ?? all;
    const code = parseInt(hex ?? dec!, hex ? 16 : 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

export class XmlTokenizer {
  private buf = '';
  private readonly h: XmlHandler;
  /** Characters handed on before `buf`, for messages. */
  private consumed = 0;

  constructor(handler: XmlHandler) {
    this.h = handler;
  }

  feed(s: string): void {
    this.buf = this.buf ? this.buf + s : s;
    this.run(false);
  }

  end(): void {
    this.run(true);
    if (this.buf.trim()) this.h.problem(`the document ends inside markup at character ${this.consumed}`);
    this.buf = '';
  }

  private run(final: boolean): void {
    const b = this.buf, h = this.h;
    let pos = 0;
    for (;;) {
      const lt = b.indexOf('<', pos);
      // Text up to the next tag (all of it at the end, else up to an entity that may continue in the next piece).
      const until = lt < 0 ? (final ? b.length : this.textEnd(b, pos)) : lt;
      if (until > pos) {
        if (h.text && h.wantText?.()) h.text(decodeXml(b.slice(pos, until)));
        pos = until;
      }
      if (lt < 0) break;
      const next = b.charCodeAt(lt + 1);
      if (Number.isNaN(next)) { if (final) pos = this.skip(b, lt, b.length, 'a lone <'); break; }
      let close = -1;
      // Comments, CDATA, declarations and processing instructions end at their own terminators, not at a `>`.
      const special = next === 0x21 || next === 0x3f;
      if (next === 0x21 /* ! */) {
        if (b.startsWith('<!--', lt)) close = this.through(b, lt, '-->');
        else if (b.startsWith('<![CDATA[', lt)) {
          const e = b.indexOf(']]>', lt + 9);
          if (e >= 0) {
            if (h.text && h.wantText?.()) h.text(b.slice(lt + 9, e));
            close = e + 3;
          }
        } else if (b.length - lt < 9 && !final) break;
        else {
          // A document type declaration, with its internal subset if any.
          const bracket = b.indexOf('[', lt), gt = b.indexOf('>', lt);
          close = bracket >= 0 && (gt < 0 || bracket < gt) ? this.through(b, bracket, ']>') : gt < 0 ? -1 : gt + 1;
          if (close >= 0) h.problem('a document type declaration, ignored');
        }
      } else if (next === 0x3f /* ? */) close = this.through(b, lt, '?>');
      else if (next === 0x2f /* / */) {
        END.lastIndex = lt;
        const m = END.exec(b);
        if (m) { h.end(m[1]!); close = END.lastIndex; }
      } else {
        TAG.lastIndex = lt;
        const m = TAG.exec(b);
        if (m) {
          const attrs: string[] = [];
          if (m[2]) {
            ATTR.lastIndex = 0;
            for (let a = ATTR.exec(m[2]); a; a = ATTR.exec(m[2])) {
              let v = a[2] ?? a[3]!;
              // Attribute-value normalization: tabs and line breaks read as spaces.
              if (/[\t\n\r]/.test(v)) v = v.replace(/\r\n|[\t\n\r]/g, ' ');
              attrs.push(a[1]!, decodeXml(v));
            }
          }
          h.start(m[1]!, attrs, m[3] === '/');
          close = TAG.lastIndex;
        }
      }
      if (close < 0 && special) {
        if (!final) { pos = lt; break; }
        pos = this.skip(b, lt, b.length, 'markup that never ends');
        break;
      }
      if (close < 0) {
        // Cut off at the end of this piece, or malformed: a quote-aware scan for the tag's end tells which.
        const gt = this.tagEnd(b, lt);
        if (gt < 0) {
          if (!final && b.length - lt < LONGEST) { pos = lt; break; }
          pos = this.skip(b, lt, b.length, 'markup that never ends');
          break;
        }
        pos = this.skip(b, lt, gt + 1, 'malformed markup');
        continue;
      }
      pos = close;
    }
    this.consumed += pos;
    this.buf = b.slice(pos);
  }

  /** Where a text run may end in this piece: before a trailing `&...` that may continue. */
  private textEnd(b: string, pos: number): number {
    const amp = b.lastIndexOf('&');
    return amp >= pos && b.indexOf(';', amp) < 0 ? amp : b.length;
  }

  /** Past the next `end` after `from`, or -1. */
  private through(b: string, from: number, end: string): number {
    const e = b.indexOf(end, from + 2);
    return e < 0 ? -1 : e + end.length;
  }

  /** The `>` ending the tag at `lt`, outside quotes, or -1. */
  private tagEnd(b: string, lt: number): number {
    let quote = 0;
    for (let i = lt + 1; i < b.length; i++) {
      const c = b.charCodeAt(i);
      if (quote) { if (c === quote) quote = 0; } else if (c === 0x22 || c === 0x27) quote = c;
      else if (c === 0x3e) return i;
    }
    return -1;
  }

  private skip(b: string, from: number, to: number, what: string): number {
    this.h.problem(`${what} at character ${this.consumed + from}: ${JSON.stringify(b.slice(from, Math.min(to, from
      + 60)))}`);
    return to;
  }
}

/** Namespace scopes: an element's declarations apply to it and what it contains. */
export class Scopes {
  private readonly stack: (Map<string, string> | undefined)[] = [];

  /** Enters an element (its attributes' declarations). */
  push(attrs: string[]): void {
    let scope: Map<string, string> | undefined;
    for (let i = 0; i < attrs.length; i += 2) {
      const n = attrs[i]!;
      if (n === 'xmlns') (scope ??= new Map()).set('', attrs[i + 1]!);
      else if (n.startsWith('xmlns:')) (scope ??= new Map()).set(n.slice(6), attrs[i + 1]!);
    }
    this.stack.push(scope);
  }

  pop(): void {
    this.stack.pop();
  }

  /** The namespace of a prefix ('' the default), or undefined. */
  uri(prefix: string): string | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const u = this.stack[i]?.get(prefix);
      if (u !== undefined) return u;
    }
    return prefix === 'xml' ? 'http://www.w3.org/XML/1998/namespace' : undefined;
  }

  /** A qualified name's namespace and local name (unprefixed attributes have none: `attribute`). */
  resolve(qname: string, attribute = false): { uri: string | undefined; local: string } {
    const colon = qname.indexOf(':');
    if (colon < 0) return { uri: attribute ? undefined : this.uri(''), local: qname };
    return { uri: this.uri(qname.slice(0, colon)), local: qname.slice(colon + 1) };
  }
}
