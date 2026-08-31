import type { AppState } from "../state.js";

let ruleSearch = "";

export function renderRules(container: HTMLElement, state: AppState): void {
  const rules = state.rules;
  const filtered = rules.filter((r) => {
    const q = ruleSearch.toLowerCase();
    return (
      r.type.toLowerCase().includes(q) ||
      r.payload.toLowerCase().includes(q) ||
      r.proxy.toLowerCase().includes(q)
    );
  });

  container.innerHTML = `
    <div class="rules-page">
      <div class="group-action-bar">
        <div class="group-header-info">
          <h2 class="current-group-title">Routing Rules</h2>
          <span class="badge badge-neutral">${rules.length} rules loaded</span>
        </div>
        <div class="group-controls">
          <input
            type="text"
            id="rule-search"
            class="input input-sm"
            placeholder="Search rules..."
            value="${ruleSearch}"
          />
        </div>
      </div>

      <div class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th>Index</th>
              <th>Type</th>
              <th>Payload</th>
              <th>Target Proxy</th>
            </tr>
          </thead>
          <tbody>
            ${
              filtered.length === 0
                ? `<tr><td colspan="4" class="text-center text-muted">No rules match filter</td></tr>`
                : filtered
                    .map(
                      (r, idx) => `
                  <tr>
                    <td class="cell-idx">#${idx + 1}</td>
                    <td><span class="badge badge-neutral">${r.type}</span></td>
                    <td class="cell-payload" title="${r.payload || "-"}">${r.payload || "-"}</td>
                    <td><span class="badge badge-primary">${r.proxy}</span></td>
                  </tr>
                `,
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  const searchInput = container.querySelector("#rule-search") as HTMLInputElement;
  searchInput?.addEventListener("input", (e) => {
    ruleSearch = (e.target as HTMLInputElement).value;
    renderRules(container, state);
    const newSearch = container.querySelector("#rule-search") as HTMLInputElement;
    newSearch?.focus();
    newSearch?.setSelectionRange(ruleSearch.length, ruleSearch.length);
  });
}
