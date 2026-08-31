import { api } from "../api.js";
import { type AppState, store } from "../state.js";

export function renderSettings(container: HTMLElement, state: AppState): void {
  const settings = state.status?.settings;

  container.innerHTML = `
    <div class="settings-page">
      <!-- Network & Ports -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Network & Inbound</span>
        </div>
        <div class="settings-list">
          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">Mixed Proxy Port</span>
              <span class="setting-desc">Local port for HTTP & SOCKS5 proxy inbounds (default: 7890)</span>
            </div>
            <div class="setting-control">
              <input type="number" id="setting-mixed-port" class="input input-sm" value="${settings?.mixedPort ?? 7890}" min="1" max="65535" />
              <button class="btn btn-sm btn-secondary save-setting-btn" data-key="mixed-port" data-input="#setting-mixed-port">Save</button>
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">Allow LAN Connections</span>
              <span class="setting-desc">Accept proxy traffic from other devices on the local area network</span>
            </div>
            <div class="setting-control">
              <button class="btn btn-sm ${settings?.allowLan ? "btn-primary" : "btn-secondary"} toggle-setting-btn" data-key="allow-lan" data-value="${settings?.allowLan ? "off" : "on"}">
                ${settings?.allowLan ? "Enabled" : "Disabled"}
              </button>
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">TUN Mode (Virtual Network Adapter)</span>
              <span class="setting-desc">Route all device network traffic transparently (requires Administrator/root)</span>
            </div>
            <div class="setting-control">
              <button class="btn btn-sm ${settings?.tun ? "btn-primary" : "btn-secondary"} toggle-setting-btn" data-key="tun" data-value="${settings?.tun ? "off" : "on"}">
                ${settings?.tun ? "Enabled" : "Disabled"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Core & Supervisor Control -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Core Management</span>
        </div>
        <div class="settings-list">
          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">Core Restart</span>
              <span class="setting-desc">Reboot the child core process and re-apply settings</span>
            </div>
            <div class="setting-control">
              <button id="restart-core-btn" class="btn btn-sm btn-secondary">🔄 Restart Core</button>
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">Daemon API Port</span>
              <span class="setting-desc">Sash supervisor control API port (19090)</span>
            </div>
            <div class="setting-control">
              <span class="badge badge-neutral">127.0.0.1:${settings?.daemonPort ?? 19090}</span>
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">Dashboard Secret</span>
              <span class="setting-desc">Authentication token for the Sash API</span>
            </div>
            <div class="setting-control">
              <button id="reset-token-btn" class="btn btn-sm btn-danger-outline">Log Out</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Save text inputs
  container.querySelectorAll(".save-setting-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = (btn as HTMLElement).dataset.key;
      const inputSelector = (btn as HTMLElement).dataset.input;
      if (!key || !inputSelector) return;
      const input = container.querySelector(inputSelector) as HTMLInputElement;
      const val = input.value.trim();

      try {
        await api.patchSetting(key, val);
        alert(`Setting '${key}' updated.`);
        const newStatus = await api.getStatus();
        store.setStatus(newStatus);
      } catch (err) {
        alert(`Failed to save setting: ${(err as Error).message}`);
      }
    });
  });

  // Toggle on/off buttons
  container.querySelectorAll(".toggle-setting-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = (btn as HTMLElement).dataset.key;
      const value = (btn as HTMLElement).dataset.value;
      if (!key || !value) return;

      try {
        await api.patchSetting(key, value);
        const newStatus = await api.getStatus();
        store.setStatus(newStatus);
      } catch (err) {
        alert(`Failed to update setting: ${(err as Error).message}`);
      }
    });
  });

  // Restart Core
  container.querySelector("#restart-core-btn")?.addEventListener("click", async () => {
    try {
      await api.restartCore();
      alert("Core restarted successfully.");
      const newStatus = await api.getStatus();
      store.setStatus(newStatus);
    } catch (err) {
      alert(`Failed to restart core: ${(err as Error).message}`);
    }
  });

  // Log Out
  container.querySelector("#reset-token-btn")?.addEventListener("click", () => {
    localStorage.removeItem("sash_daemon_secret");
    location.reload();
  });
}
