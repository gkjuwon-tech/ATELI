export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>ateli — dashboard</title>
<style>
  :root { color-scheme: light dark; --mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
  * { box-sizing: border-box; }
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; }
  header { padding: 12px 16px; border-bottom: 1px solid #8884; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .muted { color: #8888; font-size: 12px; }
  main { display: grid; grid-template-columns: 360px 1fr; height: calc(100vh - 49px); }
  #list { border-right: 1px solid #8884; overflow-y: auto; }
  .task { padding: 10px 12px; border-bottom: 1px solid #8882; cursor: pointer; }
  .task:hover { background: #8881; }
  .task.active { background: #4af2; }
  .task .id { font-family: var(--mono); font-size: 11px; color: #8888; }
  .task .prompt { font-weight: 500; margin-top: 2px; }
  .task .meta { font-size: 11px; color: #8888; margin-top: 4px; display: flex; gap: 8px; }
  .pill { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 11px; }
  .pending { background: #8884; }
  .running { background: #4af4; color: #4af; }
  .succeeded { background: #4a44; color: #4a4; }
  .failed { background: #f444; color: #f44; }
  .cancelled { background: #8888; }
  #detail { overflow-y: auto; padding: 16px; font-family: var(--mono); font-size: 12px; white-space: pre-wrap; }
  .ev { padding: 4px 0; }
  .ev .label { color: #8aa; }
  .ev.error .label { color: #f66; }
  .ev .body { color: inherit; }
  form { padding: 12px; border-top: 1px solid #8884; display: grid; gap: 8px; }
  input, textarea, button { font: inherit; padding: 6px 8px; border: 1px solid #8884; border-radius: 4px; background: transparent; color: inherit; }
  textarea { resize: vertical; min-height: 60px; font-family: var(--mono); }
  button { cursor: pointer; background: #4af4; border-color: #4af8; }
  button:hover { background: #4af8; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .empty { color: #8888; padding: 24px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>ateli</h1>
  <span class="muted" id="status">connecting…</span>
</header>
<main>
  <aside id="list">
    <form id="new">
      <input id="prompt" placeholder="Task prompt" required />
      <input id="workspace" placeholder="Workspace path (or leave blank for repo)" />
      <input id="repo" placeholder="owner/repo (optional, opens PR)" />
      <input id="base" placeholder="base branch (default: main)" />
      <button type="submit">Start task</button>
    </form>
    <div id="tasks"><div class="empty">no tasks yet</div></div>
  </aside>
  <section id="detail"><div class="empty">select a task</div></section>
</main>
<script>
const state = { active: null, tasks: [], evtSource: null };

async function refresh() {
  const r = await fetch("/v1/tasks");
  const j = await r.json();
  state.tasks = j.tasks;
  renderList();
}

function renderList() {
  const el = document.getElementById("tasks");
  if (state.tasks.length === 0) {
    el.innerHTML = '<div class="empty">no tasks yet</div>';
    return;
  }
  el.innerHTML = state.tasks.map(t => {
    const when = new Date(t.created_at).toLocaleString();
    return \`<div class="task \${state.active===t.id?'active':''}" data-id="\${t.id}">
      <div class="id">\${t.id}</div>
      <div class="prompt">\${escape(t.prompt)}</div>
      <div class="meta">
        <span class="pill \${t.status}">\${t.status}</span>
        <span>\${when}</span>
        <span>\${t.input_tokens}↑ / \${t.output_tokens}↓ tok</span>
      </div>
    </div>\`;
  }).join("");
  for (const el of document.querySelectorAll(".task")) {
    el.onclick = () => select(el.dataset.id);
  }
}

async function select(id) {
  state.active = id;
  renderList();
  const detail = document.getElementById("detail");
  detail.innerHTML = "loading…";
  const r = await fetch("/v1/tasks/" + id);
  const j = await r.json();
  detail.innerHTML = "";
  for (const m of j.messages) {
    appendEv(detail, m.role, m.content);
  }
  if (state.evtSource) state.evtSource.close();
  if (j.task.status === "pending" || j.task.status === "running") {
    state.evtSource = new EventSource("/v1/tasks/" + id + "/events");
    state.evtSource.onmessage = e => {
      try {
        const ev = JSON.parse(e.data);
        renderEvent(detail, ev);
        if (ev.type === "task_finished") {
          state.evtSource.close();
          refresh();
        }
      } catch {}
    };
  }
}

function renderEvent(detail, ev) {
  switch (ev.type) {
    case "turn_started":
      appendEv(detail, "turn", "— turn " + ev.turn + " —");
      break;
    case "assistant_text":
      appendEv(detail, "assistant", ev.text);
      break;
    case "tool_call":
      appendEv(detail, "tool", ev.tool_name + " " + JSON.stringify(ev.input));
      break;
    case "tool_result":
      appendEv(detail, ev.is_error ? "result-err" : "result",
        "(" + ev.duration_ms + "ms) " + ev.output.slice(0, 800));
      break;
    case "usage":
      appendEv(detail, "usage", ev.input_tokens + "↑ / " + ev.output_tokens + "↓ tokens");
      break;
    case "task_finished":
      appendEv(detail, "done", ev.task.status);
      break;
  }
  detail.scrollTop = detail.scrollHeight;
}

function appendEv(detail, label, body) {
  const d = document.createElement("div");
  d.className = "ev" + (label === "result-err" ? " error" : "");
  d.innerHTML = '<span class="label">[' + label + '] </span><span class="body"></span>';
  d.querySelector(".body").textContent = typeof body === "string" ? body : JSON.stringify(body);
  detail.appendChild(d);
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

document.getElementById("new").onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    prompt: document.getElementById("prompt").value,
    workspace: document.getElementById("workspace").value || undefined,
    repo: document.getElementById("repo").value || undefined,
    base: document.getElementById("base").value || undefined,
  };
  if (!body.workspace && !body.repo) {
    alert("Provide a workspace path or a repo");
    return;
  }
  const r = await fetch("/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    alert("failed: " + (await r.text()));
    return;
  }
  const j = await r.json();
  document.getElementById("prompt").value = "";
  await refresh();
  select(j.task.id);
};

document.getElementById("status").textContent = "ready";
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
