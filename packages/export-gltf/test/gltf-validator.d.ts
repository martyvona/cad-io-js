// The parts of gltf-validator (no types of its own) that the tests use.
declare module 'gltf-validator' {
  interface Message { code: string; message: string; severity: number; pointer?: string }
  interface Report { issues: { numErrors: number; numWarnings: number; numInfos: number; numHints: number;
    messages: Message[] } }
  interface Options { maxIssues?: number; ignoredIssues?: string[];
    externalResourceFunction?: (uri: string) => Promise<Uint8Array> }
  const validator: { validateBytes(data: Uint8Array, options?: Options): Promise<Report> };
  export default validator;
}
