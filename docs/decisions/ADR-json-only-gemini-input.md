# ADR: JSON-only Gemini input

Status: accepted, 2026-08-16.

Gemini receives only a model-safe projection of retained n8n workflow JSON. Catalogue titles, upstream descriptions, URLs, rights, scanner facts, and fact packets are excluded because they are external prose or derived metadata and can poison or bias generation. The projection and audit are enforced before the temporary packet is written.
