#include <cmath>
#include <cstdio>
#include "../../../third_party/OCCT/src/ModelingData/TKGeomBase/AppCont/AppCont_ContMatrices_VB.pxx"
constexpr int THE_MAX_NBPOINTS = 24;
struct Mat { double v[27][25]; double& operator()(int i, int j) { return v[i][j]; } };
static void VB(int classe, int nbpoints, Mat& M) {
  double aNodes[THE_MAX_NBPOINTS];
  for (int k = 1; k <= nbpoints; ++k)
  {
    double z = std::cos(M_PI * (k - 0.25) / (nbpoints + 0.5));
    for (int anIter = 0; anIter < 100; ++anIter)
    {
      double p0 = 1.0, p1 = z;
      for (int n = 2; n <= nbpoints; ++n)
      {
        const double p2 = ((2 * n - 1) * z * p1 - (n - 1) * p0) / n;
        p0              = p1;
        p1              = p2;
      }
      const double dp = nbpoints * (z * p1 - p0) / (z * z - 1.0);
      const double dz = p1 / dp;
      z -= dz;
      if (std::abs(dz) < 1.0e-16)
        break;
    }
    aNodes[k - 1] = (1.0 - z) / 2.0; // z decreases with k, so nodes ascend
  }
  const int aDeg = classe - 1;
  for (int i = 1; i <= classe; ++i)
  {
    const int k      = i - 1;
    double    aBinom = 1.0;
    for (int m = 1; m <= k; ++m)
      aBinom = aBinom * (aDeg - k + m) / m;
    for (int j = 1; j <= nbpoints; ++j)
    {
      const double t = aNodes[j - 1];
      M(i, j) = aBinom * std::pow(t, k) * std::pow(1.0 - t, aDeg - k);
    }
  }
}
int main() {
  double maxErr = 0; long n = 0;
  for (int classe = 2; classe <= 26; ++classe)
    for (int nb = 2; nb <= 24; ++nb) {
      Mat M; VB(classe, nb, M);
      const int Som = static_cast<int>(300.0 * ((classe - 1) * classe / 2.0 - 1.0) + classe * (nb - 1) * nb / 2.0);
      const double* d = AppCont_ContMatrices::THE_VBMATRIX_DATA + Som;
      for (int i = 1; i <= classe; ++i) for (int j = 1; j <= nb; ++j, ++d, ++n) maxErr = std::fmax(maxErr, std::fabs(M(i, j) - *d));
    }
  std::printf("checked %ld, max abs err %.2e\n", n, maxErr);
}
