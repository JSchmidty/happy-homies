# tests/test_homie_persona.py
"""Unit tests for src.homie_persona.compile_homie_prompt.

The compiled prompt text is the contract between the persona editor and the
agent loop, so these tests pin its structure: determinism, neutral defaults,
all four slider bands' graded language, list/free-text normalization, channel
filtering+ordering, and resilience to junk input.
"""
import importlib.util
from pathlib import Path

# Load src/homie_persona.py directly by file path so this stays a pure unit
# test (importing the src package would drag in heavier modules).
ROOT = Path(__file__).resolve().parents[1]
MOD_PATH = ROOT / "src" / "homie_persona.py"
_spec = importlib.util.spec_from_file_location("_homie_persona_under_test", MOD_PATH)
hp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hp)

compile_homie_prompt = hp.compile_homie_prompt


FULL_PERSONA = {
    "name": "Scout",
    "motivations": ["shipping fast", "clean inboxes"],
    "frustrations": "vague requirements",
    "goals": ["triage email daily", "keep the calendar conflict-free"],
    "channels": ["Email", "Chat"],
    "sliders": {
        "cautious_bold": 85,
        "ask_first_autonomous": 90,
        "deliberate_fast": 10,
        "data_driven_intuitive": 50,
    },
}


# ---------------------------------------------------------------------------
# Determinism + baseline structure
# ---------------------------------------------------------------------------

def test_deterministic_byte_identical():
    a = compile_homie_prompt(FULL_PERSONA)
    b = compile_homie_prompt(dict(FULL_PERSONA))  # fresh dict, same content
    assert a == b


def test_empty_persona_produces_coherent_baseline():
    out = compile_homie_prompt({})
    assert out.startswith("You are Homie,")
    assert "How you make decisions:" in out
    # All four sliders present at neutral default 50.
    assert out.count("(50/100)") == 4
    # No empty sections leak in.
    assert "What drives you:" not in out
    assert "What you push back on:" not in out
    assert "standing objectives" not in out


def test_non_dict_input_treated_as_empty():
    assert compile_homie_prompt(None) == compile_homie_prompt({})
    assert compile_homie_prompt("junk") == compile_homie_prompt({})


def test_name_used_and_whitespace_collapsed():
    out = compile_homie_prompt({"name": "  Captain   Crunch  "})
    assert "You are Captain Crunch," in out
    assert "Stay in character as Captain Crunch." in out


# ---------------------------------------------------------------------------
# Sections: motivations / frustrations / goals
# ---------------------------------------------------------------------------

def test_motivations_list_and_frustrations_string():
    out = compile_homie_prompt(FULL_PERSONA)
    assert "What drives you:\n- shipping fast\n- clean inboxes" in out
    assert "What you push back on:\n- vague requirements" in out


def test_goals_are_ordered_and_numbered():
    out = compile_homie_prompt(FULL_PERSONA)
    assert (
        "Your standing objectives, in priority order:\n"
        "1. triage email daily\n"
        "2. keep the calendar conflict-free"
    ) in out


def test_blank_and_whitespace_items_dropped():
    out = compile_homie_prompt({"motivations": ["", "   ", "real one"]})
    assert "- real one" in out
    assert "\n- \n" not in out


# ---------------------------------------------------------------------------
# Channels
# ---------------------------------------------------------------------------

def test_channels_filtered_to_known_and_canonically_ordered():
    out = compile_homie_prompt(
        {"channels": ["Tasks", "Email", "MySpace", "Chat"]}
    )
    # Canonical order Chat, Email, Tasks regardless of input order; unknown dropped.
    assert "surfaces only: Chat, Email, Tasks." in out
    assert "MySpace" not in out


def test_no_channels_falls_back_to_current_chat():
    out = compile_homie_prompt({})
    assert "Deliver output in the current chat" in out


# ---------------------------------------------------------------------------
# Sliders: graded language per band
# ---------------------------------------------------------------------------

def test_extreme_autonomous_gets_act_without_confirmation():
    out = compile_homie_prompt({"sliders": {"ask_first_autonomous": 90}})
    assert "Act without confirmation for reversible steps" in out


def test_extreme_ask_first_gets_always_ask():
    out = compile_homie_prompt({"sliders": {"ask_first_autonomous": 5}})
    assert "Always ask before acting" in out


def test_band_boundaries():
    # 0-19 -> band 0; 20 -> band 1; 79 -> band 3; 80 -> band 4; 100 clamps to band 4.
    assert "Always ask before acting" in compile_homie_prompt({"sliders": {"ask_first_autonomous": 19}})
    assert "Mostly ask first" in compile_homie_prompt({"sliders": {"ask_first_autonomous": 20}})
    assert "Mostly autonomous" in compile_homie_prompt({"sliders": {"ask_first_autonomous": 79}})
    assert "Act without confirmation" in compile_homie_prompt({"sliders": {"ask_first_autonomous": 80}})
    assert "Act without confirmation" in compile_homie_prompt({"sliders": {"ask_first_autonomous": 100}})


def test_slider_values_clamped_and_junk_defaulted():
    out_high = compile_homie_prompt({"sliders": {"cautious_bold": 9999}})
    assert "(100/100)" in out_high
    out_low = compile_homie_prompt({"sliders": {"cautious_bold": -5}})
    assert "(0/100)" in out_low
    out_junk = compile_homie_prompt({"sliders": {"cautious_bold": "spicy"}})
    assert "(50/100)" in out_junk


def test_extremes_produce_different_prompts():
    lo = compile_homie_prompt({"sliders": {k: 0 for k in hp.SLIDER_ORDER}})
    hi = compile_homie_prompt({"sliders": {k: 100 for k in hp.SLIDER_ORDER}})
    assert lo != hi
    for key in hp.SLIDER_ORDER:
        assert hp.SLIDER_BANDS[key][0] in lo
        assert hp.SLIDER_BANDS[key][4] in hi


def test_all_four_sliders_always_rendered_in_fixed_order():
    out = compile_homie_prompt({})
    i_cb = out.index("Cautious vs Bold")
    i_aa = out.index("Ask-first vs Autonomous")
    i_df = out.index("Deliberate vs Fast")
    i_di = out.index("Data-driven vs Intuitive")
    assert i_cb < i_aa < i_df < i_di
