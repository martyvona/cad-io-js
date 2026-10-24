// The dev server's options, passed from `cad-viewer start` to the Vite config through the environment, so that
// `npx vite` in this package works too. See README.md, "The viewer".

import path from 'node:path';

export interface ServerOptions {
  /** The port, on localhost or the LAN. Default 5180. */
  port: number;
  /** Listen on every interface (phones and tablets on the LAN), not only localhost. */
  lan: boolean;
  /** Plain http (the default), a self-signed certificate, or mkcert's (`<certDir>/cert.pem`, `key.pem`). */
  https: 'none' | 'self' | 'mkcert';
  /** The directory served at /content/. Default the repository's test_corpus/. */
  contentRoot: string;
  /** Where mkcert's certificate and key are. Default packages/viewer/.cert/. */
  certDir: string;
}

const viewer = path.resolve(import.meta.dirname, '..');
export const DEFAULTS: ServerOptions = { port: 5180, lan: false, https: 'none',
  contentRoot: path.resolve(viewer, '../../test_corpus'), certDir: path.join(viewer, '.cert') };

const HTTPS = ['none', 'self', 'mkcert'] as const;

/** The options from VIEWER_PORT, VIEWER_LAN (1), VIEWER_HTTPS, VIEWER_CONTENT_ROOT, VIEWER_CERT_DIR. */
export function optionsFromEnv(env: Record<string, string | undefined>): ServerOptions {
  const port = env.VIEWER_PORT ? Number(env.VIEWER_PORT) : DEFAULTS.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad VIEWER_PORT: ${env.VIEWER_PORT}`);
  const https = (env.VIEWER_HTTPS || 'none') as ServerOptions['https'];
  if (!HTTPS.includes(https)) throw new Error(`VIEWER_HTTPS must be one of ${HTTPS.join(', ')}: ${env.VIEWER_HTTPS}`);
  return { port, lan: env.VIEWER_LAN === '1', https,
    contentRoot: path.resolve(env.VIEWER_CONTENT_ROOT || DEFAULTS.contentRoot),
    certDir: path.resolve(env.VIEWER_CERT_DIR || DEFAULTS.certDir) };
}

export function envFromOptions(o: ServerOptions): Record<string, string> {
  return { VIEWER_PORT: String(o.port), VIEWER_LAN: o.lan ? '1' : '0', VIEWER_HTTPS: o.https,
    VIEWER_CONTENT_ROOT: o.contentRoot, VIEWER_CERT_DIR: o.certDir };
}
