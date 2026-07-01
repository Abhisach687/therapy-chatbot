const state = {
  sessionId: localStorage.getItem("therapy-session-id"),
  sessions: [],
  messages: [],
  commitments: [],
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json();
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  })[char]);
}

function renderMessages() {
  $("messages").innerHTML = state.messages.map((message) => `
    <article class="message ${message.role}">
      <div class="avatar">${message.role === "user" ? "You" : "AI"}</div>
      <div class="bubble">${escapeHtml(message.content).replace(/\n/g, "<br>")}</div>
    </article>
  `).join("");
  $("messages").scrollTop = $("messages").scrollHeight;
}

function renderSessions() {
  $("sessions").innerHTML = state.sessions.map((session) => `
    <article class="session-row ${session.id === state.sessionId ? "active" : ""}">
      <button class="session-item" data-session="${session.id}">
        <strong>${escapeHtml(session.title)}</strong>
        <span>${new Date(session.updated_at).toLocaleString()}</span>
      </button>
      <button class="delete-session" data-delete-session="${session.id}" aria-label="Delete session">Delete</button>
    </article>
  `).join("") || "<p class='muted'>No sessions yet.</p>";

  document.querySelectorAll("[data-session]").forEach((button) => {
    button.addEventListener("click", () => loadSession(button.dataset.session));
  });
  document.querySelectorAll("[data-delete-session]").forEach((button) => {
    button.addEventListener("click", () => deleteSession(button.dataset.deleteSession));
  });
}

function renderCommitments() {
  $("commitments").innerHTML = state.commitments.map((item) => `
    <article class="commitment">
      <div>
        <strong>${escapeHtml(item.action)}</strong>
        <p>${escapeHtml(item.goal)} · ${escapeHtml(item.schedule)} · confidence ${item.confidence}/10</p>
      </div>
      <button data-commitment="${item.id}" data-status="${item.status === "done" ? "active" : "done"}">
        ${item.status === "done" ? "Reopen" : "Done"}
      </button>
    </article>
  `).join("") || "<p class='muted'>Commitments appear when you write “I will...” or “I commit to...”.</p>";

  document.querySelectorAll("[data-commitment]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/commitment/${button.dataset.commitment}`, {
        method: "PATCH",
        body: JSON.stringify({ status: button.dataset.status }),
      });
      await loadSession(state.sessionId);
      await loadMemory();
    });
  });
}

function renderMemory(payload) {
  const memories = payload.memories || [];
  $("memories").innerHTML = memories.slice(0, 10).map((memory) => `
    <article class="memory">
      <span>${escapeHtml(memory.kind)}</span>
      <p>${escapeHtml(memory.content)}</p>
    </article>
  `).join("") || "<p class='muted'>The app stores goals, values, barriers, supports, and recurring themes locally.</p>";
}

function renderInterventions(items) {
  $("interventions").innerHTML = items.map((item) => `
    <span title="${escapeHtml(item.rationale)}">${escapeHtml(item.name)}</span>
  `).join("");
}

async function loadSessions() {
  const payload = await api("/api/sessions");
  state.sessions = payload.sessions;
  renderSessions();
}

async function loadMemory() {
  const payload = await api("/api/memory");
  renderMemory(payload);
}

async function loadSession(id) {
  if (!id) return;
  const payload = await api(`/api/session/${id}`);
  if (!payload.session) {
    if (state.sessionId === id) {
      localStorage.removeItem("therapy-session-id");
      state.sessionId = null;
    }
    return;
  }
  state.sessionId = id;
  localStorage.setItem("therapy-session-id", id);
  state.messages = payload.messages;
  state.commitments = payload.commitments;
  $("sessionTitle").textContent = payload.session.title;
  $("summary").textContent = payload.session.summary || "No summary yet.";
  $("riskPill").textContent = `${payload.session.risk_level} risk`;
  $("riskPill").className = `risk-pill ${payload.session.risk_level}`;
  renderMessages();
  renderCommitments();
  renderSessions();
}

async function deleteSession(id) {
  const session = state.sessions.find((item) => item.id === id);
  const label = session?.title || "this session";
  if (!confirm(`Delete "${label}"? This removes its transcript, commitments, and memories created from it.`)) {
    return;
  }

  await api(`/api/session/${id}`, { method: "DELETE" });
  if (state.sessionId === id) {
    localStorage.removeItem("therapy-session-id");
    state.sessionId = null;
    state.messages = [];
    state.commitments = [];
    $("summary").textContent = "Start by sharing what feels important, stuck, or worth changing.";
    $("sessionTitle").textContent = "Current session";
    $("riskPill").textContent = "Low risk";
    $("riskPill").className = "risk-pill";
    renderMessages();
    renderCommitments();
  }

  await loadSessions();
  await loadMemory();
  if (!state.sessionId) {
    if (state.sessions.length) {
      await loadSession(state.sessions[0].id);
    } else {
      await createSession();
    }
  }
}

async function createSession() {
  const payload = await api("/api/session", { method: "POST", body: "{}" });
  state.sessionId = payload.session.id;
  localStorage.setItem("therapy-session-id", state.sessionId);
  state.messages = [];
  state.commitments = [];
  $("summary").textContent = "Start by sharing what feels important, stuck, or worth changing.";
  renderMessages();
  renderCommitments();
  await loadSessions();
  await loadSession(state.sessionId);
}

async function sendMessage(event) {
  event.preventDefault();
  const input = $("messageInput");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";

  if (!state.sessionId) {
    await createSession();
  }

  state.messages.push({ role: "user", content: message });
  state.messages.push({ role: "assistant", content: "Thinking with your memory and current therapy focus..." });
  renderMessages();

  const payload = await api("/api/chat", {
    method: "POST",
    body: JSON.stringify({ session_id: state.sessionId, message }),
  });

  $("modelStatus").textContent = payload.model_status;
  $("summary").textContent = payload.summary || "No summary yet.";
  $("riskPill").textContent = `${payload.risk_level} risk`;
  $("riskPill").className = `risk-pill ${payload.risk_level}`;
  renderInterventions(payload.interventions || []);
  await loadSession(payload.session.id);
  await loadSessions();
  await loadMemory();
}

async function refreshSummary() {
  if (!state.sessionId) return;
  const payload = await api("/api/summarize", {
    method: "POST",
    body: JSON.stringify({ session_id: state.sessionId }),
  });
  $("summary").textContent = payload.summary || "No summary yet.";
  await loadSessions();
}

async function boot() {
  try {
    const health = await api("/api/health");
    $("modelStatus").textContent = `Model: ${health.model}`;
  } catch {
    $("modelStatus").textContent = "Backend unavailable";
  }
  await loadSessions();
  await loadMemory();
  if (state.sessionId) {
    await loadSession(state.sessionId);
  } else {
    await createSession();
  }
}

$("chatForm").addEventListener("submit", sendMessage);
$("newSession").addEventListener("click", createSession);
$("summarize").addEventListener("click", refreshSummary);

boot();
