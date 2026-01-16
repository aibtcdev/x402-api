/**
 * Dashboard Endpoint
 *
 * HTML dashboard showing API metrics, usage stats, and analytics.
 * Free endpoint (no payment required).
 */

import { OpenAPIRoute } from "chanfana";
import type { AppContext } from "../types";

// =============================================================================
// Dashboard Endpoint
// =============================================================================

export class Dashboard extends OpenAPIRoute {
  schema = {
    tags: ["Info"],
    summary: "View API metrics dashboard (free)",
    responses: {
      "200": {
        description: "HTML dashboard",
        content: {
          "text/html": {
            schema: { type: "string" as const },
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    let dashboardData: DashboardData;

    try {
      const id = c.env.METRICS_DO.idFromName("global-metrics");
      const metricsDO = c.env.METRICS_DO.get(id);

      const [summary, endpoints, daily, modelStats] = await Promise.all([
        metricsDO.getSummary(),
        metricsDO.getEndpointStats(),
        metricsDO.getDailyStats(7),
        metricsDO.getModelStats(),
      ]);

      dashboardData = {
        summary,
        endpoints,
        daily,
        modelStats,
      };
    } catch (error) {
      c.var.logger.error("Failed to load dashboard data", { error: String(error) });
      dashboardData = {
        summary: {
          totalEndpoints: 0,
          totalCalls: 0,
          earningsSTX: 0,
          earningsSBTC: 0,
          earningsUSDCx: 0,
        },
        endpoints: [],
        daily: [],
        modelStats: [],
      };
    }

    const html = generateDashboardHTML(dashboardData, c.env.X402_NETWORK);
    return c.html(html);
  }
}

// =============================================================================
// Types
// =============================================================================

interface DashboardData {
  summary: {
    totalEndpoints: number;
    totalCalls: number;
    earningsSTX: number;
    earningsSBTC: number;
    earningsUSDCx: number;
  };
  endpoints: Array<{
    endpoint: string;
    category: string;
    totalCalls: number;
    errorCalls: number;
    avgLatencyMs: number;
    totalBytes: number;
    earningsSTX: number;
    earningsSBTC: number;
    earningsUSDCx: number;
    created: string;
    lastCall: string;
  }>;
  daily: Array<{
    date: string;
    totalCalls: number;
    successfulCalls: number;
    errorCalls: number;
    earningsSTX: number;
  }>;
  modelStats: Array<{
    model: string;
    totalCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalEarningsSTX: number;
  }>;
}

// =============================================================================
// HTML Generation
// =============================================================================

function formatSTX(microSTX: number): string {
  return (microSTX / 1_000_000).toFixed(6);
}

function formatSBTC(microSats: number): string {
  // Display as sats
  return Math.round(microSats).toLocaleString();
}

function formatUSDCx(microUSD: number): string {
  return (microUSD / 1_000_000).toFixed(2);
}

function getCategoryClass(category: string): string {
  const classes: Record<string, string> = {
    inference: "cat-inference",
    stacks: "cat-stacks",
    hashing: "cat-hashing",
    storage: "cat-storage",
  };
  return classes[category.toLowerCase()] || "cat-other";
}

function generateDashboardHTML(data: DashboardData, environment: string): string {
  const { summary, endpoints, daily, modelStats } = data;

  // Sort endpoints by total calls descending
  const sortedEndpoints = [...endpoints].sort((a, b) => b.totalCalls - a.totalCalls);

  // Calculate max for daily chart
  const maxDailyCalls = Math.max(...daily.map((d) => d.totalCalls), 1);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>x402 API Dashboard</title>
  <link rel="icon" type="image/png" sizes="32x32" href="https://aibtc.com/favicon-32x32.png">
  <link rel="dns-prefetch" href="https://aibtc.com">
  <link rel="preload" href="https://aibtc.com/Artwork/AIBTC_Pattern1_optimized.jpg" as="image">
  <style>
    @font-face {
      font-family: 'Roc Grotesk';
      src: url('https://aibtc.com/fonts/RocGrotesk-Regular.woff2') format('woff2');
      font-weight: 400;
      font-display: swap;
    }
    @font-face {
      font-family: 'Roc Grotesk';
      src: url('https://aibtc.com/fonts/RocGrotesk-WideMedium.woff2') format('woff2');
      font-weight: 500;
      font-display: swap;
    }
    :root {
      --bg-primary: #09090b;
      --bg-card: #0f0f12;
      --bg-hover: #18181b;
      --border: rgba(255,255,255,0.06);
      --border-hover: rgba(255,255,255,0.1);
      --text-primary: #fafafa;
      --text-secondary: #a1a1aa;
      --text-muted: #71717a;
      --accent: #f7931a;
      --accent-dim: rgba(247, 147, 26, 0.12);
      /* AIBTC brand colors - reserved for future dashboard elements */
      --color-blue: #7DA2FF;
      --color-purple: #A855F7;
      --success: #22c55e;
      --error: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Roc Grotesk', system-ui, sans-serif;
      background: linear-gradient(135deg, #000000, #0a0a0a, #050208);
      color: var(--text-primary);
      min-height: 100vh;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background: url('https://aibtc.com/Artwork/AIBTC_Pattern1_optimized.jpg') center/cover;
      opacity: 0.12;
      filter: saturate(1.3);
      pointer-events: none;
      z-index: -1;
    }
    .container { max-width: 1600px; margin: 0 auto; padding: 24px; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 32px;
    }
    h1 {
      font-size: 32px;
      font-weight: 700;
      color: var(--text-primary);
    }
    h1 .accent { color: var(--accent); }
    .header-flex { display: flex; align-items: center; }
    .header-logo { height: 32px; margin-right: 12px; }
    .env-badge {
      background: ${environment === "mainnet" ? "#166534" : "#1e3a5f"};
      color: ${environment === "mainnet" ? "#4ade80" : "#60a5fa"};
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .subtitle { color: var(--text-muted); margin-bottom: 32px; font-size: 16px; }
    .section-nav {
      display: flex;
      gap: 8px;
      margin-bottom: 32px;
      flex-wrap: wrap;
    }
    .section-nav a {
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 10px 18px;
      border-radius: 10px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.2s ease;
    }
    .section-nav a:hover {
      background: var(--bg-hover);
      border-color: var(--border-hover);
      color: var(--text-primary);
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      transition: all 0.2s ease;
    }
    .card:hover {
      border-color: var(--border-hover);
      transform: translateY(-2px);
    }
    .card h3 {
      color: var(--text-muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 8px;
      font-weight: 500;
    }
    .card .value {
      font-size: 28px;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -0.02em;
    }
    .card .value.stx { color: #06b6d4; }
    .card .value.sbtc { color: var(--accent); }
    .card .value.usdcx { color: #3b82f6; }
    .card .value.success { color: var(--success); }
    .section-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 16px;
      margin-top: 32px;
      color: #fff;
      scroll-margin-top: 24px;
    }
    .chart-container {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
    }
    .chart-title {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 16px;
      color: var(--text-secondary);
    }
    .bar-chart {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      height: 140px;
    }
    .bar-day {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      height: 100%;
      justify-content: flex-end;
    }
    .bar {
      width: 100%;
      background: linear-gradient(180deg, var(--accent) 0%, #c2410c 100%);
      border-radius: 4px 4px 0 0;
      min-height: 4px;
      transition: height 0.3s;
    }
    .bar.errors {
      background: linear-gradient(180deg, var(--error) 0%, #991b1b 100%);
      margin-top: 2px;
    }
    .bar-label { font-size: 11px; color: #71717a; }
    .bar-value { font-size: 11px; color: #a1a1aa; font-weight: 500; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th {
      text-align: left;
      padding: 12px 16px;
      background: #18181b;
      color: #71717a;
      font-weight: 500;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
      border-bottom: 1px solid #27272a;
      position: sticky;
      top: 0;
      cursor: pointer;
      user-select: none;
      transition: color 0.15s;
    }
    th:hover { color: #a1a1aa; }
    th .sort-icon {
      display: inline-block;
      margin-left: 4px;
      opacity: 0.3;
    }
    th.sorted .sort-icon { opacity: 1; color: var(--accent); }
    th.sorted { color: var(--accent); }
    td {
      padding: 12px 16px;
      border-bottom: 1px solid #27272a;
      vertical-align: middle;
    }
    tr:hover { background: #1f1f23; }
    code {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 12px;
      background: #27272a;
      padding: 4px 8px;
      border-radius: 4px;
    }
    .cat-inference { color: #a855f7; }
    .cat-stacks { color: var(--accent); }
    .cat-hashing { color: #06b6d4; }
    .cat-storage { color: #3b82f6; }
    .cat-other { color: #71717a; }
    .table-container {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
    }
    .table-scroll {
      max-height: 500px;
      overflow-y: auto;
    }
    .model-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 12px;
    }
    .model-card {
      background: #27272a;
      border-radius: 8px;
      padding: 14px;
    }
    .model-name {
      font-size: 13px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 8px;
      word-break: break-all;
    }
    .model-stats {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      font-size: 11px;
    }
    .model-stat {
      display: flex;
      flex-direction: column;
    }
    .model-stat .stat-label { color: #71717a; }
    .model-stat .stat-value { color: #a1a1aa; font-weight: 500; }
    .footer {
      margin-top: 48px;
      padding-top: 24px;
      border-top: 1px solid var(--border);
      text-align: center;
      color: var(--text-muted);
      font-size: 13px;
    }
    .footer a { color: var(--accent); text-decoration: none; }
    .footer a:hover { opacity: 0.8; }

    @media (max-width: 600px) {
      .container { padding: 16px; }
      .header { flex-direction: column; gap: 12px; align-items: flex-start; }
      .summary { grid-template-columns: repeat(2, 1fr); gap: 10px; }
      .card { padding: 14px; }
      .card .value { font-size: 20px; }
      .grid-2 { grid-template-columns: 1fr; }
      .section-nav { gap: 6px; }
      .section-nav a { padding: 8px 12px; font-size: 12px; }
      table { font-size: 11px; }
      th, td { padding: 8px 10px; }
      code { font-size: 10px; padding: 2px 4px; }
    }

    @media (max-width: 768px) {
      /* Hide Latency (4) and Created (8) on mobile, keep earnings visible */
      th:nth-child(4), td:nth-child(4),
      th:nth-child(8), td:nth-child(8) { display: none; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-flex">
        <img src="https://aibtc.com/Primary_Logo/SVG/AIBTC_PrimaryLogo_KO.svg" alt="AIBTC" class="header-logo">
        <div>
          <h1><span class="accent">x402</span> Dashboard</h1>
          <p class="subtitle">Real-time metrics for pay-per-use API on Stacks</p>
        </div>
      </div>
      <span class="env-badge">${environment}</span>
    </div>

    <nav class="section-nav">
      <a href="#summary">Summary</a>
      <a href="#daily">Daily Activity</a>
      <a href="#endpoints">Endpoint Metrics</a>
      <a href="#models">LLM Models</a>
      <a href="/docs">API Docs</a>
    </nav>

    <h2 id="summary" class="section-title">Summary</h2>
    <div class="summary">
      <div class="card">
        <h3>Endpoints</h3>
        <div class="value">${summary.totalEndpoints}</div>
      </div>
      <div class="card">
        <h3>Total Calls</h3>
        <div class="value">${summary.totalCalls.toLocaleString()}</div>
      </div>
      <div class="card">
        <h3>STX Earned</h3>
        <div class="value stx">${formatSTX(summary.earningsSTX)}</div>
      </div>
      <div class="card">
        <h3>Sats Earned</h3>
        <div class="value sbtc">${formatSBTC(summary.earningsSBTC)}</div>
      </div>
      <div class="card">
        <h3>USDCx Earned</h3>
        <div class="value usdcx">$${formatUSDCx(summary.earningsUSDCx)}</div>
      </div>
    </div>

    <h2 id="daily" class="section-title">Daily Activity (Last 7 Days)</h2>
    <div class="chart-container">
      <div class="bar-chart">
        ${daily.map((day) => {
          const successHeight = Math.max((day.successfulCalls / maxDailyCalls) * 100, 2);
          const errorHeight = Math.max((day.errorCalls / maxDailyCalls) * 100, 0);
          return `
            <div class="bar-day">
              <div class="bar-value">${day.totalCalls.toLocaleString()}</div>
              <div style="display: flex; flex-direction: column; width: 100%;">
                <div class="bar" style="height: ${successHeight}px"></div>
                ${errorHeight > 0 ? `<div class="bar errors" style="height: ${errorHeight}px"></div>` : ""}
              </div>
              <div class="bar-label">${day.date.slice(5)}</div>
            </div>
          `;
        }).join("")}
      </div>
    </div>

    <h2 id="endpoints" class="section-title">Endpoint Metrics</h2>
    <div class="table-container">
      <div class="table-scroll">
        <table id="endpoints-table">
          <thead>
            <tr>
              <th data-sort="endpoint">Endpoint <span class="sort-icon">↕</span></th>
              <th data-sort="category">Category <span class="sort-icon">↕</span></th>
              <th data-sort="calls" class="sorted">Calls <span class="sort-icon">↓</span></th>
              <th data-sort="latency">Latency <span class="sort-icon">↕</span></th>
              <th data-sort="stx">STX <span class="sort-icon">↕</span></th>
              <th data-sort="sbtc">sBTC <span class="sort-icon">↕</span></th>
              <th data-sort="usdcx">USDCx <span class="sort-icon">↕</span></th>
              <th data-sort="created">Created <span class="sort-icon">↕</span></th>
              <th data-sort="lastcall">Last Call <span class="sort-icon">↕</span></th>
            </tr>
          </thead>
          <tbody>
            ${sortedEndpoints.map((ep) => {
              const createdTs = ep.created ? new Date(ep.created).getTime() : 0;
              const createdDisplay = ep.created ? new Date(ep.created).toLocaleString() : "-";
              const lastCallTs = ep.lastCall ? new Date(ep.lastCall).getTime() : 0;
              const lastCallDisplay = ep.lastCall ? new Date(ep.lastCall).toLocaleString() : "-";

              return `
                <tr data-endpoint="${ep.endpoint}" data-category="${ep.category}" data-calls="${ep.totalCalls}" data-latency="${ep.avgLatencyMs}" data-stx="${ep.earningsSTX}" data-sbtc="${ep.earningsSBTC}" data-usdcx="${ep.earningsUSDCx}" data-created="${createdTs}" data-lastcall="${lastCallTs}">
                  <td><code>${ep.endpoint}</code></td>
                  <td class="${getCategoryClass(ep.category)}">${ep.category}</td>
                  <td>${ep.totalCalls.toLocaleString()}</td>
                  <td>${ep.avgLatencyMs}ms</td>
                  <td>${formatSTX(ep.earningsSTX)}</td>
                  <td>${formatSBTC(ep.earningsSBTC)}</td>
                  <td>$${formatUSDCx(ep.earningsUSDCx)}</td>
                  <td>${createdDisplay}</td>
                  <td>${lastCallDisplay}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>

    <h2 id="models" class="section-title">LLM Model Usage</h2>
    <div class="chart-container">
      <div class="model-grid">
        ${modelStats.length > 0 ? modelStats.map((model) => `
          <div class="model-card">
            <div class="model-name">${model.model}</div>
            <div class="model-stats">
              <div class="model-stat">
                <span class="stat-label">Calls</span>
                <span class="stat-value">${model.totalCalls.toLocaleString()}</span>
              </div>
              <div class="model-stat">
                <span class="stat-label">Input Tokens</span>
                <span class="stat-value">${model.totalInputTokens.toLocaleString()}</span>
              </div>
              <div class="model-stat">
                <span class="stat-label">Output Tokens</span>
                <span class="stat-value">${model.totalOutputTokens.toLocaleString()}</span>
              </div>
              <div class="model-stat">
                <span class="stat-label">Revenue (STX)</span>
                <span class="stat-value">${formatSTX(model.totalEarningsSTX)}</span>
              </div>
            </div>
          </div>
        `).join("") : `<div style="color: #71717a; padding: 20px;">No LLM usage recorded yet</div>`}
      </div>
    </div>

    <div class="footer">
      <p>
        <a href="/">Home</a> |
        <a href="/docs">API Docs</a> |
        <a href="/health">Health</a> |
        Built on <a href="https://stacks.co" target="_blank">Stacks</a>
      </p>
    </div>
  </div>

  <script>
    (function() {
      const table = document.querySelector('#endpoints-table');
      if (!table) return;

      const tbody = table.querySelector('tbody');
      const headers = table.querySelectorAll('th[data-sort]');
      const numericKeys = ['calls', 'latency', 'stx', 'sbtc', 'usdcx', 'created', 'lastcall'];
      let currentSort = { key: 'calls', dir: 'desc' };

      function sortTable(key) {
        const rows = Array.from(tbody.querySelectorAll('tr'));
        const isNumeric = numericKeys.includes(key);

        if (currentSort.key === key) {
          currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          currentSort.key = key;
          currentSort.dir = isNumeric ? 'desc' : 'asc';
        }

        rows.sort((a, b) => {
          let aVal = a.dataset[key];
          let bVal = b.dataset[key];

          if (isNumeric) {
            aVal = parseFloat(aVal) || 0;
            bVal = parseFloat(bVal) || 0;
            return currentSort.dir === 'asc' ? aVal - bVal : bVal - aVal;
          } else {
            return currentSort.dir === 'asc'
              ? (aVal || '').localeCompare(bVal || '')
              : (bVal || '').localeCompare(aVal || '');
          }
        });

        rows.forEach(row => tbody.appendChild(row));

        headers.forEach(th => {
          const icon = th.querySelector('.sort-icon');
          if (th.dataset.sort === key) {
            th.classList.add('sorted');
            icon.textContent = currentSort.dir === 'asc' ? '↑' : '↓';
          } else {
            th.classList.remove('sorted');
            icon.textContent = '↕';
          }
        });
      }

      headers.forEach(th => {
        th.addEventListener('click', () => sortTable(th.dataset.sort));
      });
    })();
  </script>
</body>
</html>`;
}
