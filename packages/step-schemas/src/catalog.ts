// The dictionaries this package ships, and the mapping from Part 21 FILE_SCHEMA names to them.

export interface DictionaryInfo {
  id: string;
  /** EXPRESS schema name, uppercase. */
  schema: string;
  /** Source file, relative to stepcode/data. */
  source: string;
  title: string;
}

export const DICTIONARIES: readonly DictionaryInfo[] = [
  {
    id: 'ap203',
    schema: 'CONFIG_CONTROL_DESIGN',
    source: 'ap203/ap203.exp',
    title: 'AP203 edition 1 with amendment 1 (AIM long form, WG3 N916)',
  },
  {
    id: 'ap203e2',
    schema: 'AP203_CONFIGURATION_CONTROLLED_3D_DESIGN_OF_MECHANICAL_PARTS_AND_ASSEMBLIES_MIM_LF',
    source: 'ap203e2/ap203e2_mim_lf.exp',
    title: 'AP203 edition 2 (MIM long form, WG3 N2635)',
  },
  {
    id: 'ap214e3',
    schema: 'AUTOMOTIVE_DESIGN',
    source: 'ap214e3/AP214E3_2010.exp',
    title: 'AP214 edition 3 (AIM long form, ISO/DIS 10303-214:2007)',
  },
  {
    id: 'ap242',
    schema: 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF',
    source: 'ap242/242_mim_lf.exp',
    title: 'AP242 (MIM long form, WG12 N11521)',
  },
];

/**
 * Map one FILE_SCHEMA entry, such as `'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'`, to a dictionary id.
 * Returns undefined for schemas without a dictionary. Later editions of an AP map to the one dictionary we ship.
 */
export function dictionaryForSchemaName(fileSchema: string): string | undefined {
  // Drop the object identifier and normalize case.
  const name = fileSchema.replace(/\{.*$/s, '').trim().toUpperCase();
  if (name === 'CONFIG_CONTROL_DESIGN') return 'ap203';
  if (name.startsWith(
    'AP203_CONFIGURATION_CONTROLLED_3D_DESIGN') || name === 'CONFIGURATION_CONTROL_3D_DESIGN_ED2_MIM_LF') {
    return 'ap203e2';
  }
  // AUTOMOTIVE_DESIGN and its conformance-class variants (AUTOMOTIVE_DESIGN_CC2, ...).
  if (name === 'AUTOMOTIVE_DESIGN' || /^AUTOMOTIVE_DESIGN_CC\d+$/.test(name)) return 'ap214e3';
  if (name.startsWith('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING')) return 'ap242';
  return undefined;
}

/** Pick a dictionary for a file's FILE_SCHEMA list: the first entry that has one. */
export function dictionaryForFileSchema(fileSchemas: readonly string[]): string | undefined {
  for (const s of fileSchemas) {
    const id = dictionaryForSchemaName(s);
    if (id) return id;
  }
  return undefined;
}
