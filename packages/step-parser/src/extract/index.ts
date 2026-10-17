// Layer 3: semantic extraction. extractSemantics runs every extractor over a bound model; the pieces are exported
// for callers that want only some of them.

import type { StepModel } from '../bind.ts';
import type { Diagnostic } from '../model.ts';
import { extractProducts, type ProductStructure } from './products.ts';
import { extractValidationProperties, type ValidationProperty } from './properties.ts';
import { Reader } from './reader.ts';
import { extractStyles, type Styles } from './styles.ts';
import { Units } from './units.ts';

export interface Semantics {
  structure: ProductStructure;
  styles: Styles;
  validation: ValidationProperty[];
  /** Problems the extractors met, by severity and instance id. */
  diagnostics: Diagnostic[];
}

export function extractSemantics(model: StepModel): Semantics {
  const r = new Reader(model);
  const units = new Units(r);
  const structure = extractProducts(r, units);
  const styles = extractStyles(r);
  const validation = extractValidationProperties(r, units);
  return { structure, styles, validation, diagnostics: r.diagnostics };
}

export { Reader } from './reader.ts';
export { Units, type Unit, type UnitKind, type RepresentationContext } from './units.ts';
export * as math from './math.ts';
export type { Mat4, Vec3 } from './math.ts';
export { placement, operator, transformation, mappedItem, point, direction } from './placement.ts';
export {
  extractProducts, productInstances, productRepresentations, type ProductStructure, type Product, type ProductDocument,
  type Occurrence, type ShapeRepresentation, type RelatedRepresentation, type ProductInstance,
} from './products.ts';
export { extractStyles, effectiveStyle, colour, type Styles, type Style, type StyledItem, type Layer, type Rgb } from './styles.ts';
export { extractValidationProperties, type ValidationProperty, type ValidationValue, type PropertyTarget } from './properties.ts';
export { semanticJson, SEMANTIC_JSON_FORMAT, SEMANTIC_JSON_VERSION, type SemanticJsonOptions } from './json.ts';
