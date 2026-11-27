export type * from './scene.ts';
export type * from './tessellator.ts';
export { failedPart, TessellationError } from './errors.ts';
export { sha256, sha256Js } from './sha256.ts';
export { identity, multiply, scaling, Y_UP_METRES, yUpFrame, LENGTH_UNITS, type LengthUnitName, instances,
  partInstances, validate, type ComponentInstance,
  type PartInstance } from './walk.ts';
export { badFaces, compareVerdicts, FallbackTessellator, judgeResult, pastLimits, type Verdict } from './fallback.ts';
export { type DeviationJudge, deviationJudge, setDeviationJudge } from './deviation.ts';
export { areaOracle, type AreaOracle, type FaceArea, modelFaceArea, OFF_SURFACE, ORACLE_DENSITY, ORACLE_DISAGREE,
  ORACLE_RELATIVE, ORACLE_REPLACE, oracleAreas, oracleMeasures, setAreaOracle, TS_AREA_ORACLE, type OracleArea, type OracleFlag,
  type OracleOptions, type OracleResult, type OracleSurface, type OracleUnsupported, trustedArea }
  from './area-oracle.ts';
export { edgeUsers, openEdges, openEdgesCount, openEdgesDiagnostic, openEdgesMessage } from './open-edges.ts';
export { notManifoldCount, notManifoldDiagnostic, notManifoldMessage, reported, shellDefects, shellsManifold,
  type ShellDefects } from './manifold.ts';
export { composeResults } from './compose.ts';
export { failedMessage, FILL_WIDTH, filledMessage, fillFaces, fillResult, type Filled } from './fill.ts';
export { AREA, CHECK, RECORDS_VERSION, composeRecords, DEFAULT_MIN_ANGLE, EXPECTED, faceRecords, ORIENTATION, type RecordInputs,
  recordOriented, recordsFromJson, recordSewn, recordsJson, shareExpected } from './records.ts';
export { type ClassifyContext, classify, classifyAll, CRITERIA, type Criterion, type CriterionClass, describeTarget,
  type FaceClass, type FaceClasses, H_FLOOR, H_MULTIPLE, type Level, type Target, TARGET_NAMES, type TargetName,
  TARGETS } from './targets.ts';
export { JOIN_CORNER, JOIN_SNAP, joinedMessage, joinEdges, joinResult, type Joined } from './join.ts';
export { againstHealedMessage, orientResult, shellsOriented, type Turned, turnedMessage, wrongShells }
  from './orient.ts';
export { tessellateScene, toMesh, type TessellateOptions, type TessellateResult } from './tessellate.ts';
export { DEFAULT_MESH_PROFILE, MESH_PROFILE_NAMES, MESH_PROFILES, meshDeflections, meshProfileOf, type Deflections,
  type MeshProfile } from './profiles.ts';
export { BOUNDARY_SLACK, dropDegenerate, EXCESS_FRACTION, faceFailures, INSIDE_OUT, manifoldProblems,
  MAX_PLAUSIBLE_AREA, MISSING_FRACTION, orientShells, scaleMesh, scalePart, weld, type FaceFailure } from './mesh.ts';
export { exportView, placedName, pruneView, type ExportNode, type ExportPart, type ExportView,
  type ExportViewOptions, type Look } from './export.ts';
export { addLod, chooseLod, dropSourceDegenerate, type LodWanted } from './lod.ts';
export { closeTransforms, isOurTree, MM_Z_UP, propertiesFrom, sceneFromTree, type TreeExtras, type TreeMaterial,
  type TreeMesh, type TreeNode } from './tree-import.ts';
export { viewDifferences, type CompareOptions } from './compare.ts';
export { boundsFrom, boundsJson, sceneJson, levelFrom, levelJson, measuresFrom, measuresJson, partExtras, placementFrom,
  placementJson, unitFrom } from './measures.ts';
export { countTransform, describeTransforms, noTransformCounts, TRANSFORM_KINDS, TRANSFORM_TOLERANCE, transformKinds,
  transformUse, describeStretched, stretchWords, type TransformCounts, type TransformKind, type TransformUse } from
  './transforms.ts';
export { rigidPart, rigidPlacements, stretchMesh } from './rigid.ts';
export { dropEmptyAssemblies, dropEmptyComponents } from './empty.ts';
export { assertRigid, isRigid, SceneBuilder } from './scene-builder.ts';
export { AUTHOR_PLACEHOLDERS, authorOf, standardMetadata, type StandardMetadata } from './file-metadata.ts';
export { around, boundScene, boxesSphere, boxMeshes, grow, meshBox, sceneBounds } from './bounds.ts';
export { drain, paced } from './steps.ts';
export { isLeaf, leafParts } from './leaf.ts';
