// The JSON schema dictionary format produced by the generator (gen/) and read by the parser's schema binding.
// Entity and type names are uppercase, as in Part 21 files. Attribute names are lowercase, as in the EXPRESS source.

/** EXPRESS simple types. Any other string in a TypeRef names a defined type, select, enumeration or entity. */
export const SIMPLE_TYPES = ['INTEGER', 'REAL', 'NUMBER', 'LOGICAL', 'BOOLEAN', 'STRING', 'BINARY'] as const;
export type SimpleType = (typeof SIMPLE_TYPES)[number];

/** An aggregate bound: a literal integer, null for `?`, or the EXPRESS expression text when it isn't a literal. */
export type Bound = number | string | null;

export interface AggregateType {
  agg: 'ARRAY' | 'LIST' | 'SET' | 'BAG';
  lo: Bound;
  hi: Bound;
  of: TypeRef;
  unique?: true;
  /** ARRAY OF OPTIONAL: elements may be `$`. */
  optional?: true;
}

export type TypeRef = string | AggregateType;

export interface Attribute {
  name: string;
  type: TypeRef;
  optional?: true;
}

/** An inherited explicit attribute redeclared in a subtype, either with a narrower type or as derived. */
export interface Redeclaration {
  /** The entity that declares the attribute. */
  from: string;
  name: string;
  type: TypeRef;
  renamed?: string;
  /** Explicit redeclarations only: whether the attribute stays OPTIONAL. A redeclaration can make it mandatory. */
  optional?: true;
}

export interface InverseAttribute {
  name: string;
  /** Absent for a single-valued inverse. */
  agg?: 'SET' | 'BAG';
  lo?: Bound;
  hi?: Bound;
  entity: string;
  attr: string;
}

/** A SUPERTYPE OF constraint expression. */
export type SupertypeExpr = string | { op: 'ONEOF' | 'AND' | 'ANDOR'; args: SupertypeExpr[] };

export interface EntityDef {
  abstract?: true;
  /** SUBTYPE OF, in declaration order. Determines the order of inherited attributes. */
  supertypes: string[];
  supertypeOf?: SupertypeExpr;
  /** Own explicit attributes, in declaration order. Excludes redeclarations of inherited attributes. */
  attrs: Attribute[];
  /** Inherited explicit attributes redeclared with a narrower type. They stay explicit in Part 21. */
  redeclared?: Redeclaration[];
  /** Inherited explicit attributes redeclared as DERIVE. Part 21 writes them as `*` in instances of this entity. */
  derivedRedeclared?: Redeclaration[];
  /** Names of the entity's own derived attributes. */
  derived?: string[];
  inverse?: InverseAttribute[];
}

export type TypeDef =
  | { kind: 'defined'; type: TypeRef }
  | { kind: 'select'; items: string[]; extensible?: true; genericEntity?: true; basedOn?: string }
  | { kind: 'enum'; values: string[]; extensible?: true; basedOn?: string };

export interface SchemaDictionary {
  /** Dictionary format version. */
  format: 1;
  /** The EXPRESS schema name, uppercase. */
  schema: string;
  source: { file: string; sha256: string; title?: string };
  entities: Record<string, EntityDef>;
  types: Record<string, TypeDef>;
}
