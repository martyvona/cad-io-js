// The viewer's version, as vite.config.ts defines it: the repository's (its package.json's), and in a build the
// commit (0.1.0-4f89790).

declare const __CAD_IO_VERSION__: string | undefined;

/** The version, or '' where nothing defines it (under Node, in tests). */
export const VERSION = typeof __CAD_IO_VERSION__ === 'string' ? __CAD_IO_VERSION__ : '';
