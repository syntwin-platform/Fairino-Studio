# Agent Guidelines

## Local Memory

This repository uses local long-term memory stored in `.project-memory/` and indexed into `localMemory`.

Before complex tasks, use `localMemory.search_memory`.

Search for:

- active context
- latest session summary
- architecture decisions
- coding conventions
- known bugs
- related implementation patterns

Rules:

- Current repository files are the source of truth.
- Retrieved memory is advisory, not absolute truth.
- If memory conflicts with current code, report the conflict.
- Do not retrieve more than 8 chunks unless asked.
- Do not store secrets.
- Do not update memory unless the user asks.

## Session start

When starting a new session:

1. Search localMemory for:
   - "active context current focus next steps"
   - "latest session summary decisions unresolved issues"
   - topic-specific context
2. Summarize current status.
3. Propose next steps.
4. Do not edit files until approved.

## Session end

When the user says "lưu context", "save context", "kết thúc phiên", or "save session memory":

1. Use the `save-rag-context` skill.
2. Update `.project-memory/active-context.md`.
3. Create a concise session summary in `.project-memory/sessions/`.
4. Do not include secrets.
5. Ask before running ingest unless the user explicitly says "lưu context và ingest".

When the user says "lưu context và ingest", "gán trí nhớ vô rag", or "đẩy context vào rag":

1. Use the `save-rag-context` skill.
2. Update memory files.
3. Read `.project-memory/config.md`.
4. Run the ingest command.
5. Report changed memory files and ingest result.
