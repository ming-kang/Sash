// This import must stay first: it validates the runtime before any modern
// syntax or Node 20+ API is touched by other modules.
const REQUIRED_NODE_MAJOR = 20;

const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (Number.isNaN(major) || major < REQUIRED_NODE_MAJOR) {
  console.error(
    `Sash requires Node.js ${REQUIRED_NODE_MAJOR} or newer (found ${process.versions.node}).`,
  );
  console.error("Please upgrade Node.js: https://nodejs.org/");
  process.exit(1);
}
