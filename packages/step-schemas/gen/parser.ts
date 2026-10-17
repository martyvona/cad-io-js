// Parser for the declaration subset of EXPRESS (ISO 10303-11) that schema binding needs: entities (attributes,
// supertypes, redeclarations, inverses) and types (defined types, selects, enumerations). Rules, functions,
// procedures, constants, subtype constraints, WHERE and UNIQUE clauses, and derive expressions are skipped.

import { tokenize, type Token } from './lexer.ts';
import type {
  AggregateType, Attribute, Bound, EntityDef, InverseAttribute, Redeclaration, SupertypeExpr, TypeDef, TypeRef,
} from '../src/types.ts';

export interface ParsedSchema {
  name: string;
  entities: Record<string, EntityDef>;
  types: Record<string, TypeDef>;
}

const SIMPLE: Record<string, string> = {
  integer: 'INTEGER', real: 'REAL', number: 'NUMBER', logical: 'LOGICAL', boolean: 'BOOLEAN', string: 'STRING',
  binary: 'BINARY',
};

// Entity body sections that end the explicit attribute list.
const SECTION_ENDS = new Set(['derive', 'inverse', 'unique', 'where', 'end_entity']);

export function parseExpress(src: string): ParsedSchema[] {
  return new Parser(tokenize(src)).schemas();
}

class Parser {
  private toks: Token[];
  private pos = 0;

  constructor(toks: Token[]) {
    this.toks = toks;
  }

  schemas(): ParsedSchema[] {
    const out: ParsedSchema[] = [];
    while (this.peek().k !== 'eof') {
      this.expectId('schema');
      const name = this.ident().toUpperCase();
      // Optional schema version id (a string literal).
      if (this.peek().k === 'str') this.next();
      this.expectOp(';');
      const schema: ParsedSchema = { name, entities: {}, types: {} };
      this.schemaBody(schema);
      out.push(schema);
    }
    return out;
  }

  private schemaBody(schema: ParsedSchema): void {
    for (;;) {
      const t = this.next();
      if (t.k !== 'id') throw this.error(t, 'expected a declaration');
      switch (t.v) {
        case 'end_schema':
          this.expectOp(';');
          return;
        case 'entity': {
          const name = this.ident().toUpperCase();
          this.define(schema.entities, name, this.entity(), t);
          break;
        }
        case 'type': {
          const name = this.ident().toUpperCase();
          this.define(schema.types, name, this.typeDecl(), t);
          break;
        }
        case 'use':
        case 'reference':
          this.skipPast(';');
          break;
        case 'constant':
          this.skipBlock('constant', 'end_constant');
          break;
        case 'subtype_constraint':
          this.skipBlock('subtype_constraint', 'end_subtype_constraint');
          break;
        case 'rule':
          this.skipBlock('rule', 'end_rule');
          break;
        case 'function':
        case 'procedure':
          this.skipAlgorithm();
          break;
        default:
          throw this.error(t, `unexpected '${t.v}' in schema body`);
      }
    }
  }

  // --- entities ---

  private entity(): EntityDef {
    const def: EntityDef = { supertypes: [], attrs: [] };
    // Header: [ABSTRACT] [SUPERTYPE [OF (expr)]] [SUBTYPE OF (list)] ;
    for (;;) {
      if (this.acceptId('abstract')) {
        def.abstract = true;
      } else if (this.acceptId('supertype')) {
        if (this.acceptId('of')) {
          this.expectOp('(');
          def.supertypeOf = this.supertypeExpr();
          this.expectOp(')');
        }
      } else if (this.acceptId('subtype')) {
        this.expectId('of');
        def.supertypes = this.identList().map((s) => s.toUpperCase());
      } else {
        break;
      }
    }
    this.expectOp(';');

    // Explicit attributes.
    while (!SECTION_ENDS.has(this.peekId())) {
      const decls = this.attrDeclList();
      this.expectOp(':');
      const optional = this.acceptId('optional');
      const type = this.typeRef();
      this.expectOp(';');
      for (const d of decls) {
        if (d.redecl) {
          const r: Redeclaration = { ...d.redecl, type };
          if (optional) r.optional = true;
          (def.redeclared ??= []).push(r);
        } else {
          const a: Attribute = { name: d.name, type };
          if (optional) a.optional = true;
          def.attrs.push(a);
        }
      }
    }

    if (this.acceptId('derive')) {
      while (!SECTION_ENDS.has(this.peekId())) {
        const decls = this.attrDeclList();
        this.expectOp(':');
        const type = this.typeRef();
        this.expectOp(':=');
        this.skipExpression();
        this.expectOp(';');
        for (const d of decls) {
          if (d.redecl) (def.derivedRedeclared ??= []).push({ ...d.redecl, type });
          else (def.derived ??= []).push(d.name);
        }
      }
    }

    if (this.acceptId('inverse')) {
      while (!SECTION_ENDS.has(this.peekId())) {
        const decl = this.attrDecl();
        this.expectOp(':');
        const inv: Partial<InverseAttribute> = { name: decl.redecl?.renamed ?? decl.name };
        const agg = this.peekId();
        if (agg === 'set' || agg === 'bag') {
          this.next();
          inv.agg = agg === 'set' ? 'SET' : 'BAG';
          if (this.peekOp('[')) [inv.lo, inv.hi] = this.boundSpec();
          this.expectId('of');
        }
        inv.entity = this.ident().toUpperCase();
        this.expectId('for');
        let attr = this.ident();
        // FOR entity.attribute
        if (this.acceptOp('.')) attr = this.ident();
        inv.attr = attr;
        this.expectOp(';');
        (def.inverse ??= []).push(inv as InverseAttribute);
      }
    }

    // UNIQUE and WHERE clauses carry no binding information; END_ENTITY can't occur inside them.
    while (this.peekId() !== 'end_entity') {
      if (this.peek().k === 'eof') throw this.error(this.peek(), 'missing END_ENTITY');
      this.next();
    }
    this.next();
    this.expectOp(';');
    return def;
  }

  /** ONEOF(...), AND, ANDOR, parenthesized groups and entity names. AND binds tighter than ANDOR. */
  private supertypeExpr(): SupertypeExpr {
    return this.chain('andor', () => this.chain('and', () => this.supertypeFactor()));
  }

  private chain(op: 'and' | 'andor', operand: () => SupertypeExpr): SupertypeExpr {
    const args = [operand()];
    while (this.acceptId(op)) args.push(operand());
    if (args.length === 1) return args[0]!;
    const OP = op === 'and' ? 'AND' : 'ANDOR';
    // Flatten nested chains of the same operator.
    return { op: OP, args: args.flatMap((a) => (typeof a !== 'string' && a.op === OP ? a.args : [a])) };
  }

  private supertypeFactor(): SupertypeExpr {
    if (this.acceptId('oneof')) {
      this.expectOp('(');
      const args = [this.supertypeExpr()];
      while (this.acceptOp(',')) args.push(this.supertypeExpr());
      this.expectOp(')');
      return { op: 'ONEOF', args };
    }
    if (this.acceptOp('(')) {
      const e = this.supertypeExpr();
      this.expectOp(')');
      return e;
    }
    return this.ident().toUpperCase();
  }

  private attrDeclList(): { name: string; redecl?: Omit<Redeclaration, 'type'> }[] {
    const out = [this.attrDecl()];
    while (this.acceptOp(',')) out.push(this.attrDecl());
    return out;
  }

  /** `name` or `SELF\entity.attr [RENAMED name]`. */
  private attrDecl(): { name: string; redecl?: Omit<Redeclaration, 'type'> } {
    if (this.peekId() === 'self' && this.toks[this.pos + 1]?.v === '\\') {
      this.pos += 2;
      const from = this.ident().toUpperCase();
      this.expectOp('.');
      const name = this.ident();
      const redecl: Omit<Redeclaration, 'type'> = { from, name };
      if (this.acceptId('renamed')) redecl.renamed = this.ident();
      return { name, redecl };
    }
    return { name: this.ident() };
  }

  // --- types ---

  private typeDecl(): TypeDef {
    this.expectOp('=');
    let def: TypeDef;
    let extensible = false;
    let genericEntity = false;
    if (this.acceptId('extensible')) {
      extensible = true;
      if (this.acceptId('generic_entity')) genericEntity = true;
    }
    if (this.acceptId('select')) {
      const items: string[] = [];
      let basedOn: string | undefined;
      if (this.peekOp('(')) {
        items.push(...this.identList());
      } else if (this.acceptId('based_on')) {
        basedOn = this.ident().toUpperCase();
        if (this.acceptId('with')) items.push(...this.identList());
      }
      def = { kind: 'select', items: items.map((s) => s.toUpperCase()) };
      if (extensible) def.extensible = true;
      if (genericEntity) def.genericEntity = true;
      if (basedOn) def.basedOn = basedOn;
    } else if (this.acceptId('enumeration')) {
      const values: string[] = [];
      let basedOn: string | undefined;
      if (this.acceptId('of')) {
        values.push(...this.identList());
      } else if (this.acceptId('based_on')) {
        basedOn = this.ident().toUpperCase();
        if (this.acceptId('with')) values.push(...this.identList());
      }
      def = { kind: 'enum', values: values.map((s) => s.toUpperCase()) };
      if (extensible) def.extensible = true;
      if (basedOn) def.basedOn = basedOn;
    } else {
      if (extensible) throw this.error(this.peek(), 'EXTENSIBLE on a type that is not a select or enumeration');
      def = { kind: 'defined', type: this.typeRef() };
    }
    this.expectOp(';');
    // WHERE rules, skipped.
    while (this.peekId() !== 'end_type') {
      if (this.peek().k === 'eof') throw this.error(this.peek(), 'missing END_TYPE');
      this.next();
    }
    this.next();
    this.expectOp(';');
    return def;
  }

  private typeRef(): TypeRef {
    const t = this.next();
    if (t.k !== 'id') throw this.error(t, 'expected a type');
    const simple = SIMPLE[t.v];
    if (simple) {
      // Width or precision spec: STRING(255) FIXED, REAL(15), BINARY(32) FIXED. Not needed for binding.
      if (this.acceptOp('(')) this.skipPast(')');
      this.acceptId('fixed');
      return simple;
    }
    if (t.v === 'array' || t.v === 'list' || t.v === 'set' || t.v === 'bag') {
      const agg = t.v.toUpperCase() as AggregateType['agg'];
      let lo: Bound = 0;
      let hi: Bound = null;
      if (this.peekOp('[')) [lo, hi] = this.boundSpec();
      this.expectId('of');
      const a: Partial<AggregateType> = { agg, lo, hi };
      if (agg === 'ARRAY' && this.acceptId('optional')) a.optional = true;
      if (this.acceptId('unique')) a.unique = true;
      a.of = this.typeRef();
      // Keep a fixed key order for readable output.
      const out: AggregateType = { agg, lo, hi, of: a.of };
      if (a.unique) out.unique = true;
      if (a.optional) out.optional = true;
      return out;
    }
    if (t.v === 'generic' || t.v === 'generic_entity' || t.v === 'aggregate') {
      throw this.error(t, `generalized type '${t.v}' is only legal in algorithms`);
    }
    return t.v.toUpperCase();
  }

  /** `[lo : hi]`. Bounds are integers, null for `?`, or the expression text. */
  private boundSpec(): [Bound, Bound] {
    this.expectOp('[');
    const lo = this.boundExpr(':');
    this.expectOp(':');
    const hi = this.boundExpr(']');
    this.expectOp(']');
    return [lo, hi];
  }

  private boundExpr(end: string): Bound {
    const start = this.pos;
    let depth = 0;
    while (true) {
      const t = this.peek();
      if (t.k === 'eof') throw this.error(t, 'unterminated bound');
      if (depth === 0 && t.k === 'op' && t.v === end) break;
      if (t.k === 'op' && (t.v === '(' || t.v === '[')) depth++;
      if (t.k === 'op' && (t.v === ')' || t.v === ']')) depth--;
      this.next();
    }
    const toks = this.toks.slice(start, this.pos);
    if (toks.length === 1 && toks[0]!.k === 'num' && /^\d+$/.test(toks[0]!.v)) return Number(toks[0]!.v);
    if (toks.length === 1 && toks[0]!.v === '?') return null;
    return joinTokens(toks);
  }

  // --- skipping ---

  /** Skip an expression up to (not including) a `;` at nesting depth 0. */
  private skipExpression(): void {
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (t.k === 'eof') throw this.error(t, 'unterminated expression');
      if (t.k === 'op') {
        if (t.v === '(' || t.v === '[') depth++;
        else if (t.v === ')' || t.v === ']') depth--;
        else if (t.v === ';' && depth === 0) return;
      }
      this.next();
    }
  }

  private skipPast(op: string): void {
    for (;;) {
      const t = this.next();
      if (t.k === 'eof') throw this.error(t, `expected '${op}'`);
      if (t.k === 'op' && t.v === op) return;
    }
  }

  /** Skip to the matching end keyword and its `;`. */
  private skipBlock(open: string, close: string): void {
    let depth = 1;
    for (;;) {
      const t = this.next();
      if (t.k === 'eof') throw this.error(t, `missing ${close.toUpperCase()}`);
      if (t.k !== 'id') continue;
      if (t.v === open) depth++;
      else if (t.v === close && --depth === 0) break;
    }
    this.expectOp(';');
  }

  /** Functions and procedures can nest each other. */
  private skipAlgorithm(): void {
    let depth = 1;
    for (;;) {
      const t = this.next();
      if (t.k === 'eof') throw this.error(t, 'missing END_FUNCTION or END_PROCEDURE');
      if (t.k !== 'id') continue;
      if (t.v === 'function' || t.v === 'procedure') depth++;
      else if ((t.v === 'end_function' || t.v === 'end_procedure') && --depth === 0) break;
    }
    this.expectOp(';');
  }

  // --- token helpers ---

  private peek(): Token {
    return this.toks[this.pos]!;
  }

  private peekId(): string {
    const t = this.peek();
    return t.k === 'id' ? t.v : '';
  }

  private peekOp(op: string): boolean {
    const t = this.peek();
    return t.k === 'op' && t.v === op;
  }

  private next(): Token {
    const t = this.toks[this.pos]!;
    if (t.k !== 'eof') this.pos++;
    return t;
  }

  private acceptId(v: string): boolean {
    if (this.peekId() !== v) return false;
    this.pos++;
    return true;
  }

  private acceptOp(v: string): boolean {
    if (!this.peekOp(v)) return false;
    this.pos++;
    return true;
  }

  private expectId(v: string): void {
    const t = this.next();
    if (t.k !== 'id' || t.v !== v) throw this.error(t, `expected '${v.toUpperCase()}'`);
  }

  private expectOp(v: string): void {
    const t = this.next();
    if (t.k !== 'op' || t.v !== v) throw this.error(t, `expected '${v}'`);
  }

  private ident(): string {
    const t = this.next();
    if (t.k !== 'id') throw this.error(t, 'expected an identifier');
    return t.v;
  }

  private identList(): string[] {
    this.expectOp('(');
    const out = [this.ident()];
    while (this.acceptOp(',')) out.push(this.ident());
    this.expectOp(')');
    return out;
  }

  private define<T>(table: Record<string, T>, name: string, def: T, at: Token): void {
    if (Object.hasOwn(table, name)) throw this.error(at, `duplicate declaration of ${name}`);
    table[name] = def;
  }

  private error(t: Token, msg: string): Error {
    return new Error(`EXPRESS line ${t.line}: ${msg} (got ${t.k === 'eof' ? 'end of input' : `'${t.v}'`})`);
  }
}

function joinTokens(toks: Token[]): string {
  return toks.map((t) => (t.k === 'str' ? `'${t.v.replaceAll("'", "''")}'` : t.v)).join(' ');
}
