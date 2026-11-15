"""Gemini read-out: turns the scan on screen into a hand-off note for the receiving hospital, and answers
questions about it, grounded only in the numbers the pipeline produced.

Needs GEMINI_API_KEY (free from https://aistudio.google.com/apikey). GEMINI_MODEL picks the model; if it is
not available, the first text model the key can use is taken instead. Both are read from the environment or
from the repo's .env (the one the agent uses). Standard library only.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

API = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODEL = "gemini-4-hydrogen"
TIMEOUT_S = 40

SYSTEM = """You are the read-out for Lucid, a handheld screener that looks for bleeding inside the skull.
A medic places the probe on ten spots, five left/right pairs. A coil measures how well tissue conducts;
blood conducts more than brain, so a bleed shows as one side reading higher than its mirror. Near-infrared
light adds a second, shallower check. 500 simulated heads are fitted to the readings to say where a bleed
would most likely be and how big.

Rules:
- Use only the numbers in SCAN DATA. Never invent vitals, history, imaging or a diagnosis.
- Lucid is a screening aid, not a diagnosis. It tells a medic whether to rush someone to CT.
- If the scan is not finished, say what is still missing.
- If the head is simulated or a phantom (see "source"), say so in one short line.
- Plain words a paramedic reads in ten seconds. No markdown tables, no emoji."""

HANDOFF = """Write the pre-alert a medic would send to the receiving hospital, in four short labelled lines:
Finding: the chance of bleed and the screening flag.
Where: side, region, estimated depth and size if localized, with how sure the fit is.
Quality: spots that needed a retake, weak contact, or anything that makes the result less certain.
Next: what the medic should do now (for example rush to CT, rescan a spot), and what the What-if
progression numbers say about waiting, if they are given."""


ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


class GeminiError(RuntimeError):
    pass


def load_env(path: Path | None = None) -> None:
    """GEMINI_* from the repo's .env, without overriding what the environment already has."""
    path = path or ENV_FILE
    if not path.exists():
        return
    for line in path.read_text(errors="replace").splitlines():
        key, sep, value = line.partition("=")
        key = key.strip()
        if sep and key.startswith("GEMINI_") and key not in os.environ:
            value = value.split(" #", 1)[0].strip().strip('"').strip("'")
            if value:
                os.environ[key] = value


def available() -> bool:
    return bool(os.environ.get("GEMINI_API_KEY"))


def _post(url: str, body: dict) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json",
                                          "x-goog-api-key": os.environ["GEMINI_API_KEY"]})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return json.load(r)


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return json.load(r)


def _fallback_model() -> str | None:
    """A text model this key can call, preferring the fast general ones."""
    models = [m for m in _get(f"{API}/models?pageSize=200").get("models", [])
              if "generateContent" in m.get("supportedGenerationMethods", [])]
    names = [m["name"].removeprefix("models/") for m in models]
    for want in ("hydrogen", "flash", "pro"):
        hits = [n for n in names if want in n and not any(x in n for x in ("image", "tts", "audio", "live", "embed"))]
        if hits:
            return sorted(hits)[-1]
    return names[0] if names else None


class Gemini:
    def __init__(self):
        load_env()
        self.model = os.environ.get("GEMINI_MODEL", DEFAULT_MODEL)

    def ask(self, context: dict, question: str | None, history: list[dict] | None = None) -> dict:
        if not available():
            raise GeminiError("Set GEMINI_API_KEY to turn on the Gemini read-out.")
        contents = [{"role": "user", "parts": [{"text": "SCAN DATA\n" + json.dumps(context, separators=(",", ":"))}]},
                    {"role": "model", "parts": [{"text": "I have the scan data."}]}]
        for turn in (history or [])[-8:]:
            contents.append({"role": "model" if turn.get("role") == "model" else "user",
                             "parts": [{"text": str(turn.get("text", ""))[:2000]}]})
        contents.append({"role": "user", "parts": [{"text": question.strip()[:1000] if question else HANDOFF}]})
        body = {"systemInstruction": {"parts": [{"text": SYSTEM}]}, "contents": contents,
                "generationConfig": {"temperature": 0.3, "maxOutputTokens": 700}}
        try:
            data = self._generate(body)
        except urllib.error.HTTPError as e:
            raise GeminiError(f"Gemini returned {e.code}: {e.read().decode(errors='replace')[:300]}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            raise GeminiError(f"Could not reach Gemini: {e}") from e
        parts = (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
        if not text:
            raise GeminiError("Gemini sent back no text" + (f" ({data['promptFeedback']})" if "promptFeedback" in data else "."))
        return {"text": text, "model": self.model}

    def _generate(self, body: dict) -> dict:
        try:
            return _post(f"{API}/models/{self.model}:generateContent", body)
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            other = _fallback_model()
            if not other or other == self.model:
                raise
            self.model = other
            return _post(f"{API}/models/{self.model}:generateContent", body)


def scan_context(hello: dict | None, update: dict | None, outlook: dict | None, source: str) -> dict:
    """What Gemini sees: the scan as numbers, without the big arrays meant for drawing."""
    ctx: dict = {"source": source}
    if hello:
        ctx["scan"] = {"label": hello.get("label"), "medium": hello.get("medium"), "plan": hello.get("plan"),
                       "chance_before_any_reading": hello.get("prevalence"), "simulated_heads": hello.get("n_sims")}
    if not update:
        ctx["progress"] = "No spot finished yet."
        return ctx
    ctx["progress"] = {"finished": update.get("final"), "seconds": update.get("t_s"), "spots_done": update.get("done"),
                       "pairs_done": update.get("pairs_done"), "next_spot": update.get("next_spot"),
                       "retake": update.get("retake"), "confirm": update.get("confirm")}
    ctx["chance_of_bleed"] = update.get("p_bleed")
    ctx["summary_on_screen"] = update.get("text")
    ctx["location"] = update.get("location")
    ctx["screening_flag"] = update.get("flag")
    ctx["heart_rate_bpm"] = update.get("heart_rate_bpm")
    ctx["left_right_pairs"] = update.get("pairs")  # d_sigma: right minus left conductivity (S/m); z: in noise units
    ctx["spots"] = update.get("spots")
    ctx["surprises"] = update.get("surprises")
    if outlook:
        ctx["what_if_progression"] = {
            "note": "Growth model from published patterns. Surgical guide: 30 ml or 5 mm shift.",
            "start": outlook.get("start"), "hours": (outlook.get("t") or [None])[-1], "guides": outlook.get("guides"),
            "lanes": [{"name": lane.get("name"), "conditions": lane.get("conditions"),
                       "volume_ml_at_end": _end(lane.get("volume")), "midline_shift_mm_at_end": _end(lane.get("mls")),
                       "chance_over_surgical_guide": lane.get("p_over_guide"),
                       "first_over_guide_h": lane.get("first_over_guide_h")}
                      for lane in outlook.get("lanes", [])]}
    return ctx


def _end(band: dict | None):
    if not band:
        return None
    return {k: v[-1] for k, v in band.items() if isinstance(v, list) and v}
