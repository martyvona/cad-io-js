// Vite's asset imports (`?url`: the bundled file's URL), as the import worker uses for Draco's WebAssembly.

declare module '*?url' {
  const url: string;
  export default url;
}
