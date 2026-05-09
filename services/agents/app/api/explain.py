"""
Explain endpoint — turns an alert into a grounded, human-readable answer to
"why did this fire and what should I do?".

Endpoint
--------

    POST /api/v1/explain          — NDJSON stream

Why this exists separately from ``copilot.py``
----------------------------------------------

Copilot is freeform chat. Explain is **structured grounding**: every
emitted frame is one of a small set of typed sections (summary, OCSF
mapping, MITRE technique cards pulled from the local corpus, evidence,
next-step recommendations). The frontend renders each frame
deterministically, so the analyst gets the same drawer shape whether the
LLM is enabled, disabled, or running locally — and so the UI can link
directly to attack.mitre.org without trusting the model not to
hallucinate IDs.

Air-gap behaviour
-----------------

- ``AISOC_AIRGAPPED=true``                  → no outbound LLM call, ever
- ``OPENAI_BASE_URL`` set to a non-OpenAI host (LiteLLM, Ollama, vLLM)
                                            → allowed in air-gap mode
- Otherwise                                 → openai.com, gated on the
                                              presence of ``OPENAI_API_KEY``

When the LLM path is skipped, the deterministic synthesizer fills the
``summary`` section from the alert payload itself, so the demo path
never breaks.

NDJSON frame shapes
-------------------

Each line is a single JSON object. Frames are emitted in this order::

    {"kind": "section", "id": "summary",     "title": "What happened"}
    {"kind": "delta",   "section": "summary", "text": "..."}            (×N)
    {"kind": "section", "id": "ocsf",        "title": "OCSF mapping"}
    {"kind": "ocsf",    "category": "...", "category_uid": 3,
                        "class": "...",    "class_uid": 3002,
                        "activity": "...", "fields": {...}}
    {"kind": "section", "id": "mitre",       "title": "MITRE ATT&CK"}
    {"kind": "mitre",   "id": "T1078",       "name": "Valid Accounts",
                        "tactic_names": [...], "url": "...",
                        "description": "..."}                            (×N)
    {"kind": "section", "id": "evidence",    "title": "Key evidence"}
    {"kind": "evidence","label": "...",      "value": "...",
                        "annotation": "..."}                             (×N)
    {"kind": "section", "id": "next",        "title": "Next steps"}
    {"kind": "next_step","title": "...", "rationale": "...",
                         "playbook_id": null}                            (×N)
    {"kind": "done",    "alert_id": "..."}

The first ``error`` frame, if any, is fatal — the client should display
it and stop reading.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import AsyncIterator
from typing import Any

import structlog
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logger = structlog.get_logger()

router = APIRouter(prefix="/api/v1", tags=["explain"])


# ---------------------------------------------------------------------------
# Request shape
# ---------------------------------------------------------------------------


class ExplainRequest(BaseModel):
    """Body of POST /api/v1/explain.

    The frontend already has the full alert object in hand from the
    detail view, so we accept it verbatim rather than re-fetching by ID.
    Falls back to ``alert_id`` lookup later if needed.
    """

    alert: dict[str, Any] = Field(default_factory=dict)
    alert_id: str | None = None
    tenant_id: str = "default"


# ---------------------------------------------------------------------------
# OCSF heuristic mapping
# ---------------------------------------------------------------------------
#
# We do NOT re-implement the canonical OCSF normalizer here — that lives in
# ``services/ocsf``. The Explain drawer's job is to *label* the right OCSF
# class so an analyst knows where in the schema to look. Source-string
# heuristics are good enough for that and degrade gracefully (we always
# fall back to the generic Security Finding class).

_OCSF_BY_SOURCE: dict[str, dict[str, Any]] = {
    "okta": {
        "category": "Identity & Access Management",
        "category_uid": 3,
        "class": "Authentication",
        "class_uid": 3002,
        "activity": "Logon",
    },
    "azure-ad": {
        "category": "Identity & Access Management",
        "category_uid": 3,
        "class": "Authentication",
        "class_uid": 3002,
        "activity": "Logon",
    },
    "crowdstrike": {
        "category": "System Activity",
        "category_uid": 1,
        "class": "Process Activity",
        "class_uid": 1007,
        "activity": "Launch",
    },
    "defender": {
        "category": "System Activity",
        "category_uid": 1,
        "class": "Process Activity",
        "class_uid": 1007,
        "activity": "Launch",
    },
    "aws-guardduty": {
        "category": "Findings",
        "category_uid": 2,
        "class": "Security Finding",
        "class_uid": 2001,
        "activity": "Create",
    },
    "aws-cloudtrail": {
        "category": "Application Activity",
        "category_uid": 6,
        "class": "API Activity",
        "class_uid": 6003,
        "activity": "Create",
    },
    "github": {
        "category": "Application Activity",
        "category_uid": 6,
        "class": "API Activity",
        "class_uid": 6003,
        "activity": "Read",
    },
    "splunk": {
        "category": "Findings",
        "category_uid": 2,
        "class": "Security Finding",
        "class_uid": 2001,
        "activity": "Create",
    },
    "elastic": {
        "category": "Findings",
        "category_uid": 2,
        "class": "Security Finding",
        "class_uid": 2001,
        "activity": "Create",
    },
}

_OCSF_FALLBACK = {
    "category": "Findings",
    "category_uid": 2,
    "class": "Security Finding",
    "class_uid": 2001,
    "activity": "Create",
}


def _map_to_ocsf(alert: dict[str, Any]) -> dict[str, Any]:
    """Pick a sensible OCSF class label for the alert."""
    src = (alert.get("source") or "").lower().strip()
    for key, mapping in _OCSF_BY_SOURCE.items():
        if key in src:
            base = dict(mapping)
            break
    else:
        base = dict(_OCSF_FALLBACK)

    raw = alert.get("rawEvent") or alert.get("raw_event") or {}
    fields: dict[str, Any] = {}
    for key in ("user", "user_name", "username", "actor", "src_ip",
                "source_ip", "dest_ip", "destination_ip", "host",
                "hostname", "process", "process_name", "file_hash",
                "domain", "url"):
        if isinstance(raw, dict) and raw.get(key):
            fields[key] = raw[key]

    base["fields"] = fields
    return base


# ---------------------------------------------------------------------------
# MITRE grounding — pull real technique cards from the loaded corpus
# ---------------------------------------------------------------------------

_MITRE_ID_RE = re.compile(r"\bT\d{4}(?:\.\d{3})?\b")


def _extract_mitre_ids(alert: dict[str, Any]) -> list[str]:
    """Return ATT&CK technique IDs referenced by the alert.

    Looks at the structured ``mitreAttack`` field first (canonical),
    then scans tags and free-text fields with the T-ID regex so older
    detections still produce cards.
    """
    found: list[str] = []
    seen: set[str] = set()

    # Structured field — preferred
    mitre = alert.get("mitreAttack") or alert.get("mitre_attack") or []
    if isinstance(mitre, list):
        for item in mitre:
            tid = None
            if isinstance(item, dict):
                tid = item.get("techniqueId") or item.get("technique_id") or item.get("id")
            elif isinstance(item, str):
                tid = item
            if tid and tid not in seen:
                found.append(tid)
                seen.add(tid)

    # Regex sweep across tags + descriptive text
    text_pool = " ".join(
        str(v)
        for v in (
            alert.get("tags") or []
        )
    ) + " " + str(alert.get("description") or "") + " " + str(alert.get("title") or "")

    for tid in _MITRE_ID_RE.findall(text_pool):
        if tid not in seen:
            found.append(tid)
            seen.add(tid)

    return found[:5]  # cap so the drawer stays scannable


def _resolve_technique(technique_id: str) -> dict[str, Any]:
    """Return a MITRE card dict from the corpus, or a stub if unloaded.

    ``mitre_full.get_technique`` returns ``found=False`` for unknown
    IDs; we use that as the signal to emit a degraded card.
    """
    try:
        from app.tools.mitre_full import get_technique
    except Exception as exc:
        logger.debug("explain.mitre_corpus_unavailable", error=str(exc))
        return {
            "id": technique_id,
            "name": technique_id,
            "tactic_names": [],
            "description": "",
            "url": f"https://attack.mitre.org/techniques/{technique_id.replace('.', '/')}/",
            "found": False,
        }

    raw = get_technique(technique_id)
    desc = (raw.get("description") or "").strip()
    return {
        "id": raw.get("id", technique_id),
        "name": raw.get("name", technique_id),
        "tactic_names": raw.get("tactic_names") or [],
        "description": desc[:280] + ("…" if len(desc) > 280 else ""),
        "url": raw.get("url") or f"https://attack.mitre.org/techniques/{technique_id.replace('.', '/')}/",
        "found": bool(raw.get("found")),
    }


# ---------------------------------------------------------------------------
# Evidence + next steps
# ---------------------------------------------------------------------------


def _extract_evidence(alert: dict[str, Any]) -> list[dict[str, str]]:
    """Pull a small, scannable list of observables from the alert."""
    items: list[dict[str, str]] = []
    raw = alert.get("rawEvent") or alert.get("raw_event") or {}

    def add(label: str, value: Any, annotation: str = "") -> None:
        if value in (None, "", [], {}):
            return
        items.append(
            {
                "label": label,
                "value": str(value)[:160],
                "annotation": annotation,
            }
        )

    add("Severity", alert.get("severity"))
    add("Risk score", alert.get("riskScore") or alert.get("risk_score"))
    add("Source", alert.get("source"))

    if isinstance(raw, dict):
        for label, key in (
            ("User", "user"),
            ("User", "user_name"),
            ("Source IP", "src_ip"),
            ("Source IP", "source_ip"),
            ("Destination IP", "dest_ip"),
            ("Destination IP", "destination_ip"),
            ("Host", "hostname"),
            ("Host", "host"),
            ("Process", "process_name"),
            ("Process", "process"),
            ("File hash", "file_hash"),
            ("Domain", "domain"),
            ("URL", "url"),
        ):
            if raw.get(key) and not any(it["label"] == label for it in items):
                add(label, raw[key])

    iocs = alert.get("iocs") or []
    if isinstance(iocs, list):
        for ioc in iocs[:3]:
            if isinstance(ioc, dict) and ioc.get("value"):
                add(f"IOC ({ioc.get('type', 'indicator')})", ioc["value"])

    return items[:8]


def _build_next_steps(
    alert: dict[str, Any], mitre_ids: list[str]
) -> list[dict[str, Any]]:
    """Recommend concrete next moves grounded in alert tags / techniques.

    These are intentionally generic and link to the playbook engine so
    analysts can one-click run them. The list is curated, not generated,
    so the LLM can never hallucinate a non-existent playbook ID.
    """
    tags = {str(t).lower() for t in (alert.get("tags") or [])}
    severity = (alert.get("severity") or "").lower()
    steps: list[dict[str, Any]] = []

    if "account-takeover" in tags or "ato" in tags or "T1078" in mitre_ids:
        steps.append(
            {
                "title": "Run ATO containment playbook",
                "rationale": "Block sessions, force password reset, and require step-up MFA on the affected identity.",
                "playbook_id": "ato-impossible-travel-block-v1",
            }
        )

    if "ransomware" in tags or "T1486" in mitre_ids:
        steps.append(
            {
                "title": "Isolate the host",
                "rationale": "Suspected ransomware activity — quarantine the endpoint to stop encryption spread.",
                "playbook_id": "ransomware-host-isolate-v1",
            }
        )

    if "phishing" in tags or "bec" in tags:
        steps.append(
            {
                "title": "Pull the message and similar deliveries",
                "rationale": "Identify other recipients and remove the message from inboxes before clicks propagate.",
                "playbook_id": "phishing-message-pull-v1",
            }
        )

    if any(t.startswith("T1190") or t.startswith("T1133") for t in mitre_ids):
        steps.append(
            {
                "title": "Tighten perimeter exposure",
                "rationale": "Initial access vector points at an external-facing service — review WAF rules and patch level.",
                "playbook_id": None,
            }
        )

    # Always-applicable triage steps — only if we have nothing else.
    if not steps:
        steps.append(
            {
                "title": "Correlate with the last 24 h of alerts",
                "rationale": "Look for the same user, host, or IOC in adjacent detections to spot a multi-stage attack.",
                "playbook_id": None,
            }
        )

    if severity in ("high", "critical"):
        steps.append(
            {
                "title": "Open a case and notify on-call",
                "rationale": f"Severity is {severity}; promote to a tracked incident before further investigation.",
                "playbook_id": None,
            }
        )

    return steps[:4]


def _build_summary(alert: dict[str, Any], mitre_ids: list[str]) -> str:
    """Deterministic 2–3 sentence summary used when the LLM is disabled."""
    title = alert.get("title") or "Security alert"
    severity = (alert.get("severity") or "unknown").lower()
    source = alert.get("source") or "an unknown source"
    desc = (alert.get("description") or "").strip()

    technique_clause = ""
    if mitre_ids:
        technique_clause = (
            f" The detection maps to {', '.join(mitre_ids[:3])}, "
            "which the technique cards below describe in full."
        )

    base = (
        f"{title} fired at {severity} severity from {source}."
        f"{technique_clause}"
    )
    if desc:
        # Trim to keep the drawer scannable.
        snippet = desc if len(desc) <= 240 else desc[:237] + "…"
        base += f" {snippet}"
    return base


# ---------------------------------------------------------------------------
# LLM call (optional, best-effort)
# ---------------------------------------------------------------------------


def _llm_allowed() -> bool:
    """Decide whether to attempt an outbound LLM call.

    Honours ``AISOC_AIRGAPPED``: when true, only allow if
    ``OPENAI_BASE_URL`` is set to something other than openai.com (i.e.
    a local LiteLLM/Ollama proxy on a private host).
    """
    if not os.getenv("OPENAI_API_KEY"):
        return False

    airgapped = os.getenv("AISOC_AIRGAPPED", "").lower() in ("1", "true", "yes")
    if not airgapped:
        return True

    base = (os.getenv("OPENAI_BASE_URL") or "").lower()
    if not base:
        return False  # would hit api.openai.com — blocked
    return "api.openai.com" not in base


async def _llm_summary(
    alert: dict[str, Any],
    mitre_techs: list[dict[str, Any]],
    fallback: str,
) -> str:
    """Ask the model for a tightly-scoped summary, with a hard fallback.

    The prompt deliberately forbids inventing technique IDs — the
    structured cards are emitted from the corpus, so the model only ever
    explains, never enumerates.
    """
    if not _llm_allowed():
        return fallback

    try:
        import httpx

        base = (os.getenv("OPENAI_BASE_URL") or "https://api.openai.com").rstrip("/")
        url = f"{base}/v1/chat/completions"
        model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

        tech_lines = [
            f"- {t['id']} {t['name']} ({', '.join(t.get('tactic_names') or []) or 'unknown tactic'})"
            for t in mitre_techs
        ]
        prompt_alert = {
            "title": alert.get("title"),
            "severity": alert.get("severity"),
            "source": alert.get("source"),
            "description": alert.get("description"),
            "tags": alert.get("tags") or [],
        }

        messages = [
            {
                "role": "system",
                "content": (
                    "You are AiSOC's alert explainer. Given one security alert and a "
                    "list of MITRE ATT&CK techniques already pulled from the local "
                    "corpus, write a tight 2–4 sentence summary for an L1/L2 SOC "
                    "analyst. Be concrete about WHAT happened and WHY it matters. "
                    "Never invent technique IDs, vendor names, or IOCs that aren't "
                    "in the input. No bullet lists, no headings — just prose."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "alert": prompt_alert,
                        "mitre_techniques": tech_lines,
                    },
                    indent=2,
                ),
            },
        ]

        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                url,
                headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
                json={"model": model, "messages": messages, "max_tokens": 320},
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"].strip()

    except Exception as exc:
        logger.warning("explain.llm_error", error=str(exc))
        return fallback


# ---------------------------------------------------------------------------
# Stream
# ---------------------------------------------------------------------------


def _frame(obj: dict[str, Any]) -> bytes:
    return (json.dumps(obj) + "\n").encode()


async def _stream_explanation(req: ExplainRequest) -> AsyncIterator[bytes]:
    alert = req.alert or {}
    alert_id = req.alert_id or alert.get("id") or "unknown"

    try:
        # ── 1. SUMMARY ────────────────────────────────────────────────────
        mitre_ids = _extract_mitre_ids(alert)
        mitre_cards = [_resolve_technique(t) for t in mitre_ids]

        fallback_summary = _build_summary(alert, mitre_ids)
        # Run the LLM call concurrently with the deterministic emissions
        # so the drawer paints fast even on a cold network.
        summary_task = asyncio.create_task(
            _llm_summary(alert, mitre_cards, fallback_summary)
        )

        yield _frame({"kind": "section", "id": "summary", "title": "What happened"})
        # Stream the summary word-by-word once it resolves.
        summary_text = await summary_task
        for word in summary_text.split(" "):
            yield _frame({"kind": "delta", "section": "summary", "text": word + " "})
            await asyncio.sleep(0.005)

        # ── 2. OCSF MAPPING ───────────────────────────────────────────────
        yield _frame({"kind": "section", "id": "ocsf", "title": "OCSF mapping"})
        ocsf = _map_to_ocsf(alert)
        yield _frame({"kind": "ocsf", **ocsf})

        # ── 3. MITRE CARDS ────────────────────────────────────────────────
        if mitre_cards:
            yield _frame({"kind": "section", "id": "mitre", "title": "MITRE ATT&CK"})
            for card in mitre_cards:
                yield _frame({"kind": "mitre", **card})

        # ── 4. EVIDENCE ───────────────────────────────────────────────────
        evidence = _extract_evidence(alert)
        if evidence:
            yield _frame({"kind": "section", "id": "evidence", "title": "Key evidence"})
            for item in evidence:
                yield _frame({"kind": "evidence", **item})

        # ── 5. NEXT STEPS ─────────────────────────────────────────────────
        next_steps = _build_next_steps(alert, mitre_ids)
        yield _frame({"kind": "section", "id": "next", "title": "Next steps"})
        for step in next_steps:
            yield _frame({"kind": "next_step", **step})

        # ── DONE ──────────────────────────────────────────────────────────
        yield _frame({"kind": "done", "alert_id": alert_id})

    except Exception as exc:  # noqa: BLE001 — frontend gets a structured error
        logger.exception("explain.stream_failed", error=str(exc))
        yield _frame({"kind": "error", "error": str(exc)})


@router.post("/explain")
async def explain(req: ExplainRequest) -> StreamingResponse:
    """Stream an OCSF + MITRE-grounded explanation of an alert as NDJSON."""
    return StreamingResponse(
        _stream_explanation(req),
        media_type="application/x-ndjson",
    )
