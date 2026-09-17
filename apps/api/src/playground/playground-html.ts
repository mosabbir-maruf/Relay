/**
 * HTML template generator for the Relay AI Playground.
 * Renders a self-contained, zero-external-dependency Single Page Application (SPA).
 */
export function renderPlaygroundHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Relay — AI Playground</title>
  <style>
    :root {
      --bg-canvas: #09090b;
      --bg-surface: #121215;
      --bg-card: #18181b;
      --bg-input: #141417;
      --bg-hover: #222226;
      --border-subtle: #27272a;
      --border-hover: #3f3f46;
      --text-primary: #f4f4f5;
      --text-secondary: #a1a1aa;
      --text-muted: #71717a;
      --accent-emerald: #10b981;
      --accent-emerald-dim: rgba(16, 185, 129, 0.15);
      --accent-amber: #f59e0b;
      --accent-red: #ef4444;
      --accent-red-dim: rgba(239, 68, 68, 0.15);
      --code-bg: #0e0e11;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-mono: "JetBrains Mono", "SF Mono", "Fira Code", Menlo, Monaco, Consolas, monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html, body {
      height: 100%;
      background-color: var(--bg-canvas);
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      overflow: hidden;
    }

    button, input, select, textarea {
      font-family: inherit;
      font-size: inherit;
      color: inherit;
    }

    a {
      color: var(--text-primary);
      text-decoration: underline;
    }

    /* Layout */
    #app-container {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
      overflow: hidden;
    }

    /* Header */
    header#top-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 52px;
      padding: 0 20px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
      z-index: 20;
    }

    .brand-section {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-title {
      font-weight: 600;
      font-size: 15px;
      letter-spacing: -0.02em;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .brand-badge {
      font-size: 11px;
      font-weight: 500;
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      padding: 2px 6px;
      border-radius: 4px;
      color: var(--text-secondary);
      font-family: var(--font-mono);
    }

    .header-center {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .status-indicator {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-family: var(--font-mono);
      padding: 4px 10px;
      border-radius: 6px;
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      cursor: pointer;
      user-select: none;
      transition: background 0.15s, border-color 0.15s;
    }

    .status-indicator:hover {
      background: var(--bg-hover);
      border-color: var(--border-hover);
    }

    .status-indicator:focus-visible {
      outline: 2px solid var(--border-hover);
      outline-offset: 1px;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--text-muted);
      flex-shrink: 0;
      transition: background-color 0.2s, box-shadow 0.2s;
    }

    .status-dot.connected {
      background: var(--accent-emerald);
      box-shadow: 0 0 8px var(--accent-emerald);
    }

    .status-dot.checking {
      background: var(--accent-amber);
      box-shadow: 0 0 8px var(--accent-amber);
      animation: pulseDot 1.4s ease-in-out infinite;
    }

    .status-dot.disconnected {
      background: var(--accent-red);
      box-shadow: 0 0 8px rgba(239, 68, 68, 0.4);
    }

    .status-dot.unavailable {
      background: var(--text-muted);
      box-shadow: none;
    }

    @keyframes pulseDot {
      0% { transform: scale(0.9); opacity: 0.5; }
      50% { transform: scale(1.15); opacity: 1; }
      100% { transform: scale(0.9); opacity: 0.5; }
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 6px 12px;
      font-size: 13px;
      font-weight: 500;
      border-radius: 6px;
      border: 1px solid var(--border-subtle);
      background: var(--bg-card);
      color: var(--text-primary);
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }

    .btn:hover:not(:disabled) {
      background: var(--bg-hover);
      border-color: var(--border-hover);
    }

    .btn:active:not(:disabled) {
      background: var(--border-subtle);
    }

    .btn:focus-visible {
      outline: 2px solid var(--border-hover);
      outline-offset: 1px;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-icon {
      padding: 6px;
    }

    .btn-danger {
      background: var(--accent-red-dim);
      border-color: rgba(239, 68, 68, 0.3);
      color: var(--accent-red);
    }

    .btn-danger:hover:not(:disabled) {
      background: rgba(239, 68, 68, 0.25);
      border-color: var(--accent-red);
    }

    .btn-primary {
      background: #27272a;
      border-color: #3f3f46;
      color: #ffffff;
    }

    .btn-primary:hover:not(:disabled) {
      background: #3f3f46;
      border-color: #52525b;
    }

    /* Main Workspace */
    #workspace {
      display: flex;
      flex: 1;
      height: calc(100vh - 52px);
      position: relative;
      overflow: hidden;
    }

    /* Chat Column */
    #chat-section {
      display: flex;
      flex-direction: column;
      flex: 1;
      height: 100%;
      min-width: 0;
      position: relative;
    }

    /* Message Area */
    #messages-viewport {
      flex: 1;
      overflow-y: auto;
      padding: 24px 20px;
      scroll-behavior: smooth;
    }

    #messages-viewport::-webkit-scrollbar {
      width: 6px;
    }
    #messages-viewport::-webkit-scrollbar-thumb {
      background: var(--border-subtle);
      border-radius: 3px;
    }

    .messages-container {
      max-width: 820px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    /* Empty Welcome State */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 60px 20px;
      text-align: center;
    }

    .empty-title {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 8px;
      letter-spacing: -0.02em;
    }

    .empty-desc {
      color: var(--text-secondary);
      max-width: 520px;
      margin-bottom: 28px;
      font-size: 13px;
      line-height: 1.6;
    }

    .prompt-suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      max-width: 680px;
    }

    .suggestion-chip {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 12px;
      color: var(--text-secondary);
      cursor: pointer;
      text-align: left;
      transition: all 0.15s;
    }

    .suggestion-chip:hover {
      background: var(--bg-card);
      color: var(--text-primary);
      border-color: var(--border-hover);
    }

    /* Message Rows */
    .message-row {
      display: flex;
      flex-direction: column;
      width: 100%;
      animation: fadeIn 0.15s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(3px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .message-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }

    .message-author {
      font-weight: 600;
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.05em;
    }

    .message-row.user .message-author {
      color: #38bdf8;
    }

    .message-row.assistant .message-author {
      color: var(--accent-emerald);
    }

    .message-bubble {
      padding: 14px 18px;
      border-radius: 6px;
      border: 1px solid var(--border-subtle);
      font-size: 14px;
      line-height: 1.65;
      word-break: break-word;
      position: relative;
    }

    .message-row.user .message-bubble {
      background: #151518;
      align-self: flex-start;
      width: 100%;
      border-color: #2e2e33;
    }

    .message-row.assistant .message-bubble {
      background: var(--bg-card);
      width: 100%;
    }

    .message-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      opacity: 0.7;
      transition: opacity 0.15s;
    }

    .message-row:hover .message-actions {
      opacity: 1;
    }

    .action-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: var(--font-mono);
      transition: all 0.15s;
    }

    .action-btn:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
      border-color: var(--border-subtle);
    }

    /* Markdown Rendering */
    .prose p {
      margin-bottom: 12px;
    }

    .prose p:last-child {
      margin-bottom: 0;
    }

    .prose h1, .prose h2, .prose h3, .prose h4 {
      font-weight: 600;
      margin-top: 16px;
      margin-bottom: 8px;
      letter-spacing: -0.01em;
    }

    .prose h1 { font-size: 18px; }
    .prose h2 { font-size: 16px; }
    .prose h3 { font-size: 14px; }
    .prose h4 { font-size: 13px; }

    .prose ul, .prose ol {
      margin-left: 20px;
      margin-bottom: 12px;
    }

    .prose li {
      margin-bottom: 4px;
    }

    .prose blockquote {
      border-left: 3px solid var(--border-hover);
      padding-left: 12px;
      color: var(--text-secondary);
      margin: 10px 0;
    }

    .prose code.inline-code {
      font-family: var(--font-mono);
      font-size: 12.5px;
      background: var(--code-bg);
      border: 1px solid var(--border-subtle);
      padding: 1px 5px;
      border-radius: 4px;
      color: #e4e4e7;
    }

    /* Code Blocks */
    .code-block-wrapper {
      margin: 12px 0;
      background: var(--code-bg);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      overflow: hidden;
    }

    .code-block-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: #09090c;
      border-bottom: 1px solid var(--border-subtle);
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
    }

    .code-block-lang {
      font-weight: 500;
      text-transform: lowercase;
    }

    .code-copy-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: var(--font-mono);
      transition: all 0.15s;
    }

    .code-copy-btn:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
      border-color: var(--border-subtle);
    }

    .code-block-content {
      padding: 12px 14px;
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 12.5px;
      line-height: 1.6;
      color: #d4d4d8;
      tab-size: 2;
    }

    /* Syntax Highlighting */
    .hl-kw { color: #f43f5e; font-weight: 500; }
    .hl-str { color: #34d399; }
    .hl-num { color: #38bdf8; }
    .hl-comment { color: #71717a; font-style: italic; }
    .hl-type { color: #fbbf24; }
    .hl-fn { color: #818cf8; }
    .hl-punct { color: #a1a1aa; }

    /* Streaming Cursor */
    .streaming-cursor {
      display: inline-block;
      width: 7px;
      height: 14px;
      background: var(--accent-emerald);
      vertical-align: middle;
      margin-left: 2px;
      animation: blink 0.9s infinite;
    }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }

    /* Scroll to bottom button */
    #scroll-bottom-btn {
      position: absolute;
      bottom: 120px;
      right: 32px;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 20px;
      padding: 6px 12px;
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      display: none;
      cursor: pointer;
      z-index: 10;
    }

    #scroll-bottom-btn:hover {
      color: var(--text-primary);
      border-color: var(--border-hover);
    }

    /* Composer */
    #composer-container {
      padding: 12px 20px 16px 20px;
      background: var(--bg-surface);
      border-top: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }

    .composer-inner {
      max-width: 820px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .composer-input-box {
      background: var(--bg-input);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 8px 12px;
      display: flex;
      flex-direction: column;
      transition: border-color 0.15s;
    }

    .composer-input-box:focus-within {
      border-color: var(--border-hover);
    }

    #chat-textarea {
      width: 100%;
      background: transparent;
      border: none;
      outline: none;
      resize: none;
      color: var(--text-primary);
      font-size: 14px;
      line-height: 1.5;
      min-height: 48px;
      max-height: 220px;
    }

    .composer-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 6px;
      padding-top: 4px;
    }

    .composer-hints {
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .composer-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Sidebar / Settings */
    #settings-sidebar {
      width: 320px;
      background: var(--bg-surface);
      border-left: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      height: 100%;
      flex-shrink: 0;
      transition: transform 0.2s ease, width 0.2s ease;
      z-index: 15;
    }

    #settings-sidebar.collapsed {
      display: none;
    }

    .sidebar-header {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border-subtle);
      font-weight: 600;
      font-size: 13px;
      letter-spacing: -0.01em;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .sidebar-body {
      padding: 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 18px;
      flex: 1;
    }

    .setting-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .setting-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-secondary);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .setting-value {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
    }

    .setting-input, .setting-select, .setting-textarea {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 13px;
      color: var(--text-primary);
      outline: none;
      transition: border-color 0.15s;
    }

    .setting-input:focus, .setting-select:focus, .setting-textarea:focus {
      border-color: var(--border-hover);
    }

    .setting-textarea {
      resize: vertical;
      min-height: 80px;
      line-height: 1.4;
      font-size: 12px;
    }

    .setting-range {
      width: 100%;
      accent-color: #52525b;
      cursor: pointer;
    }

    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .toggle-switch {
      position: relative;
      display: inline-block;
      width: 34px;
      height: 18px;
    }

    .toggle-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .slider-track {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: var(--border-subtle);
      transition: .2s;
      border-radius: 18px;
    }

    .slider-track:before {
      position: absolute;
      content: "";
      height: 12px;
      width: 12px;
      left: 3px;
      bottom: 3px;
      background-color: var(--text-muted);
      transition: .2s;
      border-radius: 50%;
    }

    input:checked + .slider-track {
      background-color: #3f3f46;
    }

    input:checked + .slider-track:before {
      transform: translateX(16px);
      background-color: #f4f4f5;
    }

    .setting-help {
      font-size: 11px;
      color: var(--text-muted);
      line-height: 1.4;
    }

    .alert-banner {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      padding: 10px 14px;
      border-radius: 6px;
      color: #fca5a5;
      font-size: 12px;
      line-height: 1.5;
      margin: 10px 20px 0 20px;
      display: none;
    }

    /* Mobile Responsive */
    @media (max-width: 768px) {
      #settings-sidebar {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        width: 280px;
        box-shadow: -4px 0 16px rgba(0,0,0,0.5);
      }
      .brand-badge { display: none; }
    }
  </style>
</head>
<body>
  <div id="app-container">
    <!-- Top Header -->
    <header id="top-header">
      <div class="brand-section">
        <div class="brand-title">
          <span>Relay</span>
          <span class="brand-badge">Playground</span>
        </div>
      </div>

      <div class="header-center">
        <div id="connection-status" class="status-indicator" title="Click to test connection" role="status" aria-live="polite" tabindex="0">
          <span id="status-dot" class="status-dot checking"></span>
          <span id="status-model-name">qwen3-coder-30b</span>
          <span class="status-separator" style="opacity: 0.35;">•</span>
          <span id="status-text">Checking…</span>
        </div>
      </div>

      <div class="header-actions">
        <button id="clear-chat-btn" class="btn" title="Clear conversation (Ctrl+K)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
          <span>Clear</span>
        </button>
        <button id="toggle-sidebar-btn" class="btn btn-icon" title="Toggle settings panel">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>
        </button>
      </div>
    </header>

    <!-- Error Banner -->
    <div id="error-banner" class="alert-banner"></div>

    <!-- Main Workspace -->
    <main id="workspace">
      <!-- Chat Column -->
      <section id="chat-section">
        <div id="messages-viewport">
          <div id="messages-list" class="messages-container">
            <!-- Welcome state rendered dynamically when empty -->
          </div>
        </div>

        <button id="scroll-bottom-btn" title="Scroll to bottom">
          ↓ Scroll to bottom
        </button>

        <!-- Composer -->
        <div id="composer-container">
          <div class="composer-inner">
            <div class="composer-input-box">
              <textarea
                id="chat-textarea"
                placeholder="Send a message... (Enter to send, Shift+Enter for newline)"
                rows="1"
              ></textarea>
              <div class="composer-toolbar">
                <div class="composer-hints">
                  <span id="char-token-counter">0 tokens • 0 chars</span>
                  <span style="opacity: 0.6;">↵ Send • ⇧↵ Newline</span>
                </div>
                <div class="composer-controls">
                  <button id="stop-generation-btn" class="btn btn-danger" style="display: none;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>
                    <span>Stop</span>
                  </button>
                  <button id="send-message-btn" class="btn btn-primary" title="Send message (Enter)">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 14-7-7 14-2-5-5-2Z"/></svg>
                    <span>Send</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Settings Sidebar -->
      <aside id="settings-sidebar">
        <div class="sidebar-header">
          <span>Parameters</span>
          <button id="close-sidebar-btn" class="btn btn-icon" style="padding: 2px 4px; font-size: 11px;">✕</button>
        </div>
        <div class="sidebar-body">
          <!-- Model Selection -->
          <div class="setting-group">
            <label class="setting-label" for="model-select">
              <span>Model</span>
              <span id="model-owner-tag" class="setting-value">...</span>
            </label>
            <select id="model-select" class="setting-select">
              <option value="">Loading models...</option>
            </select>
          </div>

          <!-- Temperature -->
          <div class="setting-group">
            <label class="setting-label" for="temp-slider">
              <span>Temperature</span>
              <span id="temp-val" class="setting-value">0.7</span>
            </label>
            <input id="temp-slider" type="range" class="setting-range" min="0" max="2" step="0.05" value="0.7" />
            <span class="setting-help">Higher values produce more creative responses; lower values are more deterministic.</span>
          </div>

          <!-- Max Tokens -->
          <div class="setting-group">
            <label class="setting-label" for="max-tokens-input">
              <span>Max Tokens</span>
              <span id="max-tokens-val" class="setting-value">2048</span>
            </label>
            <input id="max-tokens-input" type="number" class="setting-input" min="64" max="8192" step="64" value="2048" />
          </div>

          <!-- System Prompt -->
          <div class="setting-group">
            <label class="setting-label" for="system-prompt-input">
              <span>System Prompt</span>
            </label>
            <textarea id="system-prompt-input" class="setting-textarea" placeholder="Enter custom system instructions..."></textarea>
          </div>

          <!-- Streaming Toggle -->
          <div class="toggle-row">
            <span>Stream Responses (SSE)</span>
            <label class="toggle-switch">
              <input id="stream-toggle" type="checkbox" checked />
              <span class="slider-track"></span>
            </label>
          </div>

          <!-- Relay API Key (Session Storage Only) -->
          <div class="setting-group" style="margin-top: 10px; border-top: 1px solid var(--border-subtle); padding-top: 14px;">
            <label class="setting-label" for="relay-api-key-input">
              <span>Gateway API Key</span>
              <span class="setting-value">session</span>
            </label>
            <input id="relay-api-key-input" type="password" class="setting-input" placeholder="Optional RELAY_API_KEY..." autocomplete="off" />
            <span class="setting-help">Stored only in <code>sessionStorage</code> for this browser tab. Never saved to localStorage or disk.</span>
          </div>

          <!-- Reset Defaults -->
          <button id="reset-settings-btn" class="btn" style="margin-top: 10px; font-size: 12px;">
            Reset Parameters
          </button>
        </div>
      </aside>
    </main>
  </div>

  <!-- Client Script (Zero Frameworks, Native ESM) -->
  <script type="module">
    // State Management
    const STORAGE_CHAT_KEY = 'relay_playground_chat_v1';
    const STORAGE_CONFIG_KEY = 'relay_playground_config_v1';
    const SESSION_AUTH_KEY = 'relay_api_key';

    const state = {
      models: [],
      activeModel: '',
      messages: [],
      systemPrompt: 'You are a helpful and concise AI programming assistant.',
      temperature: 0.7,
      maxTokens: 2048,
      stream: true,
      isGenerating: false,
      abortController: null,
      autoScroll: true,
      health: {
        status: 'checking',
        providerId: '',
        latencyMs: 0,
        lastChecked: 0,
        errorMessage: null,
        isChecking: false,
      },
    };

    // DOM Elements
    const elements = {
      connectionStatus: document.getElementById('connection-status'),
      statusDot: document.getElementById('status-dot'),
      statusModelName: document.getElementById('status-model-name'),
      statusText: document.getElementById('status-text'),
      modelSelect: document.getElementById('model-select'),
      modelOwnerTag: document.getElementById('model-owner-tag'),
      messagesViewport: document.getElementById('messages-viewport'),
      messagesList: document.getElementById('messages-list'),
      chatTextarea: document.getElementById('chat-textarea'),
      charTokenCounter: document.getElementById('char-token-counter'),
      sendMessageBtn: document.getElementById('send-message-btn'),
      stopGenerationBtn: document.getElementById('stop-generation-btn'),
      clearChatBtn: document.getElementById('clear-chat-btn'),
      scrollBottomBtn: document.getElementById('scroll-bottom-btn'),
      toggleSidebarBtn: document.getElementById('toggle-sidebar-btn'),
      closeSidebarBtn: document.getElementById('close-sidebar-btn'),
      settingsSidebar: document.getElementById('settings-sidebar'),
      tempSlider: document.getElementById('temp-slider'),
      tempVal: document.getElementById('temp-val'),
      maxTokensInput: document.getElementById('max-tokens-input'),
      maxTokensVal: document.getElementById('max-tokens-val'),
      systemPromptInput: document.getElementById('system-prompt-input'),
      streamToggle: document.getElementById('stream-toggle'),
      relayApiKeyInput: document.getElementById('relay-api-key-input'),
      resetSettingsBtn: document.getElementById('reset-settings-btn'),
      errorBanner: document.getElementById('error-banner'),
    };

    // XSS Prevention: Safe HTML Entity Escaper
    function escapeHtml(text) {
      if (!text) return '';
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // Lightweight Syntax Highlighter (TS, JS, Python, Bash, JSON, SQL)
    function highlightCodeTokens(rawCode, lang) {
      const escaped = escapeHtml(rawCode);
      const language = (lang || '').toLowerCase();

      // Keywords by category
      const keywords = new Set([
        'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
        'switch', 'case', 'break', 'continue', 'new', 'delete', 'typeof', 'instanceof',
        'async', 'await', 'import', 'export', 'from', 'as', 'default', 'class', 'extends',
        'try', 'catch', 'finally', 'throw', 'this', 'super', 'interface', 'type', 'enum',
        'def', 'elif', 'pass', 'lambda', 'with', 'yield', 'None', 'True', 'False',
        'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'JOIN', 'GROUP', 'BY',
      ]);

      // Tokenization regex matching strings, comments, numbers, identifiers, symbols
      const tokenRegex = /(\\/\\/[^\\n]*|#\\s[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|("(?:\\\\[\\s\\S]|[^"\\\\])*"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\`(?:\\\\[\\s\\S]|[^\`\\\\])*\`)|(\\b\\d+(?:\\.\\d+)?\\b)|([a-zA-Z_$][a-zA-Z0-9_$]*)|([{}()\\[\\],;.:])/g;

      return escaped.replace(tokenRegex, (match, comment, str, num, ident, punct) => {
        if (comment) return '<span class="hl-comment">' + comment + '</span>';
        if (str) return '<span class="hl-str">' + str + '</span>';
        if (num) return '<span class="hl-num">' + num + '</span>';
        if (ident) {
          if (keywords.has(ident)) return '<span class="hl-kw">' + ident + '</span>';
          if (/^[A-Z][a-zA-Z0-9_$]*$/.test(ident)) return '<span class="hl-type">' + ident + '</span>';
          return ident;
        }
        if (punct) return '<span class="hl-punct">' + punct + '</span>';
        return match;
      });
    }

    // Intentionally Scoped, Safe Markdown Formatter
    function renderSafeMarkdown(markdownText) {
      if (!markdownText) return '';

      // Step 1: Extract and replace code blocks with placeholder markers
      const codeBlocks = [];
      const codeBlockRegex = /\\x60\\x60\\x60([a-zA-Z0-9_-]*)\\n?([\\s\\S]*?)(?:\\x60\\x60\\x60|$)/g;

      let processed = markdownText.replace(codeBlockRegex, (match, lang, code) => {
        const id = codeBlocks.length;
        const cleanLang = lang.trim() || 'text';
        const highlighted = highlightCodeTokens(code.replace(/\\n$/, ''), cleanLang);
        const encodedRaw = encodeURIComponent(code.replace(/\\n$/, ''));
        codeBlocks.push({ id, cleanLang, highlighted, encodedRaw });
        return '@@@CODE_BLOCK_' + id + '@@@';
      });

      // Step 2: Escape all remaining HTML entities
      processed = escapeHtml(processed);

      // Step 3: Inline code \`code\`
      processed = processed.replace(/\\x60([^\\x60\\n]+)\\x60/g, '<code class="inline-code">$1</code>');

      // Step 4: Headings (# to ###)
      processed = processed.replace(/^### (.*$)/gim, '<h3>$1</h3>');
      processed = processed.replace(/^## (.*$)/gim, '<h2>$1</h2>');
      processed = processed.replace(/^# (.*$)/gim, '<h1>$1</h1>');

      // Step 5: Bold and Italic
      processed = processed.replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>');
      processed = processed.replace(/\\*([^\\*\\n]+)\\*/g, '<em>$1</em>');

      // Step 6: Blockquotes
      processed = processed.replace(/^\\> (.*$)/gim, '<blockquote>$1</blockquote>');

      // Step 7: Paragraphs & Newlines
      const paragraphs = processed.split(/\\n\\s*\\n/);
      const formattedHtml = paragraphs.map(p => {
        const trimmed = p.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('@@@CODE_BLOCK_') || trimmed.startsWith('<h') || trimmed.startsWith('<blockquote>')) {
          return trimmed;
        }
        return '<p>' + trimmed.replace(/\\n/g, '<br>') + '</p>';
      }).join('\\n');

      // Step 8: Re-insert safe code blocks with copy action buttons
      return formattedHtml.replace(/@@@CODE_BLOCK_(\\d+)@@@/g, (match, idStr) => {
        const block = codeBlocks[parseInt(idStr, 10)];
        if (!block) return '';
        return '<div class="code-block-wrapper">' +
          '<div class="code-block-header">' +
            '<span class="code-block-lang">' + escapeHtml(block.cleanLang) + '</span>' +
            '<button class="code-copy-btn" data-code="' + block.encodedRaw + '">' +
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>' +
              '<span>Copy code</span>' +
            '</button>' +
          '</div>' +
          '<pre class="code-block-content"><code>' + block.highlighted + '</code></pre>' +
        '</div>';
      });
    }

    // Helper: Headers with Optional Session Bearer Auth
    function getApiHeaders() {
      const headers = { 'Content-Type': 'application/json' };
      const apiKey = sessionStorage.getItem(SESSION_AUTH_KEY);
      if (apiKey) {
        headers['Authorization'] = 'Bearer ' + apiKey;
      }
      return headers;
    }

    // UI Error Banner Helper
    function showError(message) {
      if (!message) {
        elements.errorBanner.style.display = 'none';
        elements.errorBanner.textContent = '';
        return;
      }
      elements.errorBanner.textContent = message;
      elements.errorBanner.style.display = 'block';
    }

    // Connection & Health Status Management
    let healthAbortController = null;

    function setHealthStatus(status, label, tooltipDetails) {
      state.health.status = status;
      elements.statusDot.className = 'status-dot ' + status;
      elements.statusText.textContent = label;

      const activeModel = state.activeModel || 'qwen3-coder-30b';
      if (elements.statusModelName) {
        elements.statusModelName.textContent = activeModel;
      }

      let title = '';
      if (status === 'connected') {
        title = activeModel + ' • Connected' + (tooltipDetails ? ' (' + tooltipDetails + ')' : '') + ' • Click to test';
      } else if (status === 'checking') {
        title = activeModel + ' • Checking connection…' + (tooltipDetails ? ' (' + tooltipDetails + ')' : '');
      } else if (status === 'disconnected') {
        title = activeModel + ' • Disconnected' + (tooltipDetails ? ' (' + tooltipDetails + ')' : '') + ' • Click to retry';
      } else {
        title = activeModel + ' • Unavailable' + (tooltipDetails ? ' (' + tooltipDetails + ')' : '') + ' • Click to test';
      }
      elements.connectionStatus.setAttribute('title', title);
    }

    async function checkModelHealth(forceRefresh = false) {
      if (healthAbortController) {
        healthAbortController.abort();
        healthAbortController = null;
      }
      healthAbortController = new AbortController();
      state.health.isChecking = true;

      const activeModelId = state.activeModel;
      if (!activeModelId) {
        setHealthStatus('unavailable', 'No Model', 'No model selected');
        state.health.isChecking = false;
        return;
      }

      const activeModelObj = state.models.find(m => m.id === activeModelId);
      const providerId = activeModelObj ? (activeModelObj.owned_by || activeModelObj.id) : null;

      // Transition to checking state immediately
      setHealthStatus('checking', 'Checking…', providerId ? 'Provider: ' + providerId : '');

      try {
        const url = '/health' + (forceRefresh ? '?refresh=true' : '');
        const response = await fetch(url, {
          method: 'GET',
          headers: getApiHeaders(),
          signal: healthAbortController.signal,
        });

        // /health returns 200 (all healthy) or 207 (multi-status degraded)
        if (response.status !== 200 && response.status !== 207) {
          throw new Error('Relay health check returned HTTP ' + response.status);
        }

        const data = await response.json();
        const providers = data.providers || {};
        state.health.lastChecked = Date.now();

        if (providerId && providers[providerId]) {
          const hp = providers[providerId];
          state.health.providerId = providerId;
          state.health.latencyMs = hp.latencyMs || 0;
          state.health.errorMessage = hp.errorMessage || null;

          if (hp.isHealthy) {
            const timeStr = new Date(hp.lastChecked || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            setHealthStatus(
              'connected',
              'Connected',
              'Provider: ' + providerId + ' • Latency: ' + (hp.latencyMs || 0) + 'ms • Checked: ' + timeStr
            );
          } else {
            const timeStr = new Date(hp.lastChecked || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            setHealthStatus(
              'disconnected',
              'Disconnected',
              'Provider: ' + providerId + ' • Error: ' + (hp.errorMessage || 'Health check failed') + ' • Checked: ' + timeStr
            );
          }
        } else if (!providerId) {
          setHealthStatus('unavailable', 'Unavailable', 'Model not recognized by provider registry');
        } else {
          const knownProviders = Object.keys(providers);
          if (knownProviders.length === 1) {
            const singleP = providers[knownProviders[0]];
            if (singleP.isHealthy) {
              setHealthStatus('connected', 'Connected', 'Provider: ' + knownProviders[0] + ' • ' + (singleP.latencyMs || 0) + 'ms');
            } else {
              setHealthStatus('disconnected', 'Disconnected', 'Provider: ' + knownProviders[0] + ' • ' + (singleP.errorMessage || 'Failed'));
            }
          } else {
            setHealthStatus('unavailable', 'Unavailable', 'Provider "' + providerId + '" health status unknown');
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          return;
        }
        state.health.lastChecked = Date.now();
        state.health.errorMessage = err.message;
        setHealthStatus('disconnected', 'Disconnected', err.message || 'Connection failed');
      } finally {
        state.health.isChecking = false;
      }
    }

    let healthIntervalId = null;
    function startHealthMonitoring() {
      if (healthIntervalId) clearInterval(healthIntervalId);
      healthIntervalId = setInterval(() => {
        if (document.hidden || state.health.isChecking || state.isGenerating) return;

        const timeSinceLastCheck = Date.now() - state.health.lastChecked;
        if (state.health.status === 'connected' && timeSinceLastCheck > 60000) {
          // Stale guard: if last successful check is older than 60s, transition and refresh
          setHealthStatus('checking', 'Checking…', 'Refreshing stale status');
          checkModelHealth(true);
        } else {
          checkModelHealth(false);
        }
      }, 20000);
    }

    // Load Model Discovery
    async function loadModels() {
      setHealthStatus('checking', 'Checking…', 'Fetching models from Relay');
      showError('');
      try {
        const response = await fetch('/v1/models', {
          method: 'GET',
          headers: getApiHeaders(),
        });

        if (response.status === 401) {
          setHealthStatus('disconnected', 'Auth Required', 'Authentication required');
          showError('Relay gateway requires authentication. Please enter your RELAY_API_KEY in the Settings panel.');
          return;
        }

        if (!response.ok) {
          throw new Error('Failed to fetch models (HTTP ' + response.status + ')');
        }

        const data = await response.json();
        state.models = Array.isArray(data.data) ? data.data : [];

        elements.modelSelect.innerHTML = '';
        if (state.models.length === 0) {
          elements.modelSelect.innerHTML = '<option value="">No models available</option>';
          setHealthStatus('unavailable', 'No Models', 'No models configured');
          return;
        }

        let selected = '';
        for (const m of state.models) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.id + (m.owned_by ? ' (' + m.owned_by + ')' : '');
          elements.modelSelect.appendChild(opt);
          if (m.id === 'qwen3-coder-30b' || (!selected && m.id)) {
            selected = m.id;
          }
        }

        // Restore prior selection if still valid
        const savedModel = localStorage.getItem(STORAGE_CONFIG_KEY + '_model');
        if (savedModel && state.models.some(m => m.id === savedModel)) {
          selected = savedModel;
        }

        state.activeModel = selected;
        elements.modelSelect.value = selected;
        elements.statusModelName.textContent = selected;
        updateActiveModelInfo();
        await checkModelHealth(true);
      } catch (err) {
        setHealthStatus('disconnected', 'Disconnected', err.message || 'Network error');
        showError('Unable to connect to Relay gateway at /v1/models: ' + (err.message || 'Network error'));
      }
    }

    /**
     * Reads the model's max_model_len backend/vLLM metadata extension from GET /v1/models if available.
     * Model-agnostic: supports any OpenAI-compatible/vLLM model.
     */
    function getModelMaxContextLength(modelId) {
      if (!modelId || !Array.isArray(state.models)) return null;
      const m = state.models.find(item => {
        if (!item || !item.id) return false;
        if (item.id === modelId) return true;
        if (modelId.includes('/') && item.id === modelId.split('/')[1]) return true;
        if (item.id.includes('/') && item.id.endsWith('/' + modelId)) return true;
        return false;
      });
      if (!m) return null;
      if (typeof m.max_model_len === 'number' && m.max_model_len > 0) {
        return m.max_model_len;
      }
      return null;
    }

    /**
     * Conservative client-side token count estimation across message history.
     * Note: This is an intentionally conservative heuristic (~3.5 chars/token + formatting overhead),
     * not an exact BPE/sentencepiece tokenizer.
     */
    function estimateMessagesTokens(messages) {
      if (!Array.isArray(messages)) return 0;
      let totalChars = 0;
      for (const msg of messages) {
        if (!msg) continue;
        if (typeof msg.content === 'string') {
          totalChars += msg.content.length;
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && typeof part.text === 'string') totalChars += part.text.length;
            else if (typeof part === 'string') totalChars += part;
          }
        } else if (msg.content) {
          try {
            totalChars += JSON.stringify(msg.content).length;
          } catch {
            // Ignore serialization errors
          }
        }
      }
      const textTokens = Math.ceil(totalChars / 3.5);
      const framingOverhead = messages.length * 4 + 3;
      return textTokens + framingOverhead;
    }

    /**
     * Authoritative context budget calculation performed at request time.
     * Guarantees requested max_tokens never exceeds the available context budget
     * after accounting for input prompt/messages, while preserving the user's
     * configured state.maxTokens across model switches.
     */
    function calculateEffectiveMaxTokens(modelId, messages, requestedMaxTokens) {
      const maxModelLen = getModelMaxContextLength(modelId);
      const userMax = typeof requestedMaxTokens === 'number' && requestedMaxTokens > 0
        ? requestedMaxTokens
        : 2048;

      if (!maxModelLen) {
        return { effectiveMaxTokens: userMax, availableBudget: null, maxModelLen: null };
      }

      const estimatedInputTokens = estimateMessagesTokens(messages);
      const availableBudget = maxModelLen - estimatedInputTokens;

      if (availableBudget <= 0) {
        return {
          error:
            'Input messages (~' +
            estimatedInputTokens +
            ' tokens) exceed the model context length of ' +
            maxModelLen +
            ' tokens. Please shorten your prompt or clear conversation history.',
          estimatedInputTokens,
          availableBudget,
          maxModelLen,
        };
      }

      const effectiveMaxTokens = Math.min(userMax, availableBudget);
      return {
        effectiveMaxTokens,
        estimatedInputTokens,
        availableBudget,
        maxModelLen,
      };
    }

    function updateActiveModelInfo() {
      const active = state.models.find(m => m.id === state.activeModel);
      if (active) {
        elements.modelOwnerTag.textContent = active.owned_by || 'provider';
      } else {
        elements.modelOwnerTag.textContent = '';
      }

      // UI hint: reflect model capacity in input max attribute if available
      const maxModelLen = getModelMaxContextLength(state.activeModel);
      if (maxModelLen && maxModelLen > 0) {
        elements.maxTokensInput.max = String(maxModelLen);
      } else {
        elements.maxTokensInput.max = '8192';
      }
    }

    // Conversation State & UI Rendering
    function saveConversation() {
      try {
        const bounded = state.messages.length > 100 ? state.messages.slice(-100) : state.messages;
        localStorage.setItem(STORAGE_CHAT_KEY, JSON.stringify(bounded));
      } catch {
        // Ignore quota
      }
    }

    function loadConversation() {
      try {
        const raw = localStorage.getItem(STORAGE_CHAT_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            state.messages = parsed.slice(-100);
          }
        }
      } catch {
        state.messages = [];
      }
    }


    function renderConversation() {
      elements.messagesList.innerHTML = '';

      if (state.messages.length === 0) {
        renderEmptyState();
        return;
      }

      state.messages.forEach((msg, index) => {
        renderMessageNode(msg, index);
      });

      attachCopyEventListeners();
      if (state.autoScroll) {
        scrollToBottom();
      }
    }

    function renderEmptyState() {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty-state';

      const title = document.createElement('div');
      title.className = 'empty-title';
      title.textContent = 'Relay AI Playground';

      const desc = document.createElement('div');
      desc.className = 'empty-desc';
      desc.textContent = 'A unified coding and inference console powered by Relay. Queries route dynamically through Relay to your configured LLM backends.';

      const suggestionsDiv = document.createElement('div');
      suggestionsDiv.className = 'prompt-suggestions';

      const prompts = [
        'Explain the circuit breaker pattern in distributed systems',
        'Write a TypeScript debounce function with generics',
        'Implement quicksort in Python with type annotations',
        'Explain how SSE streaming differs from WebSockets',
      ];

      prompts.forEach(p => {
        const chip = document.createElement('button');
        chip.className = 'suggestion-chip';
        chip.textContent = p;
        chip.onclick = () => {
          elements.chatTextarea.value = p;
          autoResizeTextarea();
          sendMessage();
        };
        suggestionsDiv.appendChild(chip);
      });

      emptyDiv.appendChild(title);
      emptyDiv.appendChild(desc);
      emptyDiv.appendChild(suggestionsDiv);
      elements.messagesList.appendChild(emptyDiv);
    }

    function renderMessageNode(msg, index) {
      const row = document.createElement('div');
      row.className = 'message-row ' + msg.role;
      row.id = 'msg-node-' + index;

      const meta = document.createElement('div');
      meta.className = 'message-meta';

      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = msg.role === 'user' ? 'You' : (msg.model || 'Assistant');

      const time = document.createElement('span');
      time.textContent = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

      meta.appendChild(author);
      if (time.textContent) meta.appendChild(time);

      const bubble = document.createElement('div');
      bubble.className = 'message-bubble prose';
      bubble.id = 'msg-bubble-' + index;

      if (msg.role === 'assistant') {
        bubble.innerHTML = renderSafeMarkdown(msg.content);
        if (msg.isStreaming) {
          const cursor = document.createElement('span');
          cursor.className = 'streaming-cursor';
          bubble.appendChild(cursor);
        }
      } else {
        // User messages are safe text paragraphs
        const p = document.createElement('p');
        p.textContent = msg.content;
        bubble.appendChild(p);
      }

      // Actions
      const actions = document.createElement('div');
      actions.className = 'message-actions';

      if (msg.role === 'assistant') {
        const copyBtn = document.createElement('button');
        copyBtn.className = 'action-btn';
        copyBtn.textContent = 'Copy response';
        copyBtn.onclick = () => copyText(msg.content, copyBtn, 'Copied response!');
        actions.appendChild(copyBtn);

        if (index === state.messages.length - 1 && !state.isGenerating) {
          const regenBtn = document.createElement('button');
          regenBtn.className = 'action-btn';
          regenBtn.textContent = 'Regenerate';
          regenBtn.onclick = () => regenerateLastResponse();
          actions.appendChild(regenBtn);
        }
      } else if (msg.role === 'user') {
        const editBtn = document.createElement('button');
        editBtn.className = 'action-btn';
        editBtn.textContent = 'Edit';
        editBtn.onclick = () => {
          elements.chatTextarea.value = msg.content;
          autoResizeTextarea();
          elements.chatTextarea.focus();
        };
        actions.appendChild(editBtn);
      }

      row.appendChild(meta);
      row.appendChild(bubble);
      row.appendChild(actions);
      elements.messagesList.appendChild(row);
    }

    let renderFrameId = null;
    let pendingStreamingIndex = -1;
    let pendingStreamingContent = '';

    function flushStreamingBubble() {
      renderFrameId = null;
      if (pendingStreamingIndex < 0) return;
      const bubble = document.getElementById('msg-bubble-' + pendingStreamingIndex);
      if (!bubble) return;
      bubble.innerHTML = renderSafeMarkdown(pendingStreamingContent);
      const cursor = document.createElement('span');
      cursor.className = 'streaming-cursor';
      bubble.appendChild(cursor);
      if (state.autoScroll) {
        scrollToBottom();
      }
    }

    function updateStreamingAssistantBubble(index, content, isStreaming) {
      const bubble = document.getElementById('msg-bubble-' + index);
      if (!bubble) return;

      if (isStreaming) {
        pendingStreamingIndex = index;
        pendingStreamingContent = content;
        if (renderFrameId === null) {
          renderFrameId = requestAnimationFrame(flushStreamingBubble);
        }
      } else {
        if (renderFrameId !== null) {
          cancelAnimationFrame(renderFrameId);
          renderFrameId = null;
        }
        pendingStreamingIndex = -1;
        pendingStreamingContent = '';
        bubble.innerHTML = renderSafeMarkdown(content);
        attachCopyEventListeners();
        if (state.autoScroll) {
          scrollToBottom();
        }
      }
    }


    function attachCopyEventListeners() {
      document.querySelectorAll('.code-copy-btn').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const raw = decodeURIComponent(btn.getAttribute('data-code') || '');
          copyText(raw, btn, 'Copied!');
        };
      });
    }

    function copyText(text, buttonElement, successLabel) {
      const originalHtml = buttonElement.innerHTML;
      navigator.clipboard.writeText(text).then(() => {
        buttonElement.textContent = successLabel;
        setTimeout(() => {
          buttonElement.innerHTML = originalHtml;
        }, 1800);
      }).catch(() => {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        buttonElement.textContent = successLabel;
        setTimeout(() => {
          buttonElement.innerHTML = originalHtml;
        }, 1800);
      });
    }

    function scrollToBottom() {
      elements.messagesViewport.scrollTop = elements.messagesViewport.scrollHeight;
    }

    // Scroll Anchoring Detection
    elements.messagesViewport.addEventListener('scroll', () => {
      const threshold = 60;
      const distanceFromBottom = elements.messagesViewport.scrollHeight - elements.messagesViewport.scrollTop - elements.messagesViewport.clientHeight;
      state.autoScroll = distanceFromBottom < threshold;
      elements.scrollBottomBtn.style.display = state.autoScroll ? 'none' : 'block';
    });

    elements.scrollBottomBtn.onclick = () => {
      state.autoScroll = true;
      scrollToBottom();
    };

    // Textarea Auto-Resize & Character Counter
    function autoResizeTextarea() {
      elements.chatTextarea.style.height = 'auto';
      const newHeight = Math.min(elements.chatTextarea.scrollHeight, 220);
      elements.chatTextarea.style.height = Math.max(newHeight, 48) + 'px';

      const text = elements.chatTextarea.value;
      const chars = text.length;
      const estimatedTokens = Math.ceil(chars / 4);
      elements.charTokenCounter.textContent = estimatedTokens + ' tokens • ' + chars + ' chars';
    }

    elements.chatTextarea.addEventListener('input', autoResizeTextarea);

    // Keyboard Shortcuts
    elements.chatTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      } else if (e.key === 'Escape' && state.isGenerating) {
        e.preventDefault();
        stopGeneration();
      }
    });

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        clearChat();
      }
    });

    // Send Message / SSE Streaming Execution
    async function sendMessage() {
      const content = elements.chatTextarea.value.trim();
      if (!content || state.isGenerating) return;

      showError('');
      if (!state.activeModel) {
        showError('No model selected or available on Relay gateway.');
        return;
      }

      // Build candidate API messages to evaluate context budget
      const candidateMessages = [];
      if (state.systemPrompt) {
        candidateMessages.push({ role: 'system', content: state.systemPrompt });
      }
      for (const m of state.messages) {
        candidateMessages.push({ role: m.role, content: m.content });
      }
      candidateMessages.push({ role: 'user', content });

      // Authoritative request-time context budget calculation
      const budgetResult = calculateEffectiveMaxTokens(
        state.activeModel,
        candidateMessages,
        state.maxTokens,
      );

      if (budgetResult.error) {
        showError(budgetResult.error);
        return;
      }

      // Add user message
      state.messages.push({
        role: 'user',
        content,
        timestamp: Date.now(),
      });

      // Clear composer
      elements.chatTextarea.value = '';
      autoResizeTextarea();

      // Create empty assistant slot
      const assistantIndex = state.messages.length;
      state.messages.push({
        role: 'assistant',
        model: state.activeModel,
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
      });

      renderConversation();
      setGeneratingState(true);

      const payload = {
        model: state.activeModel,
        messages: candidateMessages,
        temperature: state.temperature,
        max_tokens: budgetResult.effectiveMaxTokens,
        stream: state.stream,
      };

      state.abortController = new AbortController();

      try {
        const response = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(payload),
          signal: state.abortController.signal,
        });

        if (response.status === 401) {
          throw new Error('Authentication required (HTTP 401). Please enter your RELAY_API_KEY in Settings.');
        }

        if (!response.ok) {
          const errBody = await response.json().catch(() => ({}));
          const errMsg = errBody.error?.message || 'Relay request failed with HTTP ' + response.status;
          throw new Error(errMsg);
        }

        if (state.stream) {
          // SSE Stream Consumption
          const reader = response.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';
          let assistantContent = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) continue;

              if (trimmed === 'data: [DONE]') {
                break;
              }

              if (trimmed.startsWith('data: ')) {
                const jsonStr = trimmed.slice(6);
                try {
                  const chunk = JSON.parse(jsonStr);
                  if (chunk.error) {
                    throw new Error(chunk.error.message || 'Stream error');
                  }
                  const delta = chunk.choices?.[0]?.delta?.content;
                  if (typeof delta === 'string') {
                    assistantContent += delta;
                    state.messages[assistantIndex].content = assistantContent;
                    updateStreamingAssistantBubble(assistantIndex, assistantContent, true);
                  }
                } catch (jsonErr) {
                  if (jsonErr.message && !jsonErr.message.includes('JSON')) {
                    throw jsonErr;
                  }
                }
              }
            }
          }

          state.messages[assistantIndex].isStreaming = false;
          updateStreamingAssistantBubble(assistantIndex, assistantContent, false);
        } else {
          // Non-streaming response
          const json = await response.json();
          const content = json.choices?.[0]?.message?.content || '';
          state.messages[assistantIndex].content = content;
          state.messages[assistantIndex].isStreaming = false;
          renderConversation();
        }

        // Request succeeded - update health status to connected
        setHealthStatus(
          'connected',
          'Connected',
          'Request succeeded at ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        );
        state.health.lastChecked = Date.now();
        saveConversation();
      } catch (err) {
        state.messages[assistantIndex].isStreaming = false;
        if (err.name === 'AbortError') {
          state.messages[assistantIndex].content += '\\n\\n*[Generation stopped by user]*';
          updateStreamingAssistantBubble(assistantIndex, state.messages[assistantIndex].content, false);
          saveConversation();
        } else {
          showError(err.message || 'An error occurred during chat completion.');
          // Chat completion failed (502, 503, 504, connection dropped, network error)
          setHealthStatus(
            'disconnected',
            'Disconnected',
            'Chat request failed: ' + (err.message || 'Connection error')
          );
          state.health.lastChecked = Date.now();
          if (!state.messages[assistantIndex].content) {
            // Remove empty assistant placeholder on immediate failure
            state.messages.splice(assistantIndex, 1);
            renderConversation();
          } else {
            updateStreamingAssistantBubble(assistantIndex, state.messages[assistantIndex].content, false);
          }
        }
      } finally {
        setGeneratingState(false);
      }
    }

    function stopGeneration() {
      if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
      }
      if (renderFrameId !== null) {
        cancelAnimationFrame(renderFrameId);
        renderFrameId = null;
      }
    }


    function setGeneratingState(generating) {
      state.isGenerating = generating;
      elements.sendMessageBtn.style.display = generating ? 'none' : 'inline-flex';
      elements.stopGenerationBtn.style.display = generating ? 'inline-flex' : 'none';
      elements.chatTextarea.disabled = generating;
      elements.clearChatBtn.disabled = generating;
    }

    function regenerateLastResponse() {
      if (state.isGenerating || state.messages.length === 0) return;
      if (state.messages[state.messages.length - 1].role === 'assistant') {
        state.messages.pop();
      }
      if (state.messages.length === 0) return;
      const lastUserMsg = state.messages.pop();
      elements.chatTextarea.value = lastUserMsg.content;
      autoResizeTextarea();
      sendMessage();
    }

    function clearChat() {
      if (state.isGenerating) return;
      state.messages = [];
      localStorage.removeItem(STORAGE_CHAT_KEY);
      renderConversation();
      showError('');
    }

    // Sidebar & Settings Configuration
    function loadSavedConfig() {
      try {
        const saved = localStorage.getItem(STORAGE_CONFIG_KEY);
        if (saved) {
          const cfg = JSON.parse(saved);
          if (typeof cfg.temperature === 'number') state.temperature = cfg.temperature;
          if (typeof cfg.maxTokens === 'number') state.maxTokens = cfg.maxTokens;
          if (typeof cfg.systemPrompt === 'string') state.systemPrompt = cfg.systemPrompt;
          if (typeof cfg.stream === 'boolean') state.stream = cfg.stream;
        }
      } catch {
        // Ignore
      }

      elements.tempSlider.value = state.temperature;
      elements.tempVal.textContent = state.temperature;
      elements.maxTokensInput.value = state.maxTokens;
      elements.maxTokensVal.textContent = state.maxTokens;
      elements.systemPromptInput.value = state.systemPrompt;
      elements.streamToggle.checked = state.stream;

      // Session auth key
      const sessionKey = sessionStorage.getItem(SESSION_AUTH_KEY) || '';
      elements.relayApiKeyInput.value = sessionKey;
    }

    function saveConfig() {
      const cfg = {
        temperature: state.temperature,
        maxTokens: state.maxTokens,
        systemPrompt: state.systemPrompt,
        stream: state.stream,
      };
      localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(cfg));
      if (state.activeModel) {
        localStorage.setItem(STORAGE_CONFIG_KEY + '_model', state.activeModel);
      }
    }

    // Event Listeners for Settings
    elements.modelSelect.addEventListener('change', () => {
      state.activeModel = elements.modelSelect.value;
      if (elements.statusModelName) {
        elements.statusModelName.textContent = state.activeModel;
      }
      updateActiveModelInfo();
      saveConfig();
      if (state.activeModel) {
        checkModelHealth(true);
      }
    });

    elements.tempSlider.addEventListener('input', () => {
      state.temperature = parseFloat(elements.tempSlider.value);
      elements.tempVal.textContent = state.temperature;
      saveConfig();
    });

    elements.maxTokensInput.addEventListener('input', () => {
      const val = parseInt(elements.maxTokensInput.value, 10);
      if (!isNaN(val) && val > 0) {
        state.maxTokens = val;
        elements.maxTokensVal.textContent = val;
        saveConfig();
      }
    });

    elements.systemPromptInput.addEventListener('input', () => {
      state.systemPrompt = elements.systemPromptInput.value;
      saveConfig();
    });

    elements.streamToggle.addEventListener('change', () => {
      state.stream = elements.streamToggle.checked;
      saveConfig();
    });

    elements.relayApiKeyInput.addEventListener('input', () => {
      const val = elements.relayApiKeyInput.value.trim();
      if (val) {
        sessionStorage.setItem(SESSION_AUTH_KEY, val);
      } else {
        sessionStorage.removeItem(SESSION_AUTH_KEY);
      }
      // Re-fetch models with new auth key
      loadModels();
    });

    elements.resetSettingsBtn.addEventListener('click', () => {
      state.temperature = 0.7;
      state.maxTokens = 2048;
      state.systemPrompt = 'You are a helpful and concise AI programming assistant.';
      state.stream = true;
      elements.tempSlider.value = 0.7;
      elements.tempVal.textContent = '0.7';
      elements.maxTokensInput.value = 2048;
      elements.maxTokensVal.textContent = '2048';
      elements.systemPromptInput.value = state.systemPrompt;
      elements.streamToggle.checked = true;
      saveConfig();
    });

    elements.toggleSidebarBtn.addEventListener('click', () => {
      elements.settingsSidebar.classList.toggle('collapsed');
    });

    elements.closeSidebarBtn.addEventListener('click', () => {
      elements.settingsSidebar.classList.add('collapsed');
    });

    elements.clearChatBtn.addEventListener('click', clearChat);
    elements.sendMessageBtn.addEventListener('click', sendMessage);
    elements.stopGenerationBtn.addEventListener('click', stopGeneration);

    // Connection Status Click & Keyboard Handlers
    elements.connectionStatus.addEventListener('click', () => {
      checkModelHealth(true);
    });

    elements.connectionStatus.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        checkModelHealth(true);
      }
    });

    // Page Visibility API: Re-verify health when tab becomes visible
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        const timeSinceLastCheck = Date.now() - state.health.lastChecked;
        if (timeSinceLastCheck > 15000) {
          checkModelHealth(true);
        }
      }
    });

    // Initial Startup
    loadSavedConfig();
    loadConversation();
    renderConversation();
    autoResizeTextarea();
    loadModels();
    startHealthMonitoring();
  </script>
</body>
</html>`;
}
