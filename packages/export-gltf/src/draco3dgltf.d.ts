// draco3dgltf has no types of its own: its two Emscripten module factories, as export-gltf and its tests use them.
declare module 'draco3dgltf' {
  const draco3d: {
    createEncoderModule(options?: object): Promise<unknown>;
    createDecoderModule(options?: object): Promise<unknown>;
  };
  export default draco3d;
}
