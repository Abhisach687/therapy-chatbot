from __future__ import annotations

import json
import os
import re
import sqlite3
import textwrap
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "therapist_memory.sqlite3"

LOCAL_LLM_URL = os.getenv("LOCAL_LLM_URL", "http://localhost:1234/api/v1/chat")
LOCAL_LLM_MODEL = os.getenv("LOCAL_LLM_MODEL", "psychotherapy-llm_psychocounsel-llama3-8b")


THERAPY_APPROACHES = {
    "CBT": {
        "signals": ("thought", "overthink", "negative", "belief", "distortion", "worry", "anxiety"),
        "use": "identify automatic thoughts, test evidence, and design a balanced next thought",
    },
    "DBT": {
        "signals": ("intense", "urge", "emotion", "panic", "anger", "self harm", "impulsive"),
        "use": "stabilize emotions, name urges, and choose distress-tolerance or regulation skills",
    },
    "SFT": {
        "signals": ("goal", "stuck", "solution", "next step", "change", "progress"),
        "use": "clarify preferred future, find exceptions, and commit to a small observable step",
    },
    "MBCT": {
        "signals": ("ruminate", "mindful", "present", "body", "breath", "depressed", "loop"),
        "use": "shift from fusion with thoughts into present-moment awareness",
    },
    "ACT": {
        "signals": ("values", "meaning", "avoid", "accept", "committed", "purpose"),
        "use": "connect pain to values and choose committed action",
    },
    "Narrative": {
        "signals": ("story", "identity", "always", "never", "who i am", "failure", "broken"),
        "use": "externalize the problem and develop a richer story of agency",
    },
}

CRISIS_TERMS = (
    "suicide",
    "kill myself",
    "end my life",
    "self-harm",
    "self harm",
    "hurt myself",
    "can't go on",
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def init_db() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript(
            """
            create table if not exists sessions (
                id text primary key,
                title text not null,
                created_at text not null,
                updated_at text not null,
                summary text not null default '',
                risk_level text not null default 'low'
            );

            create table if not exists messages (
                id integer primary key autoincrement,
                session_id text not null,
                role text not null,
                content text not null,
                created_at text not null,
                foreign key(session_id) references sessions(id)
            );

            create table if not exists memories (
                id integer primary key autoincrement,
                kind text not null,
                label text not null,
                content text not null,
                source_session_id text not null,
                confidence real not null default 0.65,
                created_at text not null,
                updated_at text not null
            );

            create table if not exists commitments (
                id integer primary key autoincrement,
                session_id text not null,
                goal text not null,
                action text not null,
                schedule text not null,
                confidence integer not null,
                status text not null default 'active',
                created_at text not null,
                updated_at text not null
            );
            """
        )


def db_rows(query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(query, params).fetchall()]


def db_one(query: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    rows = db_rows(query, params)
    return rows[0] if rows else None


def db_exec(query: str, params: tuple[Any, ...] = ()) -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(query, params)
        conn.commit()


def ensure_session(session_id: str | None) -> str:
    if session_id and db_one("select id from sessions where id = ?", (session_id,)):
        return session_id

    new_id = str(uuid.uuid4())
    stamp = now_iso()
    db_exec(
        "insert into sessions (id, title, created_at, updated_at) values (?, ?, ?, ?)",
        (new_id, "New therapy session", stamp, stamp),
    )
    return new_id


def add_message(session_id: str, role: str, content: str) -> None:
    db_exec(
        "insert into messages (session_id, role, content, created_at) values (?, ?, ?, ?)",
        (session_id, role, content, now_iso()),
    )
    db_exec("update sessions set updated_at = ? where id = ?", (now_iso(), session_id))
    if role == "user":
        session = db_one("select title from sessions where id = ?", (session_id,))
        if session and session["title"] == "New therapy session":
            title = clean_sentence(content)[:48] or "Therapy session"
            db_exec("update sessions set title = ? where id = ?", (title, session_id))


def recent_messages(session_id: str, limit: int = 16) -> list[dict[str, Any]]:
    rows = db_rows(
        "select role, content, created_at from messages where session_id = ? order by id desc limit ?",
        (session_id, limit),
    )
    return list(reversed(rows))


def all_messages(session_id: str) -> list[dict[str, Any]]:
    return db_rows(
        "select role, content, created_at from messages where session_id = ? order by id asc",
        (session_id,),
    )


def pick_interventions(text: str) -> list[dict[str, str]]:
    lower = text.lower()
    scored: list[tuple[int, str, dict[str, str]]] = []
    for name, data in THERAPY_APPROACHES.items():
        score = sum(1 for signal in data["signals"] if signal in lower)
        if score:
            scored.append((score, name, {"name": name, "rationale": data["use"]}))
    if not scored:
        return [
            {"name": "SFT", "rationale": THERAPY_APPROACHES["SFT"]["use"]},
            {"name": "ACT", "rationale": THERAPY_APPROACHES["ACT"]["use"]},
        ]
    scored.sort(reverse=True, key=lambda item: item[0])
    return [item[2] for item in scored[:3]]


def risk_level(text: str) -> str:
    lower = text.lower()
    if any(term in lower for term in CRISIS_TERMS):
        return "high"
    if any(term in lower for term in ("hopeless", "worthless", "unsafe", "desperate")):
        return "elevated"
    return "low"


def extract_memories(session_id: str, user_text: str) -> list[dict[str, str]]:
    patterns = [
        ("goal", r"\b(?:i want to|i need to|my goal is|i would like to)\s+([^.!?\n]{4,160})"),
        ("value", r"\b(?:i value|important to me is|what matters is)\s+([^.!?\n]{4,160})"),
        ("barrier", r"\b(?:i struggle with|i am struggling with|my problem is|i avoid)\s+([^.!?\n]{4,160})"),
        ("support", r"\b(?:helps me|supports me|i can rely on)\s+([^.!?\n]{4,160})"),
    ]
    found: list[dict[str, str]] = []
    for kind, pattern in patterns:
        for match in re.finditer(pattern, user_text, flags=re.IGNORECASE):
            content = clean_sentence(match.group(1))
            if len(content) < 4:
                continue
            label = content[:64]
            found.append({"kind": kind, "label": label, "content": content})

    if not found and len(user_text.split()) >= 10:
        if any(word in user_text.lower() for word in ("because", "always", "never", "afraid", "worried")):
            found.append({"kind": "theme", "label": "Recurring theme", "content": clean_sentence(user_text[:220])})

    stamp = now_iso()
    for item in found[:5]:
        db_exec(
            """
            insert into memories (kind, label, content, source_session_id, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?)
            """,
            (item["kind"], item["label"], item["content"], session_id, stamp, stamp),
        )
    return found[:5]


def clean_sentence(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip(" .,\n\t")


def relevant_memories(user_text: str, limit: int = 8) -> list[dict[str, Any]]:
    words = {word for word in re.findall(r"[a-zA-Z]{4,}", user_text.lower())}
    memories = db_rows("select * from memories order by updated_at desc limit 80")
    scored: list[tuple[int, dict[str, Any]]] = []
    for memory in memories:
        haystack = f"{memory['kind']} {memory['label']} {memory['content']}".lower()
        score = sum(1 for word in words if word in haystack)
        if score or memory["kind"] in ("goal", "value", "barrier"):
            scored.append((score, memory))
    scored.sort(key=lambda item: (item[0], item[1]["updated_at"]), reverse=True)
    return [item[1] for item in scored[:limit]]


def build_system_prompt(memories: list[dict[str, Any]], interventions: list[dict[str, str]], session_summary: str) -> str:
    memory_lines = "\n".join(
        f"- {memory['kind']}: {memory['content']}" for memory in memories
    ) or "- No durable memories yet."
    intervention_lines = "\n".join(
        f"- {item['name']}: {item['rationale']}" for item in interventions
    )
    return textwrap.dedent(
        f"""
        You are a careful AI therapy support chatbot, not a replacement for a licensed clinician.
        Your job is to help the user identify core issues, clarify therapy goals, and commit to small values-aligned actions.

        Safety:
        - If the user may be in immediate danger or mentions self-harm, urge them to contact local emergency services or a trusted person now.
        - Do not diagnose. Use reflective, collaborative language.

        Session memory summary:
        {session_summary or "No summary yet."}

        Relevant long-term memory palace:
        {memory_lines}

        Selected therapy interventions for this reply:
        {intervention_lines}

        Response shape:
        1. Reflect the core issue in 1-2 warm sentences.
        2. Name the intervention you are using and why.
        3. Ask one focused therapy question.
        4. Offer one tiny commitment experiment with a confidence rating prompt.
        Keep it practical, non-judgmental, and concise.
        """
    ).strip()


def call_local_llm(system_prompt: str, input_text: str) -> str:
    payload = {
        "model": LOCAL_LLM_MODEL,
        "system_prompt": system_prompt,
        "input": input_text,
    }
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        LOCAL_LLM_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        raw = response.read().decode("utf-8")
    parsed = json.loads(raw)
    extracted = extract_llm_text(parsed)
    if extracted:
        return extracted
    return raw


def extract_llm_text(parsed: Any) -> str:
    if isinstance(parsed, str):
        return parsed
    if isinstance(parsed, list):
        parts = [extract_llm_text(item) for item in parsed]
        return "\n".join(part for part in parts if part).strip()
    if not isinstance(parsed, dict):
        return ""

    for key in ("response", "output", "message", "content", "text"):
        value = parsed.get(key)
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            extracted = extract_llm_text(value)
            if extracted:
                return extracted
        if isinstance(value, dict):
            extracted = extract_llm_text(value)
            if extracted:
                return extracted

    if isinstance(parsed.get("choices"), list):
        choice = parsed["choices"][0]
        if isinstance(choice, dict):
            message = choice.get("message")
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                return message["content"]
            if isinstance(choice.get("text"), str):
                return choice["text"]
    return ""


def fallback_reply(user_text: str, interventions: list[dict[str, str]], risk: str) -> str:
    if risk == "high":
        return (
            "I am really glad you said this out loud. If you might hurt yourself or cannot stay safe, "
            "please contact local emergency services now or reach out to someone trusted who can be with you. "
            "For this moment, move away from anything you could use to harm yourself and send one person: "
            "\"I am not safe alone right now. Can you stay with me?\""
        )

    primary = interventions[0]["name"]
    if primary == "CBT":
        question = "What is the strongest automatic thought here, and what evidence slightly softens it?"
        action = "Write one balanced thought you can reread tonight."
    elif primary == "DBT":
        question = "What emotion and urge are loudest right now, from 0 to 10?"
        action = "Try 60 seconds of paced breathing before choosing your next move."
    elif primary == "ACT":
        question = "What value is this pain pointing toward?"
        action = "Choose one 5-minute action that honors that value today."
    elif primary == "Narrative":
        question = "If this problem had a name, what would it be trying to convince you of?"
        action = "Write one sentence that separates you from the problem."
    elif primary == "MBCT":
        question = "Where do you notice this in your body right now?"
        action = "Spend one minute naming sensations without fixing them."
    else:
        question = "What would be the smallest sign this is 1 percent better by tomorrow?"
        action = "Pick one visible step and rate your confidence from 0 to 10."

    return (
        f"What I hear is that something important needs attention, and we can make it concrete without forcing a huge leap. "
        f"I would start with {primary} because it fits the way you described the issue.\n\n"
        f"Focused question: {question}\n\n"
        f"Tiny commitment experiment: {action} What confidence rating would you give that, 0 to 10?"
    )


def summarize_session(session_id: str) -> str:
    messages = all_messages(session_id)
    if not messages:
        return ""
    transcript = "\n".join(f"{m['role']}: {m['content']}" for m in messages[-24:])
    prompt = (
        "Summarize this therapy support session in JSON-like bullets: core issues, emotions, "
        "goals, interventions used, commitments, and next session focus. Be concise."
    )
    try:
        summary = call_local_llm(prompt, transcript)
    except Exception:
        user_lines = [m["content"] for m in messages if m["role"] == "user"]
        goals = [m["content"] for m in db_rows("select goal || ' -> ' || action as content from commitments where session_id = ?", (session_id,))]
        summary = "Core themes: " + clean_sentence(" ".join(user_lines[-3:])[:500])
        if goals:
            summary += "\nCommitments: " + "; ".join(goals[-3:])
    db_exec("update sessions set summary = ?, updated_at = ? where id = ?", (summary, now_iso(), session_id))
    return summary


def maybe_create_commitment(session_id: str, user_text: str) -> dict[str, Any] | None:
    lower = user_text.lower()
    if not any(marker in lower for marker in ("i will", "i commit", "my next step", "i can do", "tomorrow i")):
        return None
    goal_match = re.search(r"(?:goal is|want to|need to)\s+([^.!?\n]{4,120})", user_text, re.IGNORECASE)
    action_match = re.search(r"(?:i will|i commit to|my next step is|i can)\s+([^.!?\n]{4,140})", user_text, re.IGNORECASE)
    goal = clean_sentence(goal_match.group(1)) if goal_match else "Build momentum on the issue discussed"
    action = clean_sentence(action_match.group(1)) if action_match else clean_sentence(user_text[:140])
    schedule = "Next 24 hours" if "tomorrow" in lower or "today" in lower else "Before next check-in"
    confidence_match = re.search(r"\b([0-9]|10)\s*/?\s*10\b", user_text)
    confidence = int(confidence_match.group(1)) if confidence_match else 7
    stamp = now_iso()
    db_exec(
        """
        insert into commitments (session_id, goal, action, schedule, confidence, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
        """,
        (session_id, goal, action, schedule, confidence, stamp, stamp),
    )
    return db_one("select * from commitments where session_id = ? order by id desc limit 1", (session_id,))


class TherapyHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/api/health":
            self.json_response({"ok": True, "model_url": LOCAL_LLM_URL, "model": LOCAL_LLM_MODEL})
            return
        if self.path == "/api/sessions":
            sessions = db_rows("select * from sessions order by updated_at desc")
            self.json_response({"sessions": sessions})
            return
        if self.path.startswith("/api/session/"):
            session_id = self.path.rsplit("/", 1)[-1]
            self.json_response(
                {
                    "session": db_one("select * from sessions where id = ?", (session_id,)),
                    "messages": all_messages(session_id),
                    "commitments": db_rows("select * from commitments where session_id = ? order by created_at desc", (session_id,)),
                }
            )
            return
        if self.path == "/api/memory":
            self.json_response(
                {
                    "memories": db_rows("select * from memories order by updated_at desc"),
                    "commitments": db_rows("select * from commitments order by updated_at desc"),
                }
            )
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path == "/api/chat":
            body = self.read_json()
            user_text = clean_sentence(str(body.get("message", "")))
            if not user_text:
                self.json_response({"error": "Message is required."}, HTTPStatus.BAD_REQUEST)
                return

            session_id = ensure_session(body.get("session_id"))
            add_message(session_id, "user", user_text)
            memories = relevant_memories(user_text)
            new_memories = extract_memories(session_id, user_text)
            interventions = pick_interventions(user_text)
            risk = risk_level(user_text)
            db_exec("update sessions set risk_level = ? where id = ?", (risk, session_id))
            session = db_one("select * from sessions where id = ?", (session_id,))
            context_messages = "\n".join(f"{m['role']}: {m['content']}" for m in recent_messages(session_id))
            system_prompt = build_system_prompt(memories + new_memories, interventions, session["summary"] if session else "")
            input_text = f"Current conversation:\n{context_messages}\n\nUser's newest message:\n{user_text}"

            try:
                assistant_text = call_local_llm(system_prompt, input_text)
                model_status = "local-model"
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
                assistant_text = fallback_reply(user_text, interventions, risk)
                model_status = f"fallback: {exc.__class__.__name__}"

            if risk == "high" and "emergency" not in assistant_text.lower():
                assistant_text = fallback_reply(user_text, interventions, risk) + "\n\n" + assistant_text

            add_message(session_id, "assistant", assistant_text)
            commitment = maybe_create_commitment(session_id, user_text)
            summary = summarize_session(session_id)
            session = db_one("select * from sessions where id = ?", (session_id,))
            self.json_response(
                {
                    "session": session,
                    "reply": assistant_text,
                    "summary": summary,
                    "interventions": interventions,
                    "new_memories": new_memories,
                    "commitment": commitment,
                    "risk_level": risk,
                    "model_status": model_status,
                }
            )
            return

        if self.path == "/api/session":
            session_id = ensure_session(None)
            self.json_response({"session": db_one("select * from sessions where id = ?", (session_id,))}, HTTPStatus.CREATED)
            return

        if self.path == "/api/summarize":
            body = self.read_json()
            session_id = ensure_session(body.get("session_id"))
            self.json_response({"summary": summarize_session(session_id)})
            return

        self.json_response({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_PATCH(self) -> None:
        if self.path.startswith("/api/commitment/"):
            commitment_id = self.path.rsplit("/", 1)[-1]
            body = self.read_json()
            status = str(body.get("status", "active"))
            db_exec("update commitments set status = ?, updated_at = ? where id = ?", (status, now_iso(), commitment_id))
            self.json_response({"commitment": db_one("select * from commitments where id = ?", (commitment_id,))})
            return
        self.json_response({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        if self.path.startswith("/api/session/"):
            session_id = self.path.rsplit("/", 1)[-1]
            if not db_one("select id from sessions where id = ?", (session_id,)):
                self.json_response({"error": "Session not found"}, HTTPStatus.NOT_FOUND)
                return

            db_exec("delete from messages where session_id = ?", (session_id,))
            db_exec("delete from commitments where session_id = ?", (session_id,))
            db_exec("delete from memories where source_session_id = ?", (session_id,))
            db_exec("delete from sessions where id = ?", (session_id,))
            self.json_response({"deleted": True, "session_id": session_id})
            return
        self.json_response({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        return json.loads(raw or "{}")

    def json_response(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    init_db()
    port = int(os.getenv("PORT", "8080"))
    server = ThreadingHTTPServer(("127.0.0.1", port), TherapyHandler)
    print(f"Therapy chatbot running at http://127.0.0.1:{port}")
    print(f"Using local model endpoint: {LOCAL_LLM_URL}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    main()
