// npm-process-arch names to GOARCH, covering every Windows architecture the
// release ships. build-helper.mjs builds exactly this set and
// build-helper-digests.mjs requires exactly this set in the release artifact.
export const HELPER_ARCHITECTURES = { x64: "amd64", arm64: "arm64" };

export function helperAssetFileName(arch) {
  return `sash-tun-helper-win32-${arch}.exe`;
}
