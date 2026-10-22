// lib3mf's Emscripten module (no types of its own): the tests and the corpus check call it untyped.
declare module '@3mfconsortium/lib3mf' {
  const lib3mf: (options?: object) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  export default lib3mf;
}
