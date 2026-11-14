// GitHub Pages ダッシュボード用の埋め込み CSS 定数

export const DASHBOARD_CSS = `    :root {
      --bg-color: #f8fafc;
      --card-bg: #ffffff;
      --text-color: #0f172a;
      --text-muted: #64748b;
      --border-color: #e2e8f0;
      --primary: #2563eb;
      --primary-light: #eff6ff;
      --success: #16a34a;
      --warning: #d97706;
      --danger: #dc2626;
      --code-bg: #f1f5f9;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg-color: #0f172a;
        --card-bg: #1e293b;
        --text-color: #f8fafc;
        --text-muted: #94a3b8;
        --border-color: #334155;
        --primary: #3b82f6;
        --primary-light: #1e3a8a;
        --success: #22c55e;
        --warning: #f59e0b;
        --danger: #ef4444;
        --code-bg: #0f172a;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background-color: var(--bg-color);
      color: var(--text-color);
      line-height: 1.6;
      padding: 1.5rem;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    header {
      margin-bottom: 2rem;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 1.5rem;
    }
    h1 { font-size: 1.875rem; font-weight: 700; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem; }
    .meta-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
      font-size: 0.875rem;
      color: var(--text-muted);
      align-items: center;
    }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.6rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      background-color: var(--primary-light);
      color: var(--primary);
      text-decoration: none;
    }
    .delta-badge {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      line-height: 1.2;
    }
    .delta-progress {
      background-color: #dcfce7;
      color: #15803d;
    }
    .delta-rewind {
      background-color: #fee2e2;
      color: #b91c1c;
    }
    .delta-neutral {
      background-color: var(--code-bg);
      color: var(--text-muted);
    }
    @media (prefers-color-scheme: dark) {
      .delta-progress {
        background-color: #14532d;
        color: #86efac;
      }
      .delta-rewind {
        background-color: #7f1d1d;
        color: #fca5a5;
      }
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1.25rem;
      margin-bottom: 2rem;
    }
    .card {
      background-color: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 0.75rem;
      padding: 1.25rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .card-title {
      font-size: 0.875rem;
      color: var(--text-muted);
      font-weight: 500;
      margin-bottom: 0.5rem;
    }
    .card-value {
      font-size: 1.75rem;
      font-weight: 700;
      color: var(--text-color);
    }
    .card-subtext {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 0.35rem;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      flex-wrap: wrap;
    }
    .stat-card {
      padding: 1rem 1.25rem;
    }
    .flow-container {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      background-color: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-bottom: 2rem;
      overflow-x: auto;
    }
    .flow-node {
      background-color: var(--code-bg);
      border: 1px solid var(--border-color);
      border-radius: 0.5rem;
      padding: 0.75rem 1rem;
      text-align: center;
      min-width: 120px;
      flex-shrink: 0;
    }
    .flow-node.target {
      border: 2px solid var(--primary);
      background-color: var(--primary-light);
    }
    .flow-arrow {
      color: var(--text-muted);
      font-weight: bold;
      font-size: 1rem;
      text-align: center;
      white-space: nowrap;
    }
    .flow-arrow-note {
      font-size: 0.75rem;
      font-weight: normal;
    }
    .section-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 2rem 0 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 1.5rem;
      font-size: 0.875rem;
      background-color: var(--card-bg);
      border-radius: 0.75rem;
      overflow: hidden;
      border: 1px solid var(--border-color);
    }
    th, td {
      padding: 0.75rem 1rem;
      text-align: left;
      border-bottom: 1px solid var(--border-color);
    }
    th {
      background-color: var(--code-bg);
      font-weight: 600;
      color: var(--text-muted);
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background-color: rgba(148, 163, 184, 0.05); }
    .progress-bar { height: 6px; background-color: var(--code-bg); border-radius: 3px; margin-top: 0.4rem; overflow: hidden; }
    .progress-bar > div { height: 100%; background-color: var(--success); border-radius: 3px; }
    .forecast-panel { margin-bottom: 0.5rem; }
    .section-note { font-size: 0.875rem; color: var(--text-muted); margin: -0.5rem 0 1rem; }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
    footer {
      margin-top: 3rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border-color);
      text-align: center;
      font-size: 0.875rem;
      color: var(--text-muted);
    }`;
