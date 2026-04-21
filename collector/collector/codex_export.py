"""Export Codex local conversations with high-fidelity artifacts."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


THREAD_ID_RE = re.compile(
    r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)
RAW_FILE_NAMES = (
    ".codex-global-state.json",
    "config.toml",
    "history.jsonl",
    "session_index.jsonl",
    "state_5.sqlite",
    "state_5.sqlite-shm",
    "state_5.sqlite-wal",
    "logs_2.sqlite",
    "logs_2.sqlite-shm",
    "logs_2.sqlite-wal",
    "version.json",
    "models_cache.json",
    "AGENTS.md",
)
RAW_DIR_NAMES = (
    "sessions",
    "archived_sessions",
)
SKIP_MARKDOWN_KINDS = {
    "session_meta",
    "turn_context",
    "task_started",
    "token_count",
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Export local Codex conversations with raw artifacts, normalized indexes, and Markdown transcripts.",
    )
    parser.add_argument(
        "--codex-home",
        type=Path,
        default=Path.home() / ".codex",
        help="Path to the local Codex home directory (default: ~/.codex).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Output directory. Defaults to ./dist/codex-export-YYYYMMDD-HHMMSS.",
    )
    parser.add_argument(
        "--skip-raw",
        action="store_true",
        help="Do not copy raw Codex artifacts into the export bundle.",
    )
    parser.add_argument(
        "--skip-jsonl",
        action="store_true",
        help="Do not write normalized threads.jsonl/events.jsonl files.",
    )
    parser.add_argument(
        "--skip-sqlite",
        action="store_true",
        help="Do not write the normalized SQLite index.",
    )
    parser.add_argument(
        "--skip-markdown",
        action="store_true",
        help="Do not render per-thread Markdown transcripts.",
    )
    parser.add_argument(
        "--include-shell-snapshots",
        action="store_true",
        help="Also copy ~/.codex/shell_snapshots into raw artifacts.",
    )
    args = parser.parse_args(argv)

    output_dir = args.output_dir or (
        Path.cwd() / "dist" / f"codex-export-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    )
    if output_dir.exists() and any(output_dir.iterdir()):
        parser.error(f"output directory is not empty: {output_dir}")

    manifest = export_codex_home(
        codex_home=args.codex_home,
        output_dir=output_dir,
        include_raw=not args.skip_raw,
        include_jsonl=not args.skip_jsonl,
        include_sqlite=not args.skip_sqlite,
        include_markdown=not args.skip_markdown,
        include_shell_snapshots=args.include_shell_snapshots,
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


def export_codex_home(
    codex_home: Path,
    output_dir: Path,
    *,
    include_raw: bool = True,
    include_jsonl: bool = True,
    include_sqlite: bool = True,
    include_markdown: bool = True,
    include_shell_snapshots: bool = False,
) -> dict[str, Any]:
    codex_home = codex_home.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    if not codex_home.exists():
        raise FileNotFoundError(f"codex home does not exist: {codex_home}")

    output_dir.mkdir(parents=True, exist_ok=True)
    normalized_dir = output_dir / "normalized"
    markdown_dir = output_dir / "markdown"
    raw_dir = output_dir / "raw"
    normalized_dir.mkdir(parents=True, exist_ok=True)
    if include_markdown:
        markdown_dir.mkdir(parents=True, exist_ok=True)
    if include_raw:
        raw_dir.mkdir(parents=True, exist_ok=True)
        copy_raw_artifacts(
            codex_home=codex_home,
            raw_root=raw_dir,
            include_shell_snapshots=include_shell_snapshots,
        )

    threads = discover_threads(codex_home)
    if not threads:
        raise RuntimeError(f"no Codex threads found under {codex_home}")

    sqlite_conn = None
    events_jsonl_fp = None
    threads_jsonl_fp = None
    index_path = normalized_dir / "index.sqlite"
    events_path = normalized_dir / "events.jsonl"
    threads_path = normalized_dir / "threads.jsonl"

    if include_sqlite:
        sqlite_conn = sqlite3.connect(index_path)
        init_export_db(sqlite_conn)
    if include_jsonl:
        events_jsonl_fp = events_path.open("w", encoding="utf-8")
        threads_jsonl_fp = threads_path.open("w", encoding="utf-8")

    manifest_threads: list[dict[str, Any]] = []
    total_events = 0
    try:
        for thread in threads:
            events = parse_session_file(thread)
            total_events += len(events)

            markdown_path = ""
            if include_markdown:
                filename = build_markdown_filename(
                    thread_id=thread["thread_id"],
                    title=thread.get("title", ""),
                )
                markdown_path = str(markdown_dir / filename)
                markdown_text = render_thread_markdown(thread, events)
                (markdown_dir / filename).write_text(markdown_text, encoding="utf-8")

            thread_record = {
                **thread,
                "event_count": len(events),
                "markdown_path": markdown_path,
            }

            if include_sqlite and sqlite_conn is not None:
                insert_thread_record(sqlite_conn, thread_record)
                insert_event_records(sqlite_conn, events)

            if include_jsonl and threads_jsonl_fp is not None and events_jsonl_fp is not None:
                threads_jsonl_fp.write(json.dumps(thread_record, ensure_ascii=False) + "\n")
                for event in events:
                    events_jsonl_fp.write(json.dumps(event, ensure_ascii=False) + "\n")

            manifest_threads.append({
                "thread_id": thread["thread_id"],
                "title": thread.get("title", ""),
                "archived": bool(thread.get("archived")),
                "event_count": len(events),
                "rollout_path": thread.get("rollout_path", ""),
                "markdown_path": markdown_path,
            })
    finally:
        if sqlite_conn is not None:
            sqlite_conn.commit()
            sqlite_conn.close()
        if events_jsonl_fp is not None:
            events_jsonl_fp.close()
        if threads_jsonl_fp is not None:
            threads_jsonl_fp.close()

    manifest = {
        "generated_at": iso_now(),
        "codex_home": str(codex_home),
        "output_dir": str(output_dir),
        "thread_count": len(threads),
        "event_count": total_events,
        "artifacts": {
            "raw_dir": str(raw_dir) if include_raw else "",
            "threads_jsonl": str(threads_path) if include_jsonl else "",
            "events_jsonl": str(events_path) if include_jsonl else "",
            "index_sqlite": str(index_path) if include_sqlite else "",
            "markdown_dir": str(markdown_dir) if include_markdown else "",
        },
        "threads": manifest_threads,
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return manifest


def copy_raw_artifacts(
    *,
    codex_home: Path,
    raw_root: Path,
    include_shell_snapshots: bool,
) -> None:
    raw_codex_root = raw_root / ".codex"
    raw_codex_root.mkdir(parents=True, exist_ok=True)

    for file_name in RAW_FILE_NAMES:
        source = codex_home / file_name
        if source.exists():
            shutil.copy2(source, raw_codex_root / file_name)

    for dir_name in RAW_DIR_NAMES:
        source = codex_home / dir_name
        if source.exists():
            shutil.copytree(source, raw_codex_root / dir_name, dirs_exist_ok=True)

    if include_shell_snapshots:
        source = codex_home / "shell_snapshots"
        if source.exists():
            shutil.copytree(source, raw_codex_root / "shell_snapshots", dirs_exist_ok=True)


def discover_threads(codex_home: Path) -> list[dict[str, Any]]:
    scanned = scan_session_files(codex_home)
    state_threads = load_threads_from_state(codex_home / "state_5.sqlite")
    merged: dict[str, dict[str, Any]] = {}

    all_ids = set(scanned) | set(state_threads)
    for thread_id in all_ids:
        record: dict[str, Any] = {"thread_id": thread_id}
        merge_thread_info(record, scanned.get(thread_id, {}))
        merge_thread_info(record, state_threads.get(thread_id, {}))

        rollout_path = record.get("rollout_path", "")
        if rollout_path:
            path = Path(rollout_path)
            if not path.is_absolute():
                path = (codex_home / rollout_path).resolve()
            record["rollout_path"] = str(path)
            if not record.get("archived"):
                record["archived"] = "archived_sessions" in path.parts

        if not record.get("title"):
            record["title"] = record.get("first_user_message") or thread_id
        if not record.get("created_at"):
            record["created_at"] = record.get("session_meta_timestamp", "")
        if not record.get("updated_at"):
            record["updated_at"] = record.get("created_at", "")
        merged[thread_id] = record

    threads = list(merged.values())
    threads.sort(
        key=lambda item: (
            item.get("created_at_epoch") or 0,
            item.get("created_at", ""),
            item.get("thread_id", ""),
        ),
        reverse=True,
    )
    return threads


def scan_session_files(codex_home: Path) -> dict[str, dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    candidates: list[tuple[Path, bool]] = []

    sessions_root = codex_home / "sessions"
    if sessions_root.exists():
        for path in sessions_root.rglob("*.jsonl"):
            candidates.append((path, False))

    archived_root = codex_home / "archived_sessions"
    if archived_root.exists():
        for path in archived_root.glob("*.jsonl"):
            candidates.append((path, True))

    for path, archived in candidates:
        session_meta = read_session_meta(path)
        thread_id = session_meta.get("id") or extract_thread_id_from_path(path)
        if not thread_id:
            continue
        record = records.setdefault(thread_id, {"thread_id": thread_id})
        merge_thread_info(record, {
            "rollout_path": str(path.resolve()),
            "archived": archived,
            "cwd": session_meta.get("cwd", ""),
            "source": session_meta.get("source", ""),
            "model_provider": session_meta.get("model_provider", ""),
            "cli_version": session_meta.get("cli_version", ""),
            "originator": session_meta.get("originator", ""),
            "session_meta_timestamp": session_meta.get("timestamp", ""),
            "session_meta_json": session_meta,
        })
        if session_meta.get("timestamp"):
            record.setdefault("created_at", session_meta["timestamp"])
            record.setdefault("updated_at", session_meta["timestamp"])
        title = session_meta.get("title") or path.stem
        if title:
            record.setdefault("title", title)

    return records


def load_threads_from_state(state_path: Path) -> dict[str, dict[str, Any]]:
    if not state_path.exists():
        return {}

    rows: dict[str, dict[str, Any]] = {}
    try:
        conn = sqlite3.connect(f"file:{state_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        cursor = conn.execute("select * from threads")
        fetched = cursor.fetchall()
    except sqlite3.Error:
        return {}
    finally:
        try:
            conn.close()  # type: ignore[name-defined]
        except Exception:
            pass

    for row in fetched:
        data = dict(row)
        thread_id = str(data.get("id", "")).strip()
        if not thread_id:
            continue
        rows[thread_id] = {
            "thread_id": thread_id,
            "rollout_path": data.get("rollout_path", "") or "",
            "title": data.get("title", "") or "",
            "cwd": data.get("cwd", "") or "",
            "source": data.get("source", "") or "",
            "model_provider": data.get("model_provider", "") or "",
            "model": data.get("model", "") or "",
            "reasoning_effort": data.get("reasoning_effort", "") or "",
            "approval_mode": data.get("approval_mode", "") or "",
            "sandbox_policy": data.get("sandbox_policy", "") or "",
            "git_branch": data.get("git_branch", "") or "",
            "git_sha": data.get("git_sha", "") or "",
            "git_origin_url": data.get("git_origin_url", "") or "",
            "cli_version": data.get("cli_version", "") or "",
            "first_user_message": data.get("first_user_message", "") or "",
            "archived": bool(data.get("archived", 0)),
            "created_at_epoch": data.get("created_at") or 0,
            "updated_at_epoch": data.get("updated_at") or 0,
            "created_at": epoch_to_iso(data.get("created_at")),
            "updated_at": epoch_to_iso(data.get("updated_at")),
            "state_thread_json": data,
        }
    return rows


def merge_thread_info(target: dict[str, Any], source: dict[str, Any]) -> None:
    for key, value in source.items():
        if value in ("", None, [], {}):
            continue
        if key == "title" and should_replace_title(target.get("title", ""), str(value)):
            target[key] = value
            continue
        if key not in target or target.get(key) in ("", None, [], {}):
            target[key] = value
            continue
        if key == "archived":
            target[key] = bool(target.get(key)) or bool(value)


def read_session_meta(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fp:
            for raw_line in fp:
                line = raw_line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                if obj.get("type") == "session_meta":
                    payload = obj.get("payload", {})
                    if isinstance(payload, dict):
                        return payload
                break
    except Exception:
        return {}
    return {}


def extract_thread_id_from_path(path: Path) -> str:
    match = THREAD_ID_RE.search(path.name)
    return match.group(1) if match else ""


def should_replace_title(current: str, candidate: str) -> bool:
    current = current.strip()
    candidate = candidate.strip()
    if not candidate:
        return False
    if not current:
        return True
    if current == candidate:
        return False
    if current.startswith("rollout-") and not candidate.startswith("rollout-"):
        return True
    return False


def parse_session_file(thread: dict[str, Any]) -> list[dict[str, Any]]:
    rollout_path = thread.get("rollout_path", "")
    if not rollout_path:
        return []

    session_path = Path(rollout_path)
    events: list[dict[str, Any]] = []
    with session_path.open("r", encoding="utf-8", errors="replace") as fp:
        for seq, raw_line in enumerate(fp, start=1):
            line = raw_line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict):
                continue
            events.append(
                normalize_event_record(
                    thread_id=thread["thread_id"],
                    session_path=session_path,
                    seq=seq,
                    obj=obj,
                )
            )
    return events


def normalize_event_record(
    *,
    thread_id: str,
    session_path: Path,
    seq: int,
    obj: dict[str, Any],
) -> dict[str, Any]:
    outer_type = str(obj.get("type", "") or "")
    payload = obj.get("payload", {})
    payload_type = ""
    role = ""
    phase = ""
    text = ""
    call_id = ""
    tool_name = ""
    tool_input = ""
    tool_output = ""
    turn_id = ""
    kind = outer_type or "unknown"

    if isinstance(payload, dict):
        payload_type = str(payload.get("type", "") or "")
        role = str(payload.get("role", "") or "")
        phase = str(payload.get("phase", "") or "")
        turn_id = str(payload.get("turn_id", "") or "")

    if outer_type == "session_meta":
        kind = "session_meta"
    elif outer_type == "turn_context":
        kind = "turn_context"
        text = summarize_turn_context(payload if isinstance(payload, dict) else {})
        turn_id = str((payload or {}).get("turn_id", "") or "")
    elif outer_type == "compacted":
        kind = "compacted"
        text = summarize_compaction(payload if isinstance(payload, dict) else {})
    elif outer_type == "response_item" and isinstance(payload, dict):
        if payload_type == "message":
            kind = "message"
            text = extract_codex_content(payload.get("content", []))
        elif payload_type in {"function_call", "custom_tool_call", "web_search_call"}:
            kind = "tool_call"
            call_id = str(payload.get("call_id", "") or "")
            tool_name = str(payload.get("name", "") or payload_type)
            tool_input = extract_tool_input(payload)
            text = tool_input
        elif payload_type in {"function_call_output", "custom_tool_call_output"}:
            kind = "tool_output"
            call_id = str(payload.get("call_id", "") or "")
            tool_output = stringify_value(payload.get("output", ""))
            text = tool_output
        elif payload_type == "reasoning":
            kind = "reasoning"
            text = extract_reasoning_text(payload)
        else:
            kind = payload_type or outer_type
            text = stringify_value(payload)
    elif outer_type == "event_msg" and isinstance(payload, dict):
        event_type = payload_type or "event_msg"
        kind = event_type
        if event_type == "user_message":
            role = "user"
            text = stringify_value(payload.get("message", ""))
        elif event_type == "agent_message":
            role = "assistant"
            kind = "commentary"
            text = stringify_value(payload.get("message", ""))
        elif event_type == "task_complete":
            role = "assistant"
            kind = "final_message"
            text = stringify_value(payload.get("last_agent_message", ""))
        elif event_type == "token_count":
            text = summarize_token_count(payload)
        else:
            text = stringify_value(payload)

    return {
        "thread_id": thread_id,
        "seq": seq,
        "timestamp": str(obj.get("timestamp", "") or ""),
        "session_path": str(session_path),
        "outer_type": outer_type,
        "payload_type": payload_type,
        "kind": kind,
        "role": role,
        "phase": phase,
        "turn_id": turn_id,
        "call_id": call_id,
        "tool_name": tool_name,
        "text": text,
        "tool_input": tool_input,
        "tool_output": tool_output,
        "raw": obj,
    }


def render_thread_markdown(thread: dict[str, Any], events: list[dict[str, Any]]) -> str:
    lines = [
        "# Codex Conversation Export",
        "",
        "## Metadata",
        f"- Thread ID: `{thread.get('thread_id', '')}`",
        f"- Title: {thread.get('title', '')}",
        f"- Archived: `{'yes' if thread.get('archived') else 'no'}`",
        f"- Created At: `{thread.get('created_at', '')}`",
        f"- Updated At: `{thread.get('updated_at', '')}`",
        f"- CWD: `{thread.get('cwd', '')}`",
        f"- Source: `{thread.get('source', '')}`",
        f"- Model: `{thread.get('model', '')}`",
        f"- Model Provider: `{thread.get('model_provider', '')}`",
        f"- Reasoning Effort: `{thread.get('reasoning_effort', '')}`",
        f"- Rollout Path: `{thread.get('rollout_path', '')}`",
        "",
        "Raw system/developer/context events are preserved in `normalized/events.jsonl` and `normalized/index.sqlite`.",
        "",
        "## Transcript",
        "",
    ]

    transcript_lines = render_transcript_lines(events)
    if transcript_lines:
        lines.extend(transcript_lines)
    else:
        lines.append("_No renderable transcript entries were found. Use raw/normalized artifacts instead._")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_transcript_lines(events: list[dict[str, Any]]) -> list[str]:
    lines: list[str] = []
    call_names: dict[str, str] = {}
    last_fingerprint: tuple[str, str] | None = None
    counter = 0

    for event in events:
        if event["kind"] == "tool_call" and event["call_id"] and event["tool_name"]:
            call_names[event["call_id"]] = event["tool_name"]

        rendered = render_event_for_markdown(event, call_names)
        if not rendered:
            continue
        fingerprint = (rendered["heading"], rendered["body"])
        if fingerprint == last_fingerprint:
            continue
        last_fingerprint = fingerprint
        counter += 1
        lines.append(f"### {counter:04d}. {rendered['heading']}")
        lines.append("")
        lines.append(rendered["body"])
        lines.append("")

    return lines


def render_event_for_markdown(
    event: dict[str, Any],
    call_names: dict[str, str],
) -> dict[str, str] | None:
    kind = event.get("kind", "")
    if kind in SKIP_MARKDOWN_KINDS:
        return None

    timestamp = event.get("timestamp", "")
    text = event.get("text", "")
    role = event.get("role", "")

    if kind == "user_message":
        return {
            "heading": build_heading("User", timestamp),
            "body": text or "_empty_",
        }

    if kind == "message":
        if role == "user":
            if text.lstrip().startswith("<environment_context>"):
                return None
            return {
                "heading": build_heading("User (response_item)", timestamp),
                "body": text or "_empty_",
            }
        if role == "assistant":
            return {
                "heading": build_heading("Assistant (response_item)", timestamp),
                "body": text or "_empty_",
            }
        if role == "developer":
            return None
        if role == "system":
            return None
        if text:
            return {
                "heading": build_heading(f"Message `{role or 'unknown'}`", timestamp),
                "body": fenced_block(text, "text"),
            }

    if kind == "commentary":
        return {
            "heading": build_heading("Assistant Commentary", timestamp),
            "body": text or "_empty_",
        }

    if kind == "final_message":
        return {
            "heading": build_heading("Assistant Final", timestamp),
            "body": text or "_empty_",
        }

    if kind == "tool_call":
        tool_name = event.get("tool_name", "") or call_names.get(event.get("call_id", ""), "")
        heading = f"Tool Call `{tool_name or 'unknown'}`"
        body_lines = []
        if timestamp:
            body_lines.append(f"Time: `{timestamp}`")
        if event.get("call_id"):
            body_lines.append(f"Call ID: `{event['call_id']}`")
        if event.get("tool_input"):
            body_lines.append(fenced_block(event["tool_input"], guess_fence_lang(event["tool_input"])))
        else:
            body_lines.append("_no input captured_")
        return {
            "heading": heading,
            "body": "\n".join(body_lines),
        }

    if kind == "tool_output":
        tool_name = event.get("tool_name", "") or call_names.get(event.get("call_id", ""), "")
        heading = f"Tool Output `{tool_name or 'unknown'}`"
        body_lines = []
        if timestamp:
            body_lines.append(f"Time: `{timestamp}`")
        if event.get("call_id"):
            body_lines.append(f"Call ID: `{event['call_id']}`")
        if event.get("tool_output"):
            body_lines.append(fenced_block(event["tool_output"], "text"))
        else:
            body_lines.append("_no output captured_")
        return {
            "heading": heading,
            "body": "\n".join(body_lines),
        }

    if kind == "reasoning":
        return {
            "heading": build_heading("Reasoning", timestamp),
            "body": text or "_empty_",
        }

    if kind == "compacted":
        replacement_history = []
        raw = event.get("raw", {})
        if isinstance(raw, dict):
            payload = raw.get("payload", {})
            if isinstance(payload, dict):
                replacement_history = payload.get("replacement_history", [])
        body = render_replacement_history(replacement_history)
        return {
            "heading": build_heading("Context Compacted", timestamp),
            "body": body,
        }

    if kind == "task_complete":
        return {
            "heading": build_heading("Task Complete", timestamp),
            "body": text or "_empty_",
        }

    if not text:
        return None
    return {
        "heading": build_heading(kind.replace("_", " ").title(), timestamp),
        "body": fenced_block(text, "text"),
    }


def render_replacement_history(replacement_history: Any) -> str:
    if not isinstance(replacement_history, list) or not replacement_history:
        return "_replacement history is empty_"

    blocks: list[str] = []
    for idx, item in enumerate(replacement_history, start=1):
        if not isinstance(item, dict):
            blocks.append(f"#### Replacement {idx}\n\n{fenced_block(stringify_value(item), 'text')}")
            continue
        item_type = item.get("type", "")
        role = item.get("role", "")
        content = ""
        if item_type == "message":
            content = extract_codex_content(item.get("content", []))
            heading = f"Replacement {idx}: {role or 'message'}"
        else:
            content = stringify_value(item)
            heading = f"Replacement {idx}: {item_type or 'event'}"
        blocks.append(f"#### {heading}\n\n{content or '_empty_'}")
    return "\n\n".join(blocks)


def build_heading(label: str, timestamp: str) -> str:
    if timestamp:
        return f"{label} [{timestamp}]"
    return label


def build_markdown_filename(*, thread_id: str, title: str) -> str:
    slug = slugify(title) or "thread"
    return f"{thread_id}-{slug}.md"


def slugify(text: str) -> str:
    lowered = text.strip().lower()
    normalized = re.sub(r"[^a-z0-9]+", "-", lowered)
    return normalized.strip("-")[:80]


def init_export_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        create table if not exists threads (
            thread_id text primary key,
            title text not null default '',
            archived integer not null default 0,
            created_at text not null default '',
            created_at_epoch integer not null default 0,
            updated_at text not null default '',
            updated_at_epoch integer not null default 0,
            cwd text not null default '',
            source text not null default '',
            model_provider text not null default '',
            model text not null default '',
            reasoning_effort text not null default '',
            approval_mode text not null default '',
            sandbox_policy text not null default '',
            rollout_path text not null default '',
            cli_version text not null default '',
            originator text not null default '',
            first_user_message text not null default '',
            event_count integer not null default 0,
            markdown_path text not null default '',
            raw_state_json text not null default '',
            raw_session_meta_json text not null default ''
        );
        create table if not exists events (
            thread_id text not null,
            seq integer not null,
            timestamp text not null default '',
            session_path text not null default '',
            outer_type text not null default '',
            payload_type text not null default '',
            kind text not null default '',
            role text not null default '',
            phase text not null default '',
            turn_id text not null default '',
            call_id text not null default '',
            tool_name text not null default '',
            text text not null default '',
            tool_input text not null default '',
            tool_output text not null default '',
            raw_json text not null default '',
            primary key (thread_id, seq)
        );
        create index if not exists idx_events_thread_ts on events(thread_id, timestamp, seq);
        create index if not exists idx_events_kind on events(kind);
        """
    )


def insert_thread_record(conn: sqlite3.Connection, thread: dict[str, Any]) -> None:
    conn.execute(
        """
        insert or replace into threads (
            thread_id, title, archived, created_at, created_at_epoch, updated_at,
            updated_at_epoch, cwd, source, model_provider, model, reasoning_effort,
            approval_mode, sandbox_policy, rollout_path, cli_version, originator,
            first_user_message, event_count, markdown_path, raw_state_json, raw_session_meta_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            thread.get("thread_id", ""),
            thread.get("title", ""),
            1 if thread.get("archived") else 0,
            thread.get("created_at", ""),
            thread.get("created_at_epoch") or 0,
            thread.get("updated_at", ""),
            thread.get("updated_at_epoch") or 0,
            thread.get("cwd", ""),
            thread.get("source", ""),
            thread.get("model_provider", ""),
            thread.get("model", ""),
            thread.get("reasoning_effort", ""),
            thread.get("approval_mode", ""),
            thread.get("sandbox_policy", ""),
            thread.get("rollout_path", ""),
            thread.get("cli_version", ""),
            thread.get("originator", ""),
            thread.get("first_user_message", ""),
            thread.get("event_count") or 0,
            thread.get("markdown_path", ""),
            json.dumps(thread.get("state_thread_json", {}), ensure_ascii=False),
            json.dumps(thread.get("session_meta_json", {}), ensure_ascii=False),
        ),
    )


def insert_event_records(conn: sqlite3.Connection, events: list[dict[str, Any]]) -> None:
    rows = [
        (
            event.get("thread_id", ""),
            event.get("seq") or 0,
            event.get("timestamp", ""),
            event.get("session_path", ""),
            event.get("outer_type", ""),
            event.get("payload_type", ""),
            event.get("kind", ""),
            event.get("role", ""),
            event.get("phase", ""),
            event.get("turn_id", ""),
            event.get("call_id", ""),
            event.get("tool_name", ""),
            event.get("text", ""),
            event.get("tool_input", ""),
            event.get("tool_output", ""),
            json.dumps(event.get("raw", {}), ensure_ascii=False),
        )
        for event in events
    ]
    conn.executemany(
        """
        insert or replace into events (
            thread_id, seq, timestamp, session_path, outer_type, payload_type,
            kind, role, phase, turn_id, call_id, tool_name, text,
            tool_input, tool_output, raw_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )


def summarize_turn_context(payload: dict[str, Any]) -> str:
    model = stringify_value(payload.get("model", ""))
    cwd = stringify_value(payload.get("cwd", ""))
    timezone_name = stringify_value(payload.get("timezone", ""))
    return f"model={model}, cwd={cwd}, timezone={timezone_name}"


def summarize_compaction(payload: dict[str, Any]) -> str:
    replacement_history = payload.get("replacement_history", [])
    count = len(replacement_history) if isinstance(replacement_history, list) else 0
    return f"context compacted; replacement_history={count}"


def summarize_token_count(payload: dict[str, Any]) -> str:
    info = payload.get("info", {})
    if not isinstance(info, dict):
        return ""
    total = info.get("total_token_usage", {})
    if not isinstance(total, dict):
        return ""
    total_tokens = total.get("total_tokens")
    if total_tokens in (None, ""):
        return ""
    return f"total_tokens={total_tokens}"


def extract_codex_content(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if text not in (None, ""):
                    parts.append(str(text))
                elif item:
                    parts.append(json.dumps(item, ensure_ascii=False))
            elif item not in (None, ""):
                parts.append(str(item))
        return "\n".join(parts).strip()
    if isinstance(content, dict):
        text = content.get("text")
        if text not in (None, ""):
            return str(text).strip()
        return json.dumps(content, ensure_ascii=False)
    if content is None:
        return ""
    return str(content).strip()


def extract_tool_input(payload: dict[str, Any]) -> str:
    if "arguments" in payload:
        return stringify_value(payload.get("arguments"))
    if "input" in payload:
        return stringify_value(payload.get("input"))
    if "query" in payload:
        return stringify_value(payload.get("query"))
    return stringify_value({
        key: value
        for key, value in payload.items()
        if key not in {"type", "call_id", "status"}
    })


def extract_reasoning_text(payload: dict[str, Any]) -> str:
    summary = payload.get("summary", [])
    if isinstance(summary, list):
        summary_parts = []
        for item in summary:
            if isinstance(item, dict):
                text = item.get("text", "")
                if text:
                    summary_parts.append(str(text))
            elif item:
                summary_parts.append(str(item))
        if summary_parts:
            return "\n\n".join(summary_parts)

    content = payload.get("content")
    if content not in (None, ""):
        return stringify_value(content)
    encrypted = payload.get("encrypted_content")
    if encrypted:
        return "[encrypted reasoning omitted]"
    return ""


def stringify_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False, indent=2)
    return str(value).strip()


def fenced_block(text: str, language: str) -> str:
    body = text.rstrip()
    return f"```{language}\n{body}\n```"


def guess_fence_lang(text: str) -> str:
    stripped = text.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        return "json"
    return "text"


def epoch_to_iso(value: Any) -> str:
    if value in (None, ""):
        return ""
    try:
        timestamp = int(value)
    except (TypeError, ValueError):
        return ""
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
