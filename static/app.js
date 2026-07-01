const state = {
  sessionId: localStorage.getItem("therapy-session-id"),
  sessions: [],
  messages: [],
  commitments: [],
  quizTemplates: {},
  quizScales: {},
  quizReferences: [],
  activeQuizId: null,
};

const fallbackQuizCatalog = {
  scales: {
    freq_0_3: [
      { value: 0, label: "Not at all" },
      { value: 1, label: "Several days" },
      { value: 2, label: "More than half the days" },
      { value: 3, label: "Nearly every day" },
    ],
    agree_0_4: [
      { value: 0, label: "Strongly disagree" },
      { value: 1, label: "Disagree" },
      { value: 2, label: "Neutral" },
      { value: 3, label: "Agree" },
      { value: 4, label: "Strongly agree" },
    ],
    rate_0_10: Array.from({ length: 11 }, (_, i) => ({ value: i, label: String(i) })),
  },
  templates: {
    diagnosis: {
      id: "diagnosis",
      title: "Mental Health Screening Quiz",
      description: "Structured screening for symptom burden and intervention planning.",
      disclaimer: "Screening aid only, not a formal diagnosis.",
      sections: [
        {
          title: "Depressive symptoms",
          scale: "freq_0_3",
          questions: [
            { id: "phq_1", text: "Little interest or pleasure in doing things." },
            { id: "phq_2", text: "Feeling down, depressed, or hopeless." },
            { id: "phq_3", text: "Trouble sleeping or sleeping too much." },
            { id: "phq_4", text: "Feeling tired or low energy." },
            { id: "phq_5", text: "Poor appetite or overeating." },
            { id: "phq_6", text: "Feeling bad about yourself or like a failure." },
            { id: "phq_7", text: "Trouble concentrating on tasks." },
            { id: "phq_8", text: "Moving slowly or feeling restless." },
            { id: "phq_9", text: "Thoughts of being better off dead or self-harm." },
          ],
        },
        {
          title: "Anxiety symptoms",
          scale: "freq_0_3",
          questions: [
            { id: "gad_1", text: "Feeling nervous, anxious, or on edge." },
            { id: "gad_2", text: "Not being able to stop or control worrying." },
            { id: "gad_3", text: "Worrying too much about different things." },
            { id: "gad_4", text: "Trouble relaxing." },
            { id: "gad_5", text: "Restlessness, hard to sit still." },
            { id: "gad_6", text: "Becoming easily annoyed or irritable." },
            { id: "gad_7", text: "Feeling afraid that something awful may happen." },
          ],
        },
      ],
    },
    goals: {
      id: "goals",
      title: "Life Goals Discovery Quiz",
      description: "Prioritizes high-impact life domains and next actions.",
      disclaimer: "Coaching support for goals, not perfection.",
      sections: [
        {
          title: "Satisfaction",
          scale: "rate_0_10",
          questions: [
            { id: "sat_health", text: "Health and energy satisfaction." },
            { id: "sat_relationships", text: "Relationships satisfaction." },
            { id: "sat_career", text: "Career or studies satisfaction." },
            { id: "sat_meaning", text: "Meaning and purpose satisfaction." },
          ],
        },
        {
          title: "Importance",
          scale: "rate_0_10",
          questions: [
            { id: "imp_health", text: "Health and energy importance." },
            { id: "imp_relationships", text: "Relationships importance." },
            { id: "imp_career", text: "Career or studies importance." },
            { id: "imp_meaning", text: "Meaning and purpose importance." },
          ],
        },
      ],
    },
  },
  references: [
    { name: "PHQ-9", url: "https://www.hiv.uw.edu/page/mental-health-screening/phq-9" },
    { name: "GAD-7", url: "https://www.hiv.uw.edu/page/mental-health-screening/gad-7" },
  ],
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
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  })[char]);
}

function formatText(value) {
  const text = escapeHtml(extractDisplayText(value));
  return text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>");
}

function extractDisplayText(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return text;
  try {
    return extractFromEnvelope(JSON.parse(text)) || text;
  } catch {
    return text;
  }
}

function extractFromEnvelope(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(extractFromEnvelope).filter(Boolean).join("\n").trim();
  }
  if (!value || typeof value !== "object") return "";
  for (const key of ["response", "output", "message", "content", "text"]) {
    const extracted = extractFromEnvelope(value[key]);
    if (extracted) return extracted;
  }
  if (Array.isArray(value.choices)) {
    return extractFromEnvelope(value.choices[0]);
  }
  return "";
}

function formattedBlock(value) {
  return `<p>${formatText(value || "")}</p>`;
}

function renderMessages() {
  $("messages").innerHTML = state.messages.map((message) => `
    <article class="message ${message.role}" data-message-index="${message.index}">
      <div class="avatar">${message.role === "user" ? "You" : "AI"}</div>
      <div class="bubble">${formattedBlock(message.content)}</div>
    </article>
  `).join("");
  $("messages").scrollTop = $("messages").scrollHeight;
}

function normalizeMessageIndexes() {
  state.messages = state.messages.map((message, index) => ({ ...message, index }));
}

function updateMessageContent(index, content) {
  const message = state.messages[index];
  if (!message) return;
  message.content = content;
  const bubble = document.querySelector(`[data-message-index="${index}"] .bubble`);
  if (bubble) {
    bubble.innerHTML = formattedBlock(content);
    $("messages").scrollTop = $("messages").scrollHeight;
  }
}

async function streamAssistantMessage(index, fullText) {
  updateMessageContent(index, "");
  const chunkSize = fullText.length > 900 ? 8 : 4;
  for (let cursor = 0; cursor < fullText.length; cursor += chunkSize) {
    updateMessageContent(index, fullText.slice(0, cursor + chunkSize));
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
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
  const rooms = payload.rooms || [];
  const roomsMarkup = rooms.length
    ? `<div class="room-grid">${rooms.map((room) => `
      <article class="room-chip">
        <strong>${escapeHtml(room.name)}</strong>
        <span>${escapeHtml(String(room.drawer_count || 0))} drawers</span>
      </article>
    `).join("")}</div>`
    : "";

  const memoriesMarkup = memories.slice(0, 10).map((memory) => `
    <article class="memory">
      <span>${escapeHtml(memory.kind)}</span>
      <p>${escapeHtml(memory.content)}</p>
    </article>
  `).join("") || "<p class='muted'>The app stores goals, values, barriers, supports, and recurring themes locally.</p>";

  $("memories").innerHTML = `${roomsMarkup}${memoriesMarkup}`;
}

function renderInterventions(items) {
  $("interventions").innerHTML = items.map((item) => `
    <span title="${escapeHtml(item.rationale)}">${escapeHtml(item.name)}</span>
  `).join("");
}

function renderQuizReferences() {
  if (!state.quizReferences.length) return "";
  return `
    <details class="quiz-references">
      <summary>References</summary>
      <ul>
        ${state.quizReferences.map((item) => `
          <li><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.name)}</a></li>
        `).join("")}
      </ul>
    </details>
  `;
}

function renderScale(questionId, scaleId) {
  const options = state.quizScales[scaleId] || [];
  return `<div class="quiz-scale">${options.map((option) => `
    <label>
      <input type="radio" name="${escapeHtml(questionId)}" value="${escapeHtml(String(option.value))}" required />
      <span>${escapeHtml(option.label)}</span>
    </label>
  `).join("")}</div>`;
}

function renderQuiz(quizId) {
  const quiz = state.quizTemplates[quizId];
  if (!quiz) {
    $("quizContainer").innerHTML = "<p class='muted'>Quiz templates unavailable.</p>";
    return;
  }
  state.activeQuizId = quizId;
  $("quizResult").innerHTML = "";
  $("quizContainer").innerHTML = `
    <form id="quizForm" class="quiz-form">
      <h3>${escapeHtml(quiz.title)}</h3>
      <p class="muted">${escapeHtml(quiz.description || "")}</p>
      <p class="quiz-disclaimer">${escapeHtml(quiz.disclaimer || "")}</p>
      ${quiz.sections.map((section) => `
        <section class="quiz-section">
          <h4>${escapeHtml(section.title)}</h4>
          ${section.questions.map((question) => `
            <article class="quiz-question">
              <p>${escapeHtml(question.text)}</p>
              ${renderScale(question.id, section.scale)}
            </article>
          `).join("")}
        </section>
      `).join("")}
      <button type="submit" class="primary">Submit Quiz</button>
      ${renderQuizReferences()}
    </form>
  `;
  $("quizForm").addEventListener("submit", submitQuiz);
}

function collectQuizAnswers(quiz) {
  const form = $("quizForm");
  const answers = {};
  const missing = [];
  quiz.sections.forEach((section) => {
    section.questions.forEach((question) => {
      const selected = form.querySelector(`input[name="${question.id}"]:checked`);
      if (!selected) {
        missing.push(question.text);
        return;
      }
      answers[question.id] = Number(selected.value);
    });
  });
  return { answers, missing };
}

function renderQuizResult(payload) {
  const scoring = payload.scoring || {};
  const interventions = (payload.interventions || []).map((item) => item.name).join(", ");
  let scoreMarkup = "";

  if (scoring.quiz_type === "diagnosis") {
    const scores = scoring.scores || {};
    scoreMarkup = `
      <div class="quiz-score-grid">
        <article><strong>PHQ-9</strong><span>${escapeHtml(String(scores.phq9 || 0))} (${escapeHtml(scores.phq9_level || "n/a")})</span></article>
        <article><strong>GAD-7</strong><span>${escapeHtml(String(scores.gad7 || 0))} (${escapeHtml(scores.gad7_level || "n/a")})</span></article>
        <article><strong>Stress</strong><span>${escapeHtml(String(scores.stress || 0))} (${escapeHtml(scores.stress_level || "n/a")})</span></article>
        <article><strong>Risk</strong><span>${escapeHtml(payload.risk_level || "low")}</span></article>
      </div>
    `;
  }

  if (scoring.quiz_type === "goals") {
    const top = scoring.top_domains || [];
    scoreMarkup = `
      <div class="quiz-score-grid">
        ${(top.slice(0, 3).map((item) => `
          <article>
            <strong>${escapeHtml(item.label || "Domain")}</strong>
            <span>Importance ${escapeHtml(String(item.importance || 0))} / Satisfaction ${escapeHtml(String(item.satisfaction || 0))}</span>
          </article>
        `).join(""))}
      </div>
    `;
  }

  $("quizResult").innerHTML = `
    <article class="quiz-output">
      <h3>Quiz Guidance</h3>
      <p class="muted"><strong>Selected interventions:</strong> ${escapeHtml(interventions || "n/a")}</p>
      ${scoreMarkup}
      ${formattedBlock(payload.ai_analysis || "No AI guidance returned.")}
    </article>
  `;
}

async function submitQuiz(event) {
  event.preventDefault();
  const quiz = state.quizTemplates[state.activeQuizId];
  if (!quiz) return;

  const { answers, missing } = collectQuizAnswers(quiz);
  if (missing.length) {
    alert("Please answer all quiz questions before submitting.");
    return;
  }

  if (!state.sessionId) {
    await createSession();
  }

  const payload = await api("/api/quiz/submit", {
    method: "POST",
    body: JSON.stringify({
      session_id: state.sessionId,
      quiz_type: state.activeQuizId,
      answers,
    }),
  });

  $("modelStatus").textContent = payload.model_status || "local-model";
  $("summary").innerHTML = formattedBlock(payload.summary || "No summary yet.");
  $("riskPill").textContent = `${payload.risk_level || "low"} risk`;
  $("riskPill").className = `risk-pill ${payload.risk_level || "low"}`;
  renderInterventions(payload.interventions || []);
  renderQuizResult(payload);

  if (payload.session?.id) {
    state.sessionId = payload.session.id;
    localStorage.setItem("therapy-session-id", state.sessionId);
    await loadSession(state.sessionId);
    await loadSessions();
    await loadMemory();
  }
}

async function loadQuizzes() {
  try {
    const payload = await api("/api/quizzes");
    state.quizTemplates = payload.templates || {};
    state.quizScales = payload.scales || {};
    state.quizReferences = payload.references || [];
    return true;
  } catch {
    state.quizTemplates = fallbackQuizCatalog.templates;
    state.quizScales = fallbackQuizCatalog.scales;
    state.quizReferences = fallbackQuizCatalog.references;
    $("modelStatus").textContent = "Quiz API unavailable: using local fallback templates";
    return false;
  }
}

async function launchQuiz(quizId) {
  if (!state.quizTemplates[quizId]) {
    await loadQuizzes();
  }
  renderQuiz(quizId);
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
  normalizeMessageIndexes();
  state.commitments = payload.commitments;
  $("sessionTitle").textContent = payload.session.title;
  $("summary").innerHTML = formattedBlock(payload.session.summary || "No summary yet.");
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
    $("summary").innerHTML = formattedBlock("Start by sharing what feels important, stuck, or worth changing.");
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
  $("summary").innerHTML = formattedBlock("Start by sharing what feels important, stuck, or worth changing.");
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
  normalizeMessageIndexes();
  const assistantIndex = state.messages.length - 1;
  renderMessages();

  const payload = await api("/api/chat", {
    method: "POST",
    body: JSON.stringify({ session_id: state.sessionId, message }),
  });

  $("modelStatus").textContent = payload.model_status;
  $("summary").innerHTML = formattedBlock(payload.summary || "No summary yet.");
  $("riskPill").textContent = `${payload.risk_level} risk`;
  $("riskPill").className = `risk-pill ${payload.risk_level}`;
  renderInterventions(payload.interventions || []);
  await streamAssistantMessage(assistantIndex, payload.reply || "");
  state.sessionId = payload.session.id;
  localStorage.setItem("therapy-session-id", state.sessionId);
  $("sessionTitle").textContent = payload.session.title;
  await loadSessions();
  await loadMemory();
}

async function refreshSummary() {
  if (!state.sessionId) return;
  const payload = await api("/api/summarize", {
    method: "POST",
    body: JSON.stringify({ session_id: state.sessionId }),
  });
  $("summary").innerHTML = formattedBlock(payload.summary || "No summary yet.");
  await loadSessions();
}

async function boot() {
  try {
    const health = await api("/api/health");
    $("modelStatus").textContent = `Model: ${health.model}`;
  } catch {
    $("modelStatus").textContent = "Backend unavailable";
  }
  await loadQuizzes();
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
$("loadDiagnosisQuiz").addEventListener("click", () => launchQuiz("diagnosis"));
$("loadGoalsQuiz").addEventListener("click", () => launchQuiz("goals"));

boot();
