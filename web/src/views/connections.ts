import { api } from "../api.js";
import type { AppState } from "../state.js";

let filterQuery = "";

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

export function renderConnections(container: HTMLElement, state: AppState): void {
  const connections = state.connections;
  const filtered = connections.filter((c) => {
    const q = filterQuery.toLowerCase();
    const host = c.metadata.host || c.metadata.destinationIP;
    const proc = c.metadata.processPath || "";
    return host.toLowerCase().includes(q) || proc.toLowerCase().includes(q);
  });

  container.innerHTML = `
    <div class="connections-page">
      <!-- Header Stats -->
      <div class="conn-stats-bar">
        <div class="stat-pill">
          <span class="stat-label">Active Connections</span>
          <span class="stat-value">${connections.length}</span>
        </div>
        <div class="stat-pill">
          <span class="stat-label">Total Download</span>
          <span class="stat-value">${formatSize(state.connectionsDownloadTotal)}</span>
        </div>
        <div class="stat-pill">
          <span class="stat-label">Total Upload</span>
          <span class="stat-value">${formatSize(state.connectionsUploadTotal)}</span>
        </div>
      </div>

      <!-- Controls -->
      <div class="conn-controls-bar">
        <input
          type="text"
          id="conn-search"
          class="input input-sm"
          placeholder="Filter by host, IP, or process..."
          value="${filterQuery}"
        />
        <button id="close-all-btn" class="btn btn-sm btn-danger" ${connections.length === 0 ? "disabled" : ""}>
          ✕ Close All Connections
        </button>
      </div>

      <!-- Connections Table -->
      <div class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th>Host / Target</th>
              <th>Process</th>
              <th>Type</th>
              <th>Rule</th>
              <th>Chains</th>
              <th>Download</th>
              <th>Upload</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${
              filtered.length === 0
                ? `<tr><td colspan="8" class="text-center text-muted">No active connections matching filter</td></tr>`
                : filtered
                    .map((c) => {
                      const host =
                        c.metadata.host ||
                        `${c.metadata.destinationIP}:${c.metadata.destinationPort}`;
                      const proc = c.metadata.processPath
                        ? c.metadata.processPath.split(/[\\/]/).pop()
                        : "-";
                      const chainStr = c.chains.join(" → ");

                      return `
                  <tr>
                    <td class="cell-host" title="${host}">${host}</td>
                    <td class="cell-proc" title="${c.metadata.processPath || ""}">${proc}</td>
                    <td><span class="badge badge-neutral">${c.metadata.network}</span></td>
                    <td><span class="badge badge-neutral">${c.rule}</span></td>
                    <td class="cell-chains" title="${chainStr}">${chainStr}</td>
                    <td class="cell-size">${formatSize(c.download)}</td>
                    <td class="cell-size">${formatSize(c.upload)}</td>
                    <td>
                      <button class="btn btn-xs btn-danger-outline close-conn-btn" data-id="${c.id}">
                        ✕
                      </button>
                    </td>
                  </tr>
                `;
                    })
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Search input
  const searchInput = container.querySelector("#conn-search") as HTMLInputElement;
  searchInput?.addEventListener("input", (e) => {
    filterQuery = (e.target as HTMLInputElement).value;
    renderConnections(container, state);
    const newSearch = container.querySelector("#conn-search") as HTMLInputElement;
    newSearch?.focus();
    newSearch?.setSelectionRange(filterQuery.length, filterQuery.length);
  });

  // Close single connection
  container.querySelectorAll(".close-conn-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = (btn as HTMLElement).dataset.id;
      if (!id) return;
      try {
        await api.closeConnection(id);
      } catch (err) {
        alert(`Failed to close connection: ${(err as Error).message}`);
      }
    });
  });

  // Close all connections
  container.querySelector("#close-all-btn")?.addEventListener("click", async () => {
    if (!confirm("Close all active connections?")) return;
    try {
      await api.closeAllConnections();
    } catch (err) {
      alert(`Failed to close all connections: ${(err as Error).message}`);
    }
  });
}
