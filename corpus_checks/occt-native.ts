// The OCCT backend on its native route, constructed without arguments as a tess-workers pool constructs its backend
// (native_route.ts). It takes both routes' requests: cad-brep built natively, STEP read.
import { OcctTessellator } from '../packages/tess-occt/src/index.ts';

export class OcctNativeTessellator extends OcctTessellator {
  constructor() {
    super({ route: 'native' });
  }
}
