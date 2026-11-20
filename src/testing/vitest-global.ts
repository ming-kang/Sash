import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function globalSetup(): () => void {
  return () => {
    const isolation = process.env.SASH_TEST_ISOLATION;
    if (!isolation || !fs.existsSync(isolation)) return;
    const tempRoot = fs.realpathSync(os.tmpdir());
    const resolved = fs.realpathSync(isolation);
    if (path.dirname(resolved).toLowerCase() !== tempRoot.toLowerCase()) {
      throw new Error("Test isolation directory escaped its temporary parent");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  };
}
