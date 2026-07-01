# Therapy Goal Companion

A local AI therapy-support app with a Python backend, vanilla frontend, SQLite memory, session summaries, and a local model adapter for:

- `POST http://localhost:1234/api/v1/chat`
- model `psychotherapy-llm_psychocounsel-llama3-8b`

It is designed for goal identification, commitment building, and therapy-style reflection. It is not a replacement for a licensed clinician or emergency support.

## Features

- Chat UI with session history.
- Local SQLite memory palace for goals, values, barriers, supports, and recurring themes.
- Per-session summaries.
- Commitment tracking from phrases like `I will...`, `I commit to...`, or `my next step is...`.
- Intervention selection across CBT, DBT, Solution-Focused Therapy, MBCT, ACT, and Narrative Therapy.
- Crisis-aware responses that encourage emergency or trusted-person support when needed.
- Fallback mode if the local model server is offline.

## Run

```powershell
.\.venv\Scripts\python.exe app.py
```

Open:

```text
http://127.0.0.1:8080
```

Optional environment variables:

```powershell
$env:LOCAL_LLM_URL = "http://localhost:1234/api/v1/chat"
$env:LOCAL_LLM_MODEL = "psychotherapy-llm_psychocounsel-llama3-8b"
$env:PORT = "8080"
```

## Backend API

- `GET /api/health`
- `GET /api/sessions`
- `POST /api/session`
- `GET /api/session/:id`
- `DELETE /api/session/:id`
- `POST /api/chat`
- `POST /api/summarize`
- `GET /api/memory`
- `PATCH /api/commitment/:id`

## Memory Design

The app uses a simple local "memory palace" structure:

- Durable memories: goals, values, barriers, supports, themes.
- Session memory: recent transcript and per-session summary.
- Action memory: commitments with confidence and status.

Relevant durable memories are retrieved for every reply and injected into the system prompt sent to the local LLM.
