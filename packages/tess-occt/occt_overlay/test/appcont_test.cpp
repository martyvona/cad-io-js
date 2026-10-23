// Exercises AppCont_LeastSquare (the only caller of AppCont_ContMatrices::VBernstein) through
// Approx_FitAndDivide on analytic 3D + 2D curves. Prints every pole and the sampled deviation from the
// true curve, so builds with and without the VBernstein overlay can be diffed.
// build/run: ./run.sh <occt build dir> <out name>
#include <AppCont_Function.hxx>
#include <Approx_FitAndDivide.hxx>
#include <AppParCurves_MultiCurve.hxx>
#include <Standard_Failure.hxx>
#include <cmath>
#include <cstdio>

struct Fn : AppCont_Function
{
  double myA;
  Fn(double a) : myA(a) { myNbPnt = 1; myNbPnt2d = 1; }
  double FirstParameter() const override { return 0.0; }
  double LastParameter() const override { return 2.0; }
  gp_Pnt P(double u) const { return gp_Pnt(std::cos(myA * u), std::sin(2 * u), u * u + std::exp(-myA * u)); }
  gp_Pnt2d Q(double u) const { return gp_Pnt2d(std::sin(myA * u) * u, u * u * u); }
  bool Value(const double u, NCollection_Array1<gp_Pnt2d>& p2, NCollection_Array1<gp_Pnt>& p3) const override
  {
    p3(p3.Lower()) = P(u); p2(p2.Lower()) = Q(u); return true;
  }
  bool D1(const double u, NCollection_Array1<gp_Vec2d>& v2, NCollection_Array1<gp_Vec>& v3) const override
  {
    v3(v3.Lower()) = gp_Vec(-myA * std::sin(myA * u), 2 * std::cos(2 * u), 2 * u - myA * std::exp(-myA * u));
    v2(v2.Lower()) = gp_Vec2d(myA * std::cos(myA * u) * u + std::sin(myA * u), 3 * u * u);
    return true;
  }
};

int main()
{
  struct Case { double a; int dmin, dmax; double tol; bool cut; };
  const Case cases[] = {{1.0, 3, 8, 1e-5, false}, {3.0, 3, 8, 1e-5, true}, {3.0, 3, 14, 1e-9, true},
                        {5.0, 10, 20, 1e-12, true}, {7.0, 3, 23, 1e-14, false}, {7.0, 18, 23, 1e-10, true},
                        {2.0, 3, 14, 1e-7, true}, {9.0, 3, 12, 1e-6, true}};
  int aCase = 0;
  for (const Case& c : cases)
  {
    ++aCase;
    try {
    Fn f(c.a);
    Approx_FitAndDivide fit(f, c.dmin, c.dmax, c.tol, c.tol, c.cut);
    double maxDev = 0;
    for (int s = 1; s <= fit.NbMultiCurves(); ++s)
    {
      AppParCurves_MultiCurve mc = fit.Value(s);
      double u0, u1, e3, e2;
      fit.Parameters(s, u0, u1);
      fit.Error(s, e3, e2);
      std::printf("case %d seg %d deg %d u %.17g %.17g err %.3e %.3e\n", aCase, s, mc.Degree(), u0, u1, e3, e2);
      for (int i = 1; i <= mc.NbPoles(); ++i)
      {
        const gp_Pnt   p = mc.Pole(1, i);
        const gp_Pnt2d q = mc.Pole2d(2, i);
        std::printf("pole %d %d %d %.17g %.17g %.17g %.17g %.17g\n", aCase, s, i, p.X(), p.Y(), p.Z(), q.X(), q.Y());
      }
      for (int k = 0; k <= 200; ++k)
      {
        const double t = k / 200.0, u = u0 + t * (u1 - u0);
        gp_Pnt p; gp_Pnt2d q;
        mc.Value(1, t, p); mc.Value(2, t, q);
        maxDev = std::fmax(maxDev, std::fmax(p.Distance(f.P(u)), q.Distance(f.Q(u))));
      }
    }
    std::printf("summary case %d segments %d allApprox %d tolReached %d maxDev %.3e\n", aCase, fit.NbMultiCurves(),
                (int)fit.IsAllApproximated(), (int)fit.IsToleranceReached(), maxDev);
    } catch (const Standard_Failure& e) {
      std::printf("summary case %d exception %s\n", aCase, e.what());
    } catch (...) {
      std::printf("summary case %d exception (unknown)\n", aCase);
    }
  }
}
