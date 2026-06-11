# src/homie_persona.py
"""Compile a homie's structured persona into its system prompt.

``compile_homie_prompt(persona) -> str`` is a pure, deterministic function:
the same persona dict always yields byte-identical prompt text. The prompt
text is the contract — unit tests in tests/test_homie_persona.py pin it.

Persona shape (all keys optional; unknown keys ignored):

    {
        "name": "Scout",                          # the homie's name
        "motivations": ["ship fast", ...]  | "free text",
        "frustrations": ["scope creep", ...] | "free text",
        "goals": ["keep inbox at zero", ...],     # ordered standing objectives
        "channels": ["Chat", "Email", "Notes", "Tasks", "Calendar"],
        "sliders": {                              # ints 0-100
            "cautious_bold": 50,
            "ask_first_autonomous": 50,
            "deliberate_fast": 50,
            "data_driven_intuitive": 50,
        },
    }

Sliders map to graded natural-language guidance in five bands
(0-19, 20-39, 40-59, 60-79, 80-100); e.g. ask_first_autonomous >= 80 →
"Act without confirmation for reversible steps...".
"""

from typing import Any, Dict, List

# The app surfaces a homie may proactively write to. Order fixed for
# deterministic output; unknown channel names are dropped.
KNOWN_CHANNELS = ("Chat", "Email", "Notes", "Tasks", "Calendar")

# Slider key -> five graded guidance lines, index 0 = band 0-19 ... 4 = 80-100.
SLIDER_BANDS: Dict[str, List[str]] = {
    "cautious_bold": [
        "Be highly cautious: favor the safest available option, flag every risk you see, and recommend rather than act when stakes are unclear.",
        "Lean cautious: prefer proven approaches and call out risks before proceeding.",
        "Balance caution and boldness: take sensible measured risks and note any significant ones.",
        "Lean bold: prefer decisive moves and creative options; accept moderate, recoverable risk without belaboring it.",
        "Be bold: pursue the most impactful option even when unconventional, and treat recoverable setbacks as acceptable costs.",
    ],
    "ask_first_autonomous": [
        "Always ask before acting: confirm with the user before any action beyond answering questions.",
        "Mostly ask first: get confirmation for anything that changes state; only read/look things up freely.",
        "Mixed autonomy: proceed on small reversible steps, but confirm anything significant or hard to undo.",
        "Mostly autonomous: proceed without confirmation except for destructive, irreversible, or externally visible actions.",
        "Act without confirmation for reversible steps; only stop to ask when an action is irreversible or affects other people.",
    ],
    "deliberate_fast": [
        "Be maximally deliberate: think through alternatives and edge cases before answering or acting, even at the cost of speed.",
        "Lean deliberate: prefer thoroughness over speed; double-check work before presenting it.",
        "Balance speed and deliberation appropriate to the task's stakes.",
        "Lean fast: deliver a good answer quickly over a perfect answer slowly; iterate if needed.",
        "Move fast: give your best answer immediately and refine only if asked; speed is the priority.",
    ],
    "data_driven_intuitive": [
        "Be strictly data-driven: ground every claim and decision in verifiable data or sources; refuse to guess.",
        "Lean data-driven: seek numbers and sources first, using judgment only to fill small gaps.",
        "Blend data and intuition: use evidence where available and clearly label judgment calls.",
        "Lean intuitive: trust pattern recognition and experience, citing data when it is readily at hand.",
        "Be intuitive: lead with judgment and gut-feel synthesis, reaching for data only when explicitly required.",
    ],
}

# Display labels for the slider header lines, keyed like SLIDER_BANDS.
SLIDER_LABELS = {
    "cautious_bold": ("Cautious", "Bold"),
    "ask_first_autonomous": ("Ask-first", "Autonomous"),
    "deliberate_fast": ("Deliberate", "Fast"),
    "data_driven_intuitive": ("Data-driven", "Intuitive"),
}

# Fixed slider order for deterministic output.
SLIDER_ORDER = (
    "cautious_bold",
    "ask_first_autonomous",
    "deliberate_fast",
    "data_driven_intuitive",
)

DEFAULT_SLIDER = 50


def _band(value: int) -> int:
    """Map a 0-100 slider value to a band index 0-4."""
    v = max(0, min(100, int(value)))
    return min(v // 20, 4)


def _as_items(value: Any) -> List[str]:
    """Normalize a free-text-or-list persona field to a clean list of strings."""
    if value is None:
        return []
    if isinstance(value, str):
        items = [value]
    elif isinstance(value, (list, tuple)):
        items = [str(v) for v in value]
    else:
        items = [str(value)]
    out = []
    for item in items:
        item = " ".join(str(item).split())  # collapse whitespace
        if item:
            out.append(item)
    return out


def compile_homie_prompt(persona: Dict[str, Any]) -> str:
    """Compile a persona dict into deterministic system-prompt text.

    Pure function: no I/O, no randomness, no timestamps. Unknown keys are
    ignored; missing keys fall back to neutral defaults so an empty dict
    still produces a coherent baseline prompt.
    """
    if not isinstance(persona, dict):
        persona = {}

    name = " ".join(str(persona.get("name") or "").split()) or "Homie"
    lines: List[str] = []

    lines.append(
        f"You are {name}, a persistent AI companion ('homie') working inside the "
        "Happy Homies workspace on behalf of your user."
    )

    motivations = _as_items(persona.get("motivations"))
    if motivations:
        lines.append("")
        lines.append("What drives you:")
        lines.extend(f"- {m}" for m in motivations)

    frustrations = _as_items(persona.get("frustrations"))
    if frustrations:
        lines.append("")
        lines.append("What you push back on:")
        lines.extend(f"- {f}" for f in frustrations)

    goals = _as_items(persona.get("goals"))
    if goals:
        lines.append("")
        lines.append("Your standing objectives, in priority order:")
        lines.extend(f"{i}. {g}" for i, g in enumerate(goals, 1))

    channels = [c for c in KNOWN_CHANNELS if c in _as_items(persona.get("channels"))]
    lines.append("")
    if channels:
        lines.append(
            "When you produce output proactively, deliver it through these "
            "surfaces only: " + ", ".join(channels) + "."
        )
    else:
        lines.append(
            "Deliver output in the current chat unless the user directs otherwise."
        )

    sliders = persona.get("sliders")
    if not isinstance(sliders, dict):
        sliders = {}
    lines.append("")
    lines.append("How you make decisions:")
    for key in SLIDER_ORDER:
        raw = sliders.get(key, DEFAULT_SLIDER)
        try:
            value = max(0, min(100, int(raw)))
        except (TypeError, ValueError):
            value = DEFAULT_SLIDER
        left, right = SLIDER_LABELS[key]
        guidance = SLIDER_BANDS[key][_band(value)]
        lines.append(f"- {left} vs {right} ({value}/100): {guidance}")

    lines.append("")
    lines.append(
        f"Stay in character as {name}. Be useful first; persona color never "
        "overrides correctness, user instructions, or safety."
    )

    return "\n".join(lines)
