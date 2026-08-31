import type { AppState } from "../state.js";

let logLevel = "all";
const autoScroll = true;

export function renderLogs(container: HTMLElement, state: AppState): void {
  const logs = state.logs;
  const filtered = logs.filter((l) => {
    if (logLevel === "all") return true;
    return l.type.toLowerCase() === logLevel.toLowerCase();
  });

  container.innerHTML = `
    <div class="logs-page">
      <div class="group-action-bar">
        <div class="group-header-info">
          <h2 class="current-group-title">Runtime Core Logs</h2>
          <span class="badge badge-neutral">${logs.length} entries</span>
        </div>
        <div class="group-controls">
          <div class="filter-btn-group">
            <button class="btn btn-sm ${logLevel === "all" ? "btn-primary" : "btn-secondary"} log-filter-btn" data-level="all">All</button>
            <button class="btn btn-sm ${logLevel === "info" ? "btn-primary" : "btn-secondary"} log-filter-btn" data-level="info">Info</button>
            <button class="btn btn-sm ${logLevel === "warning" ? "btn-primary" : "btn-secondary"} log-filter-btn" data-level="warning">Warning</button>
            <button class="btn btn-sm ${logLevel === "error" ? "btn-primary" : "btn-secondary"} log-filter-btn" data-level="error">Error</button>
          </div>
          <button id="clear-logs-btn" class="btn btn-sm btn-secondary">Clear</button>
        </div>
      </div>

      <div class="logs-terminal" id="logs-container">
        ${
          filtered.length === 0
            ? `<div class="log-line text-muted">Listening for live logs...</div>`
            : filtered
                .map(
                  (l) => `
              <div class="log-line log-${l.type}">
                <span class="log-badge badge badge-${l.type === "error" ? "danger" : l.type === "warning" ? "warning" : "neutral"}">${l.type.toUpperCase()}</span>
                <span class="log-text">${escapeHtml(l.payload)}</span>
              </div>
            `,
                )
                .join("")
        }
      </div>
    </div>
  `;

  const term = container.querySelector("#logs-container") as HTMLElement;
  if (term && autoScroll) {
    term.scrollTop = term.scrollHeight;
  }

  // Level filter buttons
  container.querySelectorAll(".log-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      logLevel = (btn as HTMLElement).dataset.level ?? "all";
      renderLogs(container, state);
    });
  });

  // Clear logs button
  container.querySelector("#clear-logs-btn")?.addEventListener("click", () => {
    state.logs.length = 0;
    renderLogs(container, state);
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
