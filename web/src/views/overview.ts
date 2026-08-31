import { api } from "../api.js";
import { type AppState, store } from "../state.js";
import type { OutboundMode } from "../types.js";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B/s";
  const k = 1024;
  const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

function renderSparkline(data: number[], color: string): string {
  const max = Math.max(...data, 1024);
  const width = 280;
  const height = 48;
  const step = width / (data.length - 1);
  const points = data
    .map((val, idx) => {
      const x = idx * step;
      const y = height - (val / max) * (height - 6) - 3;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return `
    <svg viewBox="0 0 ${width} ${height}" class="sparkline">
      <polyline fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${points}" />
    </svg>
  `;
}

export function renderOverview(container: HTMLElement, state: AppState): void {
  const status = state.status;
  const isSysProxyOn = status?.systemProxy.applied ?? false;
  const isCoreRunning = status?.core.running ?? false;

  container.innerHTML = `
    <div class="overview-grid">
      <!-- Traffic Cards -->
      <div class="card traffic-card">
        <div class="card-header">
          <span class="card-title">Download Traffic</span>
          <span class="badge badge-down">↓ ${formatBytes(state.traffic.down)}</span>
        </div>
        <div class="sparkline-wrap">
          ${renderSparkline(state.traffic.historyDown, "#10b981")}
        </div>
      </div>

      <div class="card traffic-card">
        <div class="card-header">
          <span class="card-title">Upload Traffic</span>
          <span class="badge badge-up">↑ ${formatBytes(state.traffic.up)}</span>
        </div>
        <div class="sparkline-wrap">
          ${renderSparkline(state.traffic.historyUp, "#6366f1")}
        </div>
      </div>

      <!-- Outbound Mode Selector -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Outbound Mode</span>
          <span class="badge badge-neutral">${state.mode.toUpperCase()}</span>
        </div>
        <div class="mode-buttons">
          <button class="btn mode-btn ${state.mode === "rule" ? "active" : ""}" data-mode="rule">
            <span class="mode-name">Rule</span>
            <span class="mode-desc">Routing via rules</span>
          </button>
          <button class="btn mode-btn ${state.mode === "global" ? "active" : ""}" data-mode="global">
            <span class="mode-name">Global</span>
            <span class="mode-desc">Route all via proxy</span>
          </button>
          <button class="btn mode-btn ${state.mode === "direct" ? "active" : ""}" data-mode="direct">
            <span class="mode-name">Direct</span>
            <span class="mode-desc">Bypass all proxies</span>
          </button>
        </div>
      </div>

      <!-- System Proxy Card -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">System Proxy</span>
          <span class="badge ${isSysProxyOn ? "badge-success" : "badge-neutral"}">${isSysProxyOn ? "Enabled" : "Disabled"}</span>
        </div>
        <p class="card-desc">
          ${
            isSysProxyOn
              ? `OS traffic is routing through 127.0.0.1:${status?.settings.mixedPort ?? 7890}`
              : "OS traffic is bypassing Sash local mixed port"
          }
        </p>
        <button id="toggle-sysproxy-btn" class="btn ${isSysProxyOn ? "btn-danger" : "btn-primary"}" ${!isCoreRunning ? "disabled" : ""}>
          ${isSysProxyOn ? "Disable System Proxy" : "Enable System Proxy"}
        </button>
      </div>

      <!-- Core & Daemon Status -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Core Status</span>
          <span class="badge ${isCoreRunning ? "badge-success" : "badge-danger"}">${isCoreRunning ? "Running" : "Stopped"}</span>
        </div>
        <div class="status-meta">
          <div class="meta-row">
            <span class="meta-label">Core Version</span>
            <span class="meta-val">${status?.core.version || status?.settings.coreVersion || "Unknown"}</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">Mixed Port</span>
            <span class="meta-val">127.0.0.1:${status?.settings.mixedPort ?? 7890}</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">TUN Interface</span>
            <span class="meta-val">${status?.settings.tun ? "Active" : "Off"}</span>
          </div>
        </div>
      </div>

      <!-- Quick Active Proxies Summary -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">Primary Group</span>
          <a href="#proxies" class="card-link" id="goto-proxies-btn">View All Proxies →</a>
        </div>
        <div class="active-node-box">
          ${renderPrimaryGroupSummary(state)}
        </div>
      </div>
    </div>
  `;

  // Bind Mode Buttons
  container.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mode = (btn as HTMLElement).dataset.mode as OutboundMode;
      if (mode) {
        try {
          await api.setMode(mode);
          store.setMode(mode);
        } catch (err) {
          alert(`Failed to set mode: ${(err as Error).message}`);
        }
      }
    });
  });

  // Bind System Proxy Toggle
  const toggleBtn = container.querySelector("#toggle-sysproxy-btn");
  toggleBtn?.addEventListener("click", async () => {
    try {
      if (isSysProxyOn) {
        await api.disableSystemProxy();
      } else {
        await api.enableSystemProxy();
      }
      const newStatus = await api.getStatus();
      store.setStatus(newStatus);
    } catch (err) {
      alert(`Failed to toggle system proxy: ${(err as Error).message}`);
    }
  });

  // Bind Jump Link
  container.querySelector("#goto-proxies-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    store.setTab("proxies");
  });
}

function renderPrimaryGroupSummary(state: AppState): string {
  const primaryGroup =
    state.proxyGroups.find((g) => g.toUpperCase() === "PROXY" || g.toUpperCase() === "GLOBAL") ??
    state.proxyGroups[0];

  if (!primaryGroup) {
    return `<div class="text-muted">No proxy groups found. Set a subscription to load proxies.</div>`;
  }

  const groupItem = state.proxies[primaryGroup];
  const currentNode = groupItem?.now ?? "DIRECT";
  const nodeItem = state.proxies[currentNode];
  const lastDelay = nodeItem?.history?.slice(-1)[0]?.delay;

  return `
    <div class="primary-group-info">
      <div class="primary-group-name">${primaryGroup}</div>
      <div class="primary-node-selected">
        <span class="node-icon">⚡</span>
        <span class="node-name">${currentNode}</span>
        ${
          lastDelay !== undefined
            ? `<span class="badge ${lastDelay > 0 ? (lastDelay < 400 ? "badge-success" : "badge-warning") : "badge-danger"}">${lastDelay > 0 ? `${lastDelay}ms` : "Timeout"}</span>`
            : ""
        }
      </div>
    </div>
  `;
}
