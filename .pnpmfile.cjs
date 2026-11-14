/* openapi-typescript prints through the compiler API TypeScript 7 no longer ships, and kysely-codegen parses its
   overrides with it without declaring it, so each gets its own TypeScript 5.9 beside the repository's 7. */
function readPackage(manifest) {
  if (
    manifest.name === "openapi-typescript" ||
    manifest.name === "kysely-codegen"
  ) {
    delete manifest.peerDependencies?.typescript;
    manifest.dependencies = { ...manifest.dependencies, typescript: "5.9.3" };
  }
  return manifest;
}

module.exports = { hooks: { readPackage } };
