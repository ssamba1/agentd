// agentd PWA.
//
// Design rule that shapes everything here: the WebSocket is a hint, never the
// source of truth. iOS suspends sockets the moment the app backgrounds -- which
// is exactly when an approval you care about arrives -- so every view can
// rebuild itself from REST alone, and the socket only ever triggers a refetch.

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "hidden") el.hidden = !!v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const api = {
  async req(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  },
  get: (p) => api.req("GET", p),
  post: (p, b) => api.req("POST", p, b),
  del: (p) => api.req("DELETE", p),
};

const state = {
  route: { name: "sessions" },
  sessions: [],
  approvals: [],
  rules: [],
  health: null,
  events: [],
  openTools: new Set(),
  openFiles: new Set(),
};

function toast(text, ms = 2600) {
  const el = h("div", { class: "toast" }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

// ---------------------------------------------------------------- routing

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] === "s" && parts[1]) {
    return { name: "session", id: parts[1], tab: parts[2] || "chat" };
  }
  if (["approvals", "settings", "sessions", "new"].includes(parts[0])) return { name: parts[0] };
  return { name: "sessions" };
}

function go(hash) {
  location.hash = hash;
}

window.addEventListener("hashchange", async () => {
  state.route = parseHash();
  teardownTerminal();
  await refresh();
});

// ---------------------------------------------------------------- data

async function refresh() {
  const r = state.route;
  try {
    const jobs = [
      api.get("/health").then((d) => (state.health = d)),
      api.get("/approvals?status=pending").then((d) => (state.approvals = d)),
    ];
    if (r.name === "sessions" || r.name === "new") {
      jobs.push(api.get("/sessions").then((d) => (state.sessions = d)));
    }
    if (r.name === "settings") jobs.push(api.get("/rules").then((d) => (state.rules = d)));
    if (r.name === "session") {
      jobs.push(api.get(`/sessions/${r.id}`).then((d) => (state.session = d)));
      if (r.tab === "chat") {
        jobs.push(api.get(`/events?session=${r.id}`).then((d) => (state.events = d)));
      }
      if (r.tab === "diff") {
        jobs.push(
          api
            .get(`/sessions/${r.id}/diff`)
            .then((d) => (state.diff = d))
            .catch(() => (state.diff = { files: [], patch: "", truncated: false })),
        );
      }
    }
    await Promise.all(jobs);
  } catch (err) {
    toast(err.message);
  }
  render();
}

// ---------------------------------------------------------------- socket

let ws = null;
let wsRetry = 0;
let refreshTimer = null;

function scheduleRefresh() {
  // Bursty event streams would otherwise cause a refetch per message.
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 220);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    wsRetry = 0;
    setConn(true);
    // Always refetch on connect. The socket cannot tell us what we missed
    // while the app was suspended, so we never assume continuity.
    scheduleRefresh();
  };
  ws.onclose = () => {
    setConn(false);
    ws = null;
    wsRetry = Math.min(wsRetry + 1, 6);
    setTimeout(connect, 500 * 2 ** wsRetry);
  };
  ws.onerror = () => ws?.close();
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.kind === "hello" || msg.kind === "catchup") return;
    if (msg.kind === "approval.pending") toast("Approval needed");
    scheduleRefresh();
  };
}

function setConn(on) {
  const dot = $("#conn");
  dot.className = `dot ${on ? "on" : "off"}`;
}

// iOS kills the socket on background without firing a timely close event, so
// treat every return-to-foreground as "reconnect and refetch".
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    connect();
    refresh();
  }
});

// ---------------------------------------------------------------- views

function render() {
  const view = $("#view");
  const r = state.route;
  view.replaceChildren();
  $("#back").hidden = r.name !== "session";
  $("#back").onclick = () => go("#/sessions");

  const titles = {
    sessions: "Sessions",
    approvals: "Approvals",
    settings: "Settings",
    new: "New session",
    session: state.session?.title ?? "Session",
  };
  $("#title").textContent = titles[r.name] ?? "agentd";

  if (r.name === "sessions") viewSessions(view);
  else if (r.name === "approvals") viewApprovals(view);
  else if (r.name === "settings") viewSettings(view);
  else if (r.name === "new") viewNew(view);
  else if (r.name === "session") viewSession(view);

  renderNav();
}

function renderNav() {
  const n = state.approvals.length;
  const items = [
    ["sessions", "▤", "Sessions", "#/sessions"],
    ["approvals", "✔", "Approvals", "#/approvals"],
    ["settings", "⚙", "Settings", "#/settings"],
  ];
  const nav = $("#nav");
  nav.replaceChildren(
    ...items.map(([key, glyph, label, href]) =>
      h(
        "button",
        {
          class: state.route.name === key ? "sel" : "",
          onclick: () => go(href),
        },
        h("span", { class: "glyph" }, glyph, key === "approvals" && n > 0
          ? h("span", { class: "badge" }, n > 99 ? "99+" : n)
          : null),
        label,
      ),
    ),
  );
}

function viewSessions(view) {
  view.append(
    h("div", { class: "card" },
      h("button", { class: "btn primary wide", onclick: () => go("#/new") }, "+ New session")),
  );
  if (!state.sessions.length) {
    view.append(h("div", { class: "empty" }, "No sessions yet."));
    return;
  }
  for (const s of state.sessions) {
    view.append(
      h("div", { class: "card", onclick: () => go(`#/s/${s.id}/chat`) },
        h("div", { class: "row" },
          h("div", { style: "flex:1;font-weight:600;font-size:14px" }, s.title),
          s.pendingApprovals > 0 ? h("span", { class: "pill", style: "background:#3d2f10;color:#fbbf24" },
            `${s.pendingApprovals} waiting`) : null,
          h("span", { class: `pill ${s.status}` }, s.status),
        ),
        h("div", { class: "faint", style: "margin-top:5px" },
          [s.branch ? `⎇ ${s.branch}` : null, s.cwd, timeAgo(s.updated_at)].filter(Boolean).join("  ·  ")),
      ),
    );
  }
}

function viewNew(view) {
  const prompt = h("textarea", { class: "field", placeholder: "What should Claude do?", rows: 4 });
  const repo = h("input", { class: "field", placeholder: "Repo path (optional) — gets its own worktree" });
  const title = h("input", { class: "field", placeholder: "Title (optional)" });
  view.append(
    h("div", { class: "card" },
      h("h3", {}, "Start a session"),
      prompt,
      h("div", { style: "height:8px" }),
      repo,
      h("div", { style: "height:8px" }),
      title,
      h("div", { style: "height:12px" }),
      h("button", {
        class: "btn primary wide",
        onclick: async (e) => {
          if (!prompt.value.trim()) return toast("Prompt is required");
          e.target.disabled = true;
          try {
            const { id } = await api.post("/sessions", {
              prompt: prompt.value.trim(),
              repo: repo.value.trim() || undefined,
              title: title.value.trim() || undefined,
            });
            go(`#/s/${id}/chat`);
          } catch (err) {
            toast(err.message);
            e.target.disabled = false;
          }
        },
      }, "Start"),
    ),
  );
}

function viewApprovals(view) {
  if (!state.approvals.length) {
    view.append(h("div", { class: "empty" }, "Nothing waiting.\nClaude will ask here when it needs you."));
    return;
  }
  for (const a of state.approvals) view.append(approvalCard(a));
}

function approvalCard(a) {
  const input = safeParse(a.input_json) ?? {};
  const subject = primarySubject(a.tool_name, input);
  const remember = h("input", { type: "checkbox" });
  const rememberLabel = subject
    ? `Always for ${a.tool_name} starting "${clip(subject, 28)}"`
    : `Always allow ${a.tool_name}`;

  const decide = async (decision) => {
    try {
      await api.post(`/approvals/${a.id}/resolve`, {
        decision,
        remember: remember.checked
          ? subject
            ? { scope: "global", matchKind: "prefix", matchValue: subject }
            : { scope: "global", matchKind: "any" }
          : undefined,
      });
      await refresh();
    } catch (err) {
      toast(err.message);
      refresh();
    }
  };

  return h("div", { class: "card ap" },
    h("div", { class: "row" },
      h("span", { class: "tool" }, a.display_name || a.tool_name),
      h("span", { class: "sp", style: "flex:1" }),
      h("span", { class: "faint" }, timeAgo(a.created_at)),
    ),
    // The bridge does not always populate `title`, so fall back rather than
    // rendering an empty card.
    h("div", { class: "muted", style: "margin-top:4px" },
      a.title || a.description || `${a.tool_name} call`),
    h("pre", {}, subject || JSON.stringify(input, null, 2)),
    a.blocked_path ? h("div", { class: "faint" }, `Blocked path: ${a.blocked_path}`) : null,
    a.decision_reason ? h("div", { class: "faint" }, a.decision_reason) : null,
    h("label", { class: "remember" }, remember, rememberLabel),
    h("div", { class: "acts" },
      h("button", { class: "btn bad", onclick: () => decide("deny") }, "Deny"),
      h("button", { class: "btn ok", onclick: () => decide("allow") }, "Allow"),
    ),
  );
}

function viewSession(view) {
  const s = state.session;
  const r = state.route;
  if (!s) return void view.append(h("div", { class: "empty" }, "Loading…"));

  const tabs = ["chat", "diff", "term"];
  view.append(
    h("div", { class: "card", style: "display:flex;gap:6px;padding:8px" },
      ...tabs.map((t) =>
        h("button", {
          class: `btn ${r.tab === t ? "primary" : ""}`,
          style: "flex:1;padding:8px",
          onclick: () => go(`#/s/${s.id}/${t}`),
        }, { chat: "Chat", diff: "Diff", term: "Terminal" }[t]),
      ),
    ),
  );

  const mine = state.approvals.filter((a) => a.session_id === s.id);
  for (const a of mine) view.append(approvalCard(a));

  if (r.tab === "chat") sessionChat(view, s);
  else if (r.tab === "diff") sessionDiff(view, s);
  else sessionTerm(view, s);
}

function sessionChat(view, s) {
  const stream = h("div", {});
  for (const ev of state.events) {
    const payload = safeParse(ev.payload);
    if (!payload) continue;
    if (ev.kind === "session.input") {
      stream.append(h("div", { class: "msg user" },
        h("div", { class: "who" }, "You"), h("div", { class: "body" }, payload.text)));
      continue;
    }
    if (ev.kind !== "sdk.assistant") continue;
    const content = payload.message?.content ?? [];
    for (const block of content) {
      if (block.type === "text" && block.text?.trim()) {
        stream.append(h("div", { class: "msg" },
          h("div", { class: "who" }, "Claude"), h("div", { class: "body" }, block.text)));
      } else if (block.type === "tool_use") {
        // Tool calls collapse by default -- on a phone an expanded tool log
        // buries the actual conversation.
        const key = `${ev.id}:${block.id}`;
        const open = state.openTools.has(key);
        stream.append(h("div", {
          class: "tool-line",
          onclick: () => { open ? state.openTools.delete(key) : state.openTools.add(key); render(); },
        }, h("span", { class: "caret" }, open ? "▼" : "▶"),
           h("span", {}, `${block.name}  ${clip(primarySubject(block.name, block.input ?? {}), 46)}`)));
        if (open) {
          stream.append(h("div", { class: "tool-detail mono" }, JSON.stringify(block.input, null, 2)));
        }
      }
    }
  }
  if (!stream.children.length) stream.append(h("div", { class: "empty" }, "No messages yet."));
  view.append(stream);
  view.append(composer(s));
  requestAnimationFrame(() => { $("#view").scrollTop = $("#view").scrollHeight; });
}

function composer(s) {
  const box = h("textarea", { class: "field", rows: 1, placeholder: "Reply…" });
  box.addEventListener("input", () => {
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 140)}px`;
  });

  const send = async () => {
    const text = box.value.trim();
    if (!text) return;
    box.value = "";
    box.style.height = "auto";
    try {
      await api.post(`/sessions/${s.id}/message`, { text });
      await refresh();
    } catch (err) {
      if (/not accepting input/.test(err.message)) {
        try {
          await api.post(`/sessions/${s.id}/resume`, { prompt: text });
          toast("Resumed session");
          await refresh();
          return;
        } catch (e2) {
          toast(e2.message);
          return;
        }
      }
      toast(err.message);
    }
  };

  const micBtn = h("button", { title: "Dictate" }, "🎙");
  const bar = h("div", { class: "composer" }, box, micBtn,
    h("button", { class: "send", onclick: send }, "Send"));

  wireDictation(micBtn, box);
  return bar;
}

// Web Speech API. Supported in Safari on iOS but not universally, so the
// button only appears when the API is actually present.
function wireDictation(btn, box) {
  const Rec = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Rec) {
    btn.hidden = true;
    return;
  }
  let rec = null;
  btn.onclick = () => {
    if (rec) {
      rec.stop();
      return;
    }
    rec = new Rec();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    const base = box.value;
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      box.value = (base ? `${base} ` : "") + text;
    };
    const stop = () => {
      rec = null;
      btn.classList.remove("rec");
    };
    rec.onend = stop;
    rec.onerror = (e) => { toast(`Dictation: ${e.error}`); stop(); };
    try {
      rec.start();
      btn.classList.add("rec");
    } catch {
      stop();
    }
  };
}

function sessionDiff(view, s) {
  const d = state.diff;
  if (!d || !d.files.length) {
    view.append(h("div", { class: "empty" }, "No uncommitted changes."));
    return;
  }
  const byFile = splitPatch(d.patch);
  view.append(h("div", { class: "card" },
    h("div", { class: "row" },
      h("div", { style: "flex:1" }, `${d.files.length} file${d.files.length === 1 ? "" : "s"} changed`),
      h("span", { class: "plus" }, `+${d.files.reduce((n, f) => n + Math.max(0, f.added), 0)}`),
      h("span", { class: "minus" }, `−${d.files.reduce((n, f) => n + Math.max(0, f.removed), 0)}`),
    ),
    d.truncated ? h("div", { class: "faint", style: "margin-top:6px" }, "Patch truncated — open a terminal for the full diff.") : null,
  ));

  for (const f of d.files) {
    const open = state.openFiles.has(f.path);
    const card = h("div", { class: "dfile" },
      h("div", {
        class: "hd",
        onclick: () => { open ? state.openFiles.delete(f.path) : state.openFiles.add(f.path); render(); },
      },
        h("span", { class: "st" }, f.status),
        h("span", { class: "nm mono" }, f.path),
        f.added < 0 ? h("span", { class: "faint" }, "binary")
          : [h("span", { class: "plus" }, `+${f.added}`), h("span", { class: "minus" }, `−${f.removed}`)],
      ),
    );
    if (open) {
      const body = byFile.get(f.path);
      card.append(h("pre", { class: "hunk mono" },
        ...(body ?? ["(no textual diff)"]).map((line) =>
          h("div", { class: line[0] === "+" ? "a" : line[0] === "-" ? "d" : line.startsWith("@@") ? "h" : "" }, line)),
      ));
    }
    view.append(card);
  }
}

// ---------------------------------------------------------------- terminal

let term = null;
let termSock = null;
let fit = null;

function teardownTerminal() {
  termSock?.close();
  termSock = null;
  term?.dispose();
  term = null;
  fit = null;
}

function sessionTerm(view, s) {
  const host = h("div", { id: "term", style: "height:60vh" });
  view.append(host);
  requestAnimationFrame(() => {
    term = new window.Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      theme: { background: "#0f1115", foreground: "#e6e9ef" },
      cursorBlink: true,
    });
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try { fit.fit(); } catch { /* zero-size container during transitions */ }

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    termSock = new WebSocket(`${proto}//${location.host}/pty?session=${s.id}`);
    termSock.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "data") term.write(msg.data);
      else if (msg.type === "ready") sendResize();
      else if (msg.type === "exit") term.write(`\r\n[exited ${msg.exitCode}]\r\n`);
      else if (msg.type === "error") term.write(`\r\n[${msg.error}]\r\n`);
    };
    termSock.onclose = () => term?.write("\r\n[disconnected]\r\n");
    term.onData((d) => termSock?.readyState === WebSocket.OPEN
      && termSock.send(JSON.stringify({ type: "data", data: d })));

    const sendResize = () => {
      try { fit.fit(); } catch { return; }
      if (termSock?.readyState === WebSocket.OPEN) {
        termSock.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    window.addEventListener("resize", sendResize);
  });
}

// ---------------------------------------------------------------- settings

function viewSettings(view) {
  const hp = state.health ?? {};
  view.append(h("div", { class: "card" },
    h("h3", {}, "Daemon"),
    kv("Live sessions", hp.liveSessions ?? "—"),
    kv("Parked approvals", hp.parkedApprovals ?? "—"),
    kv("Approval TTL", hp.approvalTtlSec ? `${hp.approvalTtlSec}s` : "—"),
    kv("Push", hp.pushEnabled ? "available" : "unavailable"),
    kv("Uptime", hp.uptimeSec ? `${Math.round(hp.uptimeSec / 60)}m` : "—"),
  ));

  view.append(h("div", { class: "card" },
    h("h3", {}, "Notifications"),
    h("div", { class: "muted" },
      "Install to the Home Screen first — iOS only delivers Web Push to an installed PWA."),
    h("div", { style: "height:10px" }),
    h("button", { class: "btn wide", onclick: enablePush }, "Enable notifications"),
    h("div", { style: "height:8px" }),
    h("button", {
      class: "btn wide",
      onclick: async () => {
        try { const r = await api.post("/push/test"); toast(`Sent ${r.sent}, pruned ${r.pruned}`); }
        catch (e) { toast(e.message); }
      },
    }, "Send test notification"),
  ));

  const rules = h("div", { class: "card" }, h("h3", {}, "Standing rules"));
  if (!state.rules.length) rules.append(h("div", { class: "muted" }, "None. Approvals will always ask."));
  for (const r of state.rules) {
    rules.append(h("div", { class: "row", style: "padding:7px 0;border-top:1px solid var(--line)" },
      h("div", { style: "flex:1" },
        h("div", { class: "mono", style: "font-size:12.5px" },
          `${r.action === "allow" ? "✅" : "⛔"} ${r.tool_name}${r.match_kind === "any" ? " (any)" : ` ${r.match_kind} "${clip(r.match_value ?? "", 24)}"`}`),
        h("div", { class: "faint" }, `${r.session_id ? "this session" : "global"} · ${r.hits} hit${r.hits === 1 ? "" : "s"}`)),
      h("button", {
        class: "iconbtn",
        onclick: async () => { await api.del(`/rules/${r.id}`); refresh(); },
      }, "Delete"),
    ));
  }
  view.append(rules);
}

function kv(k, v) {
  return h("div", { class: "row", style: "padding:4px 0" },
    h("div", { class: "muted", style: "flex:1" }, k), h("div", { class: "mono" }, String(v)));
}

async function enablePush() {
  try {
    if (!("serviceWorker" in navigator)) return toast("No service worker support");
    if (!("PushManager" in window)) {
      return toast("Push unavailable. On iOS, add to Home Screen first.");
    }
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    // Must be called from a user gesture, which is why this lives on a button.
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return toast(`Permission ${perm}`);

    const { publicKey, enabled } = await api.get("/push/key");
    if (!enabled) return toast("Push is disabled on the daemon");

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true, // iOS allows no silent push
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const json = sub.toJSON();
    await api.post("/push/subscribe", {
      endpoint: json.endpoint,
      keys: json.keys,
      label: navigator.userAgent.slice(0, 60),
    });
    toast("Notifications enabled");
    refresh();
  } catch (err) {
    toast(err.message);
  }
}

function urlBase64ToUint8Array(b64) {
  const padded = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// ---------------------------------------------------------------- helpers

const PRIMARY = {
  Bash: "command", Read: "file_path", Edit: "file_path", Write: "file_path",
  NotebookEdit: "notebook_path", Glob: "pattern", Grep: "pattern",
  WebFetch: "url", WebSearch: "query", Task: "description",
};

function primarySubject(tool, input) {
  const f = PRIMARY[tool];
  if (f && typeof input?.[f] === "string") return input[f];
  return "";
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function clip(s, n) { return !s ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s; }

function timeAgo(ms) {
  const d = Math.max(0, Date.now() - ms) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

/** Split a unified diff into per-file line arrays for the file cards. */
function splitPatch(patch) {
  const out = new Map();
  let cur = null;
  for (const line of (patch ?? "").split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      cur = [];
      out.set(m[2], cur);
      continue;
    }
    if (!cur) continue;
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) continue;
    cur.push(line);
  }
  return out;
}

// ---------------------------------------------------------------- boot

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
state.route = parseHash();
connect();
refresh();
