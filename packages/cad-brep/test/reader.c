/* A reader of cad-brep buffers through cad_brep.h, for header.test.ts, compiled as C and as C++: prints, per column,
 * its element count, the sum of its finite values and how many aren't finite; exits 2 if cbr_open refuses the
 * buffer. The columns' element types come from the test (CBR_TYPES, a letter per column: b uint8, i int32, u uint32,
 * f double), since the header says them only in comments. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../include/cad_brep.h"

int main(int argc, char** argv) {
  FILE* f;
  long size;
  uint8_t* buf;
  cbr_view views[CBR_COLUMN_COUNT];
  const char* types = getenv("CBR_TYPES");
  int k;
  if (argc != 2 || !types || strlen(types) != CBR_COLUMN_COUNT || !(f = fopen(argv[1], "rb"))) return 1;
  fseek(f, 0, SEEK_END);
  size = ftell(f);
  fseek(f, 0, SEEK_SET);
  buf = (uint8_t*)malloc(size ? (size_t)size : 1);
  if (fread(buf, 1, (size_t)size, f) != (size_t)size) return 1;
  fclose(f);
  if (cbr_open(buf, (size_t)size, views) != 0) return 2;
  for (k = 0; k < CBR_COLUMN_COUNT; k++) {
    double sum = 0;
    unsigned bad = 0, j;
    for (j = 0; j < views[k].count; j++) {
      double x = types[k] == 'b' ? CBR_U8(views[k])[j] : types[k] == 'i' ? CBR_I32(views[k])[j]
        : types[k] == 'u' ? CBR_U32(views[k])[j] : CBR_F64(views[k])[j];
      if (x - x == 0) sum += x;
      else bad++;
    }
    printf("%d %u %.17g %u\n", k, views[k].count, sum, bad);
  }
  printf("kinds %d %d %d %d\n", CBR_CURVE_OFFSET, CBR_SURFACE_FIXED_REFERENCE_SWEPT, CBR_ITEM_POINT,
    CBR_TRIM_CARTESIAN);
  free(buf);
  return 0;
}
