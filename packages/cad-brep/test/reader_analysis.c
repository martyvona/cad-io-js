/* A reader of cad-brep analysis buffers through cad_analysis.h, for analysis.test.ts, compiled as C and as C++, with
 * cad_brep.h included too (the two headers' names don't clash): prints, per column, its element count, the sum of its
 * finite values and how many aren't finite, then the model hash's words and the enums' values; exits 2 if cba_open
 * refuses the buffer. The columns' element types come from the test (CBA_TYPES, a letter per column: b uint8, i
 * int32, u uint32, f double), since the header says them only in comments. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../include/cad_brep.h"
#include "../include/cad_analysis.h"

int main(int argc, char** argv) {
  FILE* f;
  long size;
  uint8_t* buf;
  cba_view views[CBA_COLUMN_COUNT];
  const char* types = getenv("CBA_TYPES");
  int k;
  if (argc != 2 || !types || strlen(types) != CBA_COLUMN_COUNT || !(f = fopen(argv[1], "rb"))) return 1;
  fseek(f, 0, SEEK_END);
  size = ftell(f);
  fseek(f, 0, SEEK_SET);
  buf = (uint8_t*)malloc(size ? (size_t)size : 1);
  if (fread(buf, 1, (size_t)size, f) != (size_t)size) return 1;
  fclose(f);
  if (cba_open(buf, (size_t)size, views) != 0) return 2;
  for (k = 0; k < CBA_COLUMN_COUNT; k++) {
    double sum = 0;
    unsigned bad = 0, j;
    for (j = 0; j < views[k].count; j++) {
      double x = types[k] == 'b' ? CBA_U8(views[k])[j] : types[k] == 'i' ? CBA_I32(views[k])[j]
        : types[k] == 'u' ? CBA_U32(views[k])[j] : CBA_F64(views[k])[j];
      if (x - x == 0) sum += x;
      else bad++;
    }
    printf("%d %u %.17g %u\n", k, views[k].count, sum, bad);
  }
  printf("model");
  for (k = 0; k < 8 && (unsigned)k < views[CBA_ANALYSIS_MODEL].count; k++) {
    printf(" %08x", (unsigned)CBA_U32(views[CBA_ANALYSIS_MODEL])[k]);
  }
  printf("\nkinds %d %d %d %d %d %d %d %d\n", CBA_PROVENANCE_HEALED, CBA_TRUST_EXACT, CBA_CONTINUITY_G2,
    CBA_SINGULARITY_NORMAL_VANISHES, CBA_FACING_IN, CBA_FACING_FROM_BOTH, CBA_LOGICAL_UNKNOWN, CBR_COLUMN_COUNT);
  free(buf);
  return 0;
}
