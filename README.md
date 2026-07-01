# Therapy Goal Companion

A local AI therapy-support app with a Python backend, vanilla frontend, SQLite memory, session summaries, and a local model adapter for:

- `POST http://localhost:1234/api/v1/chat`
- model `psychotherapy-llm_psychocounsel-llama3-8b`

It is designed for goal identification, commitment building, and therapy-style reflection. It is not a replacement for a licensed clinician or emergency support.

## Features

- Chat UI with session history.
- Local SQLite memory palace for goals, values, barriers, supports, and recurring themes.
- Method-of-Loci inspired room architecture with verbatim drawer storage for each chat turn.
- Per-session summaries.
- Commitment tracking from phrases like `I will...`, `I commit to...`, or `my next step is...`.
- Intervention selection across CBT, DBT, Solution-Focused Therapy, MBCT, ACT, and Narrative Therapy.
- Comprehensive quizzes:
	- Mental health screening quiz (PHQ-9 style + GAD-7 style + stress/function items).
	- Life-goals discovery quiz (Wheel-of-Life style domains + readiness/barrier profiling).
- Quiz scoring with intervention selection and life-goal recommendations.
- LM Studio interpretation of quiz results for a practical 7-day plan.
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
- `GET /api/palace`
- `GET /api/quizzes`
- `POST /api/quiz/submit`
- `PATCH /api/commitment/:id`

## Quiz Behavior

- The screening quiz returns a **screening impression**, not a formal diagnosis.
- The life-goals quiz prioritizes domains with high importance and low satisfaction.
- Based on quiz scores, the app selects top interventions (CBT/DBT/SFT/MBCT/ACT/Narrative),
  then asks LM Studio to generate practical guidance and a 7-day plan.
- Goal quiz results are stored into local memory and can auto-create commitments.

## Evidence References

- PHQ-9 overview and cut points: https://www.hiv.uw.edu/page/mental-health-screening/phq-9
- GAD-7 overview and cut points: https://www.hiv.uw.edu/page/mental-health-screening/gad-7
- Wheel of Life coaching concept: https://positivepsychology.com/wheel-of-life/
- SMART goals framework: https://www.mindtools.com/a4wo118/smart-goals

## Memory Design

The app uses a simple local "memory palace" structure:

- Durable memories: goals, values, barriers, supports, themes.
- Session memory: recent transcript and per-session summary.
- Action memory: commitments with confidence and status.
- Palace rooms: goals, values, barriers, supports, commitments, safety, reflection.
- Palace drawers: verbatim message chunks automatically filed into rooms and recalled per query.

Relevant durable memories are retrieved for every reply and injected into the system prompt sent to the local LLM.
