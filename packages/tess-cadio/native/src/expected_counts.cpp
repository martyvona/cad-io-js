// expected_counts.h: PartMesher stopped at each face's first meshing's point cap count.
#include "tess_cadio/expected_counts.h"

namespace tesscadio {

std::vector<std::pair<uint32_t, double>> expectedCounts(const cadgeom::Model& m, PartOptions options) {
  options.expectedOnly = true;
  const PartMesher pm(m, options);
  const uint32_t* id = m.u32(CBR_FACE_ID);
  std::vector<std::pair<uint32_t, double>> out;
  for (int f = 0; f < m.faces(); f++) out.push_back({id[f], pm.face(f).capExpected});
  return out;
}

} // namespace tesscadio
