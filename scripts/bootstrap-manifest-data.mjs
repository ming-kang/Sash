export const GEODATA_FILES = [
  "geoip.dat",
  "geoip.metadb",
  "geosite.dat",
  "country.mmdb",
  "GeoLite2-ASN.mmdb",
];

export function coreCandidates(tag) {
  const names = [];
  for (const os of ["windows", "linux", "darwin"]) {
    const ext = os === "windows" ? "zip" : "gz";
    for (const variant of ["v3", "", "v2", "v1", "compatible"]) {
      names.push(`mihomo-${os}-amd64-${variant ? `${variant}-` : ""}${tag}.${ext}`);
    }
    names.push(`mihomo-${os}-arm64-${tag}.${ext}`);
  }
  return names;
}
