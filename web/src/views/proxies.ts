import { api } from "../api.js";
import { type AppState, store } from "../state.js";

let activeGroup = "";
let searchQuery = "";
let testingGroup = false;

export function renderProxies(container: HTMLElement, state: AppState): void {
  const groups = state.proxyGroups;

  if (groups.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🌐</div>
        <div class="empty-title">No Proxies Loaded</div>
        <div class="empty-desc">Configure a subscription URL in Subscriptions to import proxies.</div>
        <button id="goto-sub-btn" class="btn btn-primary">Go to Subscriptions</button>
      </div>
    `;
    container.querySelector("#goto-sub-btn")?.addEventListener("click", () => {
      store.setTab("subscriptions");
    });
    return;
  }

  if (!activeGroup || !groups.includes(activeGroup)) {
    activeGroup =
      groups.find((g) => g.toUpperCase() === "PROXY" || g.toUpperCase() === "GLOBAL") ??
      groups[0] ??
      "";
  }

  const groupData = state.proxies[activeGroup];
  const currentNode = groupData?.now ?? "";
  const allNodes = groupData?.all ?? [];

  const filteredNodes = allNodes.filter((nodeName) =>
    nodeName.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  container.innerHTML = `
    <div class="proxies-layout">
      <!-- Group Tabs -->
      <div class="group-tabs-bar">
        ${groups
          .map(
            (g) => `
          <button class="group-tab-btn ${g === activeGroup ? "active" : ""}" data-group="${g}">
            <span class="tab-title">${g}</span>
            <span class="tab-type">${state.proxies[g]?.type || "Selector"}</span>
          </button>
        `,
          )
          .join("")}
      </div>

      <!-- Action Bar -->
      <div class="group-action-bar">
        <div class="group-header-info">
          <h2 class="current-group-title">${activeGroup}</h2>
          <span class="badge badge-neutral">${groupData?.type || "Selector"} (${allNodes.length} nodes)</span>
        </div>
        <div class="group-controls">
          <input type="text" id="proxy-search" class="input input-sm" placeholder="Filter nodes..." value="${searchQuery}" />
          <button id="test-latency-btn" class="btn btn-sm btn-secondary" ${testingGroup ? "disabled" : ""}>
            ${testingGroup ? "Testing..." : "⚡ Test Latency"}
          </button>
        </div>
      </div>

      <!-- Nodes Grid -->
      <div class="nodes-grid">
        ${filteredNodes
          .map((nodeName) => {
            const nodeData = state.proxies[nodeName];
            const isSelected = nodeName === currentNode;
            const history = nodeData?.history ?? [];
            const lastDelay = history.length > 0 ? history[history.length - 1]?.delay : undefined;

            let badgeClass = "badge-neutral";
            let badgeText = "--";

            if (lastDelay !== undefined) {
              if (lastDelay === 0) {
                badgeClass = "badge-danger";
                badgeText = "Timeout";
              } else if (lastDelay < 300) {
                badgeClass = "badge-success";
                badgeText = `${lastDelay}ms`;
              } else if (lastDelay < 600) {
                badgeClass = "badge-warning";
                badgeText = `${lastDelay}ms`;
              } else {
                badgeClass = "badge-danger";
                badgeText = `${lastDelay}ms`;
              }
            }

            return `
            <div class="node-card ${isSelected ? "selected" : ""}" data-node="${nodeName}">
              <div class="node-card-top">
                <span class="node-type-tag">${nodeData?.type || "Node"}</span>
                <span class="badge ${badgeClass}">${badgeText}</span>
              </div>
              <div class="node-card-name" title="${nodeName}">${nodeName}</div>
            </div>
          `;
          })
          .join("")}
      </div>
    </div>
  `;

  // Group tab click
  container.querySelectorAll(".group-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeGroup = (btn as HTMLElement).dataset.group ?? "";
      renderProxies(container, state);
    });
  });

  // Search input
  const searchInput = container.querySelector("#proxy-search") as HTMLInputElement;
  searchInput?.addEventListener("input", (e) => {
    searchQuery = (e.target as HTMLInputElement).value;
    renderProxies(container, state);
    // keep focus
    const newSearch = container.querySelector("#proxy-search") as HTMLInputElement;
    newSearch?.focus();
    newSearch?.setSelectionRange(searchQuery.length, searchQuery.length);
  });

  // Node selection click
  container.querySelectorAll(".node-card").forEach((card) => {
    card.addEventListener("click", async () => {
      const nodeName = (card as HTMLElement).dataset.node;
      if (!nodeName || nodeName === currentNode) return;

      try {
        await api.selectProxy(activeGroup, nodeName);
        const proxiesRes = await api.getProxies();
        store.setProxies(proxiesRes.proxies);
      } catch (err) {
        alert(`Failed to switch node: ${(err as Error).message}`);
      }
    });
  });

  // Latency test button
  const testBtn = container.querySelector("#test-latency-btn");
  testBtn?.addEventListener("click", async () => {
    if (testingGroup) return;
    testingGroup = true;
    renderProxies(container, state);

    try {
      // Concurrency limit: 5 nodes at a time
      const concurrency = 5;
      const chunks: string[][] = [];
      for (let i = 0; i < allNodes.length; i += concurrency) {
        chunks.push(allNodes.slice(i, i + concurrency));
      }

      for (const chunk of chunks) {
        await Promise.all(
          chunk.map(async (name) => {
            try {
              const res = await api.testProxyDelay(name);
              store.updateProxyDelay(name, res.delay);
            } catch {
              store.updateProxyDelay(name, 0);
            }
          }),
        );
      }
    } finally {
      testingGroup = false;
      renderProxies(container, state);
    }
  });
}
