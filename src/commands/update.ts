import { log } from "../log.js";
import { ensureManagement } from "../runtime-owner.js";
import { runtimeContext } from "./shared.js";

export async function runUpdate(opts: { version?: string } = {}): Promise<void> {
  const owner = await ensureManagement(runtimeContext());
  log.info("downloading and verifying Core; the dashboard remains available");
  const result = await owner.client.updateCore(opts.version);
  log.ok(`core updated to ${result.version}`);
}
