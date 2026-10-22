// .proto files are imported as text (Bun's text loader) so they get embedded in compiled builds.
declare module "*.proto" {
  const source: string;
  export default source;
}
