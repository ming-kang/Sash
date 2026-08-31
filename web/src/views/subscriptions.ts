import { api } from "../api.js";
import { type AppState, store } from "../state.js";

let updating = false;

export function renderSubscriptions(container: HTMLElement, state: AppState): void {
  const currentUrl = state.status?.settings.subscriptionUrl ?? "";
  const totalProxies = Object.keys(state.proxies).length;

  container.innerHTML = `
    <div class="sub-page">
      <div class="card sub-card">
        <div class="card-header">
          <span class="card-title">Remote Subscription</span>
          <span class="badge ${currentUrl ? "badge-success" : "badge-neutral"}">${currentUrl ? "Active" : "Not Configured"}</span>
        </div>
        <p class="card-desc">
          Import a Clash / Mihomo formatted subscription URL. Sash will fetch and validate nodes, compile routing rules, and hot-reload the running core.
        </p>

        <form id="sub-form" class="sub-form">
          <div class="form-group">
            <label class="form-label" for="sub-url-input">Subscription URL</label>
            <div class="input-with-actions">
              <input
                type="url"
                id="sub-url-input"
                class="input"
                placeholder="https://example.com/api/v1/client/subscribe?token=..."
                value="${currentUrl}"
                required
              />
              <button type="submit" class="btn btn-primary" ${updating ? "disabled" : ""}>
                ${updating ? "Updating..." : "Save & Update"}
              </button>
            </div>
          </div>
        </form>

        ${
          currentUrl
            ? `
          <div class="sub-actions-bar">
            <button id="refresh-sub-btn" class="btn btn-secondary" ${updating ? "disabled" : ""}>
              🔄 Refresh Subscription Now
            </button>
            <button id="clear-sub-btn" class="btn btn-danger-outline" ${updating ? "disabled" : ""}>
              🗑️ Remove Subscription
            </button>
          </div>
        `
            : ""
        }
      </div>

      <!-- Subscription Stats -->
      <div class="card stats-card">
        <div class="card-header">
          <span class="card-title">Subscription Details</span>
        </div>
        <div class="status-meta">
          <div class="meta-row">
            <span class="meta-label">Loaded Proxies</span>
            <span class="meta-val">${totalProxies} proxies</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">Proxy Groups</span>
            <span class="meta-val">${state.proxyGroups.length} groups</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">Rule Count</span>
            <span class="meta-val">${state.rules.length} rules</span>
          </div>
        </div>
      </div>
    </div>
  `;

  // Submit new subscription URL
  const form = container.querySelector("#sub-form") as HTMLFormElement;
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = container.querySelector("#sub-url-input") as HTMLInputElement;
    const url = input.value.trim();
    if (!url) return;

    updating = true;
    renderSubscriptions(container, state);

    try {
      const res = await api.setSubscription(url);
      alert(`Subscription saved! Loaded ${res.proxyCount} proxies.`);
      const [newStatus, newProxies, newRules] = await Promise.all([
        api.getStatus(),
        api.getProxies(),
        api.getRules(),
      ]);
      store.setStatus(newStatus);
      store.setProxies(newProxies.proxies);
      store.setRules(newRules.rules);
    } catch (err) {
      alert(`Failed to set subscription: ${(err as Error).message}`);
    } finally {
      updating = false;
      renderSubscriptions(container, state);
    }
  });

  // Refresh existing subscription
  const refreshBtn = container.querySelector("#refresh-sub-btn");
  refreshBtn?.addEventListener("click", async () => {
    updating = true;
    renderSubscriptions(container, state);

    try {
      const res = await api.refreshSubscription();
      alert(`Subscription refreshed! Loaded ${res.proxyCount} proxies.`);
      const [newProxies, newRules] = await Promise.all([api.getProxies(), api.getRules()]);
      store.setProxies(newProxies.proxies);
      store.setRules(newRules.rules);
    } catch (err) {
      alert(`Failed to refresh subscription: ${(err as Error).message}`);
    } finally {
      updating = false;
      renderSubscriptions(container, state);
    }
  });

  // Clear subscription
  const clearBtn = container.querySelector("#clear-sub-btn");
  clearBtn?.addEventListener("click", async () => {
    if (!confirm("Remove subscription and revert to default DIRECT config?")) return;
    updating = true;
    renderSubscriptions(container, state);

    try {
      await api.unsetSubscription();
      alert("Subscription removed.");
      const [newStatus, newProxies, newRules] = await Promise.all([
        api.getStatus(),
        api.getProxies(),
        api.getRules(),
      ]);
      store.setStatus(newStatus);
      store.setProxies(newProxies.proxies);
      store.setRules(newRules.rules);
    } catch (err) {
      alert(`Failed to remove subscription: ${(err as Error).message}`);
    } finally {
      updating = false;
      renderSubscriptions(container, state);
    }
  });
}
