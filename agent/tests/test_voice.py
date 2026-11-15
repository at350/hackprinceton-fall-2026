"""Offline tests for Cartesia call requests, transcript decisions and polling.

Run from agent/: .venv/bin/python tests/test_voice.py
"""

import re
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lucid import voice  # noqa: E402


class FakeResponse:
    def __init__(self, payload=None, status_code=200, content=True):
        self.status_code = status_code
        self.is_error = status_code >= 400
        self.content = b"response" if content else b""
        self.payload = payload

    def json(self):
        return self.payload


class FakeClient:
    def __init__(self, responses=()):
        self.responses = list(responses)
        self.requests = []

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def request(self, method, path, **kwargs):
        self.requests.append((method, path, kwargs))
        return self.responses.pop(0)


def test_place_call_sends_expected_outbound_request_body():
    client = FakeClient([FakeResponse({"calls": [{"agent_call_id": "call-123"}]})])
    variables = {
        "patient_id": "demo-7",
        "message": "Likely epidural bleed, right parietal, about 7 mL.",
        "report": "Report",
        "evidence": "Evidence",
        "transport": "Unit 4 is 12 minutes away.",
        "unit": "Medic 12",
        "medic_notes": "Patient is stable for transfer.",
    }
    with patch.dict("os.environ", {"CARTESIA_AGENT_ID": "agent-9", "CARTESIA_FROM_NUMBER_ID": "number-4"}), patch.object(voice, "_cartesia", return_value=client):
        call_id = voice.place_call("+15551234567", variables)

    assert call_id == "call-123"
    method, path, kwargs = client.requests[0]
    assert (method, path) == ("POST", "/agents/calls")
    body = kwargs["json"]
    assert body["agent_id"] == "agent-9"
    assert body["from_number_id"] == "number-4"
    assert body["ringing_timeout_seconds"] == 30
    [outbound] = body["outbound_calls"]
    assert outbound["to_number"] == "+15551234567"
    assert outbound["dynamic_variables"] == {
        **variables,
        "voice_prealert": voice._voice_prealert(variables["message"]),
    }


def test_place_call_sanitizes_approved_message_for_voice_prealert():
    client = FakeClient([FakeResponse({"calls": [{"agent_call_id": "call-voice-prealert"}]})])
    approved = (
        "Screening aid flagged a likely epidural bleed, left temporal, approximately 20 mL "
        "(range 15-30 mL), fit 0.97 out of 1. Scan taken 2026-11-14T20:55:37 UTC, "
        "patient patient-call9734. Screening aid, not a diagnosis. Confirm with CT. "
        "Reply ACCEPT or DECLINE."
    )
    with patch.dict("os.environ", {"CARTESIA_AGENT_ID": "agent-9", "CARTESIA_FROM_NUMBER_ID": "number-4"}), patch.object(voice, "_cartesia", return_value=client):
        voice.place_call("+15551234567", {"patient_id": "demo-7", "message": approved, "report": "Report", "evidence": "Evidence"})

    dynamic_variables = client.requests[0][2]["json"]["outbound_calls"][0]["dynamic_variables"]
    spoken = dynamic_variables["voice_prealert"]
    assert "likely" in spoken.lower()
    assert "epidural" in spoken.lower()
    assert "left temporal" in spoken.lower()
    assert "20 mL" in spoken or "20 mils" in spoken.lower()
    assert "approximately" in spoken.lower() or "about" in spoken.lower()
    for excluded in ("15-30", "range", "0.97", "fit", "2026-11-14", "20:55:37", "patient-call9734", "diagnosis", "CT", "ACCEPT", "DECLINE"):
        assert excluded.lower() not in spoken.lower(), (excluded, spoken)
    assert len(spoken.split()) <= 20  # concise; it need not quote the approved report verbatim


def test_voice_prealert_does_not_invent_missing_finding_details():
    spoken = voice._voice_prealert("The screening result needs clinician review.")

    for absent_detail in ("epidural", "bleed", "temporal", "mL", "left", "right"):
        assert absent_detail not in spoken.lower()


def test_transport_defaults_honestly_and_preserves_supplied_text():
    def call_with(variables):
        client = FakeClient([FakeResponse({"calls": [{"agent_call_id": "call-transport"}]})])
        with patch.dict("os.environ", {"CARTESIA_AGENT_ID": "agent-9", "CARTESIA_FROM_NUMBER_ID": "number-4"}), patch.object(voice, "_cartesia", return_value=client):
            voice.place_call("+15551234567", {"patient_id": "demo-7", "message": "A small left temporal finding.", **variables})
        return client.requests[0][2]["json"]["outbound_calls"][0]["dynamic_variables"]

    defaults = call_with({})
    assert defaults["transport"] == "Transport location and ETA are not available."
    assert defaults["unit"] == "an unspecified unit"
    assert defaults["medic_notes"] == "not provided"
    supplied = call_with({
        "transport": "Ground unit 4 is 12 minutes away.",
        "unit": "Medic 12",
        "medic_notes": "Patient is stable for transfer.",
    })
    assert supplied["transport"] == "Ground unit 4 is 12 minutes away."
    assert supplied["unit"] == "Medic 12"
    assert supplied["medic_notes"] == "Patient is stable for transfer."


def test_initial_message_speaks_prealert_and_transport_without_handshake():
    initial = voice.INITIAL
    assert "{{unit}}" not in initial
    assert "automated" not in initial.lower()
    assert "{{voice_prealert}}" in initial
    assert "{{transport}}" in initial
    assert "Can you take the patient?" in initial
    assert initial.index("{{voice_prealert}}") < initial.index("{{transport}}") < initial.index("Can you take the patient?")
    assert "accept or decline" not in initial.lower()


def test_prompt_pins_distinct_decision_closings_and_keeps_acknowledgements_open():
    prompt = voice.INSTRUCTIONS
    assert 'say exactly "Great, I\'ll text you a recap."' in prompt
    assert 'say exactly "Understood. I\'ll let the medic know and text you a recap."' in prompt
    assert 'Can you take them, or do you need anything first?' in prompt


def test_place_call_rejects_cartesia_per_call_errors():
    failures = (
        {"calls": []},
        {"calls": [{"error": "provider declined", "agent_call_id": "call-1"}]},
        {"calls": [{"agent_call_id": ""}]},
        {},
    )
    for payload in failures:
        client = FakeClient([FakeResponse(payload)])
        with patch.dict("os.environ", {"CARTESIA_AGENT_ID": "agent-9", "CARTESIA_FROM_NUMBER_ID": "number-4"}), patch.object(voice, "_cartesia", return_value=client):
            try:
                voice.place_call("+15551234567", {})
            except RuntimeError as exc:
                assert str(exc) == "Cartesia did not start the call"
            else:
                raise AssertionError(f"Expected call-start error for response {payload!r}")


def test_request_http_errors_hide_response_body():
    client = FakeClient([FakeResponse({"secret": "patient data"}, status_code=503)])
    try:
        voice._request(client, "GET", "/agents/calls/call-1")
    except RuntimeError as exc:
        assert str(exc) == "GET /agents/calls/call-1 returned HTTP 503"
        assert "patient data" not in str(exc)
    else:
        raise AssertionError("Expected HTTP failure")


def test_request_returns_none_for_empty_success_body():
    client = FakeClient([FakeResponse(content=False)])
    assert voice._request(client, "POST", "/agents/calls") is None


def test_result_uses_only_user_turns_for_decision():
    call = {"transcript": [
        {"role": "assistant", "text": "Do you accept?"},
        {"role": "user", "text": "I accept the pre-alert."},
        {"role": "assistant", "text": "Thank you."},
    ]}
    result = voice._result(call)
    assert result["decision"] == "accept"
    assert result["note"] == "I accept the pre-alert."
    assert result["answered"] is True
    assert result["transcript"] == call["transcript"]


def test_result_keeps_ambiguous_or_conflicting_user_words_undecided():
    ambiguous = voice._result({"transcript": [{"role": "user", "text": "Should we accept or decline the patient?"}]})
    conflicting = voice._result({"transcript": [
        {"role": "user", "text": "I accept."},
        {"role": "user", "text": "Actually, decline."},
    ]})
    assistant_only = voice._result({"transcript": [{"role": "assistant", "text": "The clinician accepted."}]})

    assert ambiguous["decision"] == "none" and ambiguous["note"] == ""
    assert conflicting["decision"] == "none" and conflicting["note"] == ""
    assert assistant_only["decision"] == "none" and assistant_only["note"] == ""
    assert assistant_only["answered"] is True  # transcript exists, even without a user decision


def test_explicit_acceptance_overrides_question_and_earlier_conditional():
    question_then_accept = voice._result({"transcript": [{
        "role": "user", "text": "Can I accept or decline the patient? I accept the patient.",
    }]})
    conditional_then_accept = voice._result({"transcript": [{
        "role": "user", "text": "I cannot accept until the receiving team confirms, but I accept the patient.",
    }]})

    assert question_then_accept["decision"] == "accept"
    assert conditional_then_accept["decision"] == "accept"


def test_question_or_conditional_without_explicit_patient_decision_is_none():
    question = voice._result({"transcript": [{"role": "user", "text": "Should we accept or decline the patient?"}]})
    conditional = voice._result({"transcript": [{"role": "user", "text": "I cannot accept until the receiving team confirms."}]})

    assert question["decision"] == "none"
    assert conditional["decision"] == "none"


def test_result_treats_negated_user_decisions_as_undecided():
    cannot_accept = voice._result({"transcript": [{"role": "user", "text": "I cannot accept."}]})
    do_not_decline = voice._result({"transcript": [{"role": "user", "text": "Do not decline."}]})
    decline_to_talk = voice._result({"transcript": [{"role": "user", "text": "I decline to talk."}]})
    decline_the_call = voice._result({"transcript": [{"role": "user", "text": "I decline this call."}]})
    decline_the_patient = voice._result({"transcript": [{"role": "user", "text": "I decline the patient."}]})

    assert cannot_accept["decision"] == "none" and cannot_accept["note"] == ""
    assert do_not_decline["decision"] == "none" and do_not_decline["note"] == ""
    assert decline_to_talk["decision"] == "none" and decline_to_talk["note"] == ""
    assert decline_the_call["decision"] == "none" and decline_the_call["note"] == ""
    assert decline_the_patient["decision"] == "decline"


def test_result_prefixes_no_decision_and_suppresses_misleading_provider_summary():
    result = voice._result({
        "transcript": [{"role": "user", "text": "I decline this call."}],
        "summary": "The clinician declined the patient.",
    })

    assert result["decision"] == "none"
    assert result["summary"].startswith("No decision was given on the call.")
    assert "The clinician declined the patient." not in result["summary"]
    assert "declined the patient" not in result["summary"].lower()


def test_result_prefixes_missing_provider_summary_when_decision_is_none():
    result = voice._result({"transcript": [{"role": "user", "text": "I cannot accept."}]})

    assert result["decision"] == "none"
    assert result["summary"].startswith("No decision was given on the call.")


def test_result_does_not_add_no_decision_prefix_for_patient_decisions():
    accepted = voice._result({
        "transcript": [{"role": "user", "text": "I accept the patient."}],
        "summary": "The clinician accepts the transfer.",
    })
    declined = voice._result({
        "transcript": [{"role": "user", "text": "I decline the patient."}],
        "summary": "The clinician declines the patient.",
    })

    assert accepted["decision"] == "accept"
    assert declined["decision"] == "decline"
    assert not accepted["summary"].startswith("No decision was given on the call.")
    assert not declined["summary"].startswith("No decision was given on the call.")
    assert accepted["summary"] == "The clinician accepts the transfer."
    assert declined["summary"] == "The clinician declines the patient."


def test_result_reports_no_answer_for_empty_transcript():
    result = voice._result({"transcript": [], "summary": "No answer"})
    assert result["answered"] is False
    assert result["decision"] == "none"
    assert result["note"] == ""
    assert result["summary"].startswith("No decision was given on the call.")


def test_cartesia_voicemail_end_reason_is_decisive_even_without_transcript():
    result = voice._result({"end_reason": "voicemail_detected", "transcript": []})

    assert result["answered"] is False
    assert result["answered_at"] is None
    assert result["decision"] == "none"


def test_carrier_voicemail_phrase_with_separate_goodbye_is_not_a_clinician_answer():
    result = voice._result({"transcript": [
        {"role": "user", "text": "The person you are trying to reach is not available. Please leave a message after the tone."},
        {"role": "user", "text": "Goodbye."},
    ], "start_time": "2026-11-14T20:55:37Z"})

    assert result["answered"] is False
    assert result["answered_at"] is None
    assert result["decision"] == "none"


def test_each_listed_carrier_phrase_is_recognized_as_voicemail():
    phrases = (
        "This is my voicemail.",
        "Your mailbox is full.",
        "This mailbox has not been set up.",
        "The person is not available.",
        "Please leave a message.",
        "Speak after the tone.",
        "Please try your call again later.",
        "The person you are trying to reach is busy.",
        "Your call cannot be completed as dialed.",
    )

    for phrase in phrases:
        result = voice._result({"transcript": [{"role": "user", "text": phrase}]})
        assert result["answered"] is False, (phrase, result)
        assert result["answered_at"] is None, (phrase, result)


def test_standalone_goodbye_and_assistant_only_behavior_remain_unchanged():
    goodbye = voice._result({"transcript": [{"role": "user", "text": "Goodbye."}], "start_time": "2026-11-14T20:55:37Z"})
    assistant_only = voice._result({"transcript": [{"role": "assistant", "text": "Goodbye."}], "start_time": "2026-11-14T20:55:37Z"})
    no_transcript = voice._result({"transcript": [], "start_time": "2026-11-14T20:55:37Z"})

    assert goodbye["answered"] is True
    assert goodbye["answered_at"] == "2026-11-14T20:55:37Z"
    assert assistant_only["answered"] is True
    assert assistant_only["answered_at"] == "2026-11-14T20:55:37Z"
    assert no_transcript["answered"] is False
    assert no_transcript["answered_at"] is None


def test_real_clinician_turn_mixed_with_voicemail_words_remains_answered():
    start_time = "2026-11-14T20:55:37Z"
    result = voice._result({"transcript": [
        {"role": "user", "text": "I heard the voicemail say leave a message after the tone."},
        {"role": "user", "text": "I accept the patient."},
    ], "start_time": start_time})

    assert result["answered"] is True
    assert result["answered_at"] == start_time
    assert result["decision"] == "accept"


def test_voicemail_prompt_requires_silence_and_disables_spoken_tool_message():
    instructions = voice.INSTRUCTIONS.lower()
    voicemail_start = instructions.index("if you hear a voicemail greeting")
    voicemail_instruction = instructions[voicemail_start:instructions.index("\n\n", voicemail_start)]
    config = voice.AGENT_CONFIG["system_tools"]["voicemail_detection"]

    assert "stop speaking immediately" in voicemail_instruction
    assert "without saying anything further" in voicemail_instruction
    assert "never leave a message" in voicemail_instruction
    assert config["pre_tool_speech"] == "off"
    assert config["message"] is None


def test_wait_for_call_returns_voicemail_without_answer_timestamp():
    client = FakeClient([FakeResponse({
        "status": "completed",
        "end_reason": "voicemail_detected",
        "transcript": [],
        "start_time": "2026-11-14T20:55:37Z",
    })])
    with patch.object(voice, "_cartesia", return_value=client), patch.object(voice.time, "monotonic", return_value=10):
        result = voice.wait_for_call("call-voicemail", timeout_s=5)

    assert [request[:2] for request in client.requests] == [("GET", "/agents/calls/call-voicemail")]
    assert result["answered"] is False
    assert result["answered_at"] is None
    assert result["decision"] == "none"


def test_result_preserves_raw_api_answer_and_end_timestamps():
    answered_at = "2026-11-14T20:55:37.123Z"
    ended_at = "2026-11-14T21:03:05.987+00:00"
    result = voice._result({
        "transcript": [{"role": "user", "text": "I accept the patient."}],
        "start_time": answered_at,
        "end_time": ended_at,
    })

    assert result["answered_at"] == answered_at
    assert result["ended_at"] == ended_at


def test_result_uses_last_user_note_when_decision_is_consistent():
    result = voice._result({"transcript": [
        {"role": "user", "text": "I accepted."},
        {"role": "user", "text": "Still accepting."},
    ]})
    assert result["decision"] == "accept"
    assert result["note"] == "Still accepting."


def test_anything_else_responses_do_not_change_a_confirmed_patient_decision():
    followups = ("No.", "Nope.", "That's all.", "No thanks.")
    for followup in followups:
        result = voice._result({"transcript": [
            {"role": "assistant", "text": "Just to confirm, you're accepting the patient?"},
            {"role": "user", "text": "Yes."},
            {"role": "assistant", "text": "Anything else I can help with?"},
            {"role": "user", "text": followup},
        ]})
        assert result["decision"] == "accept", (followup, result)

    declined = voice._result({"transcript": [
        {"role": "assistant", "text": "So that's a decline?"},
        {"role": "user", "text": "Correct."},
        {"role": "assistant", "text": "Anything else I can help with?"},
        {"role": "user", "text": "No thanks."},
    ]})
    assert declined["decision"] == "decline"


def test_yes_to_anything_else_is_not_a_patient_decision():
    result = voice._result({"transcript": [
        {"role": "assistant", "text": "Anything else I can help with?"},
        {"role": "user", "text": "Yes."},
    ]})

    assert result["decision"] == "none"
    assert result["note"] == ""


def test_a_separately_confirmed_opposite_readback_reverses_the_decision():
    result = voice._result({"transcript": [
        {"role": "assistant", "text": "Just to confirm, you're accepting the patient?"},
        {"role": "user", "text": "Yes."},
        {"role": "assistant", "text": "Anything else I can help with?"},
        {"role": "user", "text": "Actually, I decline the patient."},
        {"role": "assistant", "text": "So that's a decline?"},
        {"role": "user", "text": "Yes."},
    ]})

    assert result["decision"] == "decline"


def test_unconfirmed_reversal_and_contradictory_decisions_stay_undecided():
    unconfirmed_reversal = voice._result({"transcript": [
        {"role": "assistant", "text": "Just to confirm, you're accepting the patient?"},
        {"role": "user", "text": "Yes."},
        {"role": "user", "text": "Actually, I decline the patient."},
        {"role": "assistant", "text": "So that's a decline?"},
        {"role": "user", "text": "No."},
    ]})
    contradictory = voice._result({"transcript": [
        {"role": "assistant", "text": "Just to confirm, you're accepting the patient?"},
        {"role": "user", "text": "Yes."},
        {"role": "user", "text": "I decline the patient."},
    ]})

    assert unconfirmed_reversal["decision"] == "none"
    assert contradictory["decision"] == "none"


def test_natural_unconfirmed_reversal_needs_a_new_confirmation():
    for reversal in ("Actually, we cannot take them.", "Actually, I cannot accept.", "We are full."):
        result = voice._result({"transcript": [
            {"role": "assistant", "text": "You're accepting the patient?"},
            {"role": "user", "text": "Yes."},
            {"role": "assistant", "text": "Anything else you need?"},
            {"role": "user", "text": reversal},
        ]})
        assert result["decision"] == "none", reversal


def test_prompt_pins_both_closings_and_limits_followups_after_decisions():
    prompt = voice.INSTRUCTIONS
    lower = prompt.lower()
    assert 'Great, I\'ll text you a recap.' in prompt
    assert 'Understood. I\'ll let the medic know and text you a recap.' in prompt
    assert re.search(
        r"(?:(?:at most|no more than) two.{0,100}anything else.{0,100}(?:in a row|consecutive)"
        r"|never ask anything else more than twice in a row)",
        lower,
    )
    assert re.search(r"(?:refusal|voicemail).{0,140}(?:no follow.?up|do not ask|stop speaking|without saying anything further)", lower)


def test_affirmative_readback_answers_single_option_assistant_question():
    cases = (
        ("Can you accept the patient?", "Yes.", "accept"),
        ("Can you accept the patient?", "Yeah.", "accept"),
        ("Can you accept the patient?", "Correct.", "accept"),
        ("Can you accept the patient?", "That's right.", "accept"),
        ("Can you accept the patient?", "Confirmed.", "accept"),
        ("Would you decline the patient?", "Yes.", "decline"),
        ("Would you decline the patient?", "Yeah.", "decline"),
        ("Would you decline the patient?", "Correct.", "decline"),
        ("Would you decline the patient?", "That's right.", "decline"),
        ("Would you decline the patient?", "Confirmed.", "decline"),
    )

    for question, answer, expected in cases:
        result = voice._result({"transcript": [
            {"role": "assistant", "text": question},
            {"role": "user", "text": answer},
        ]})
        assert result["decision"] == expected, (question, answer, result)
        assert result["note"] == answer


def test_readback_does_not_treat_no_negation_questions_or_ambiguity_as_decisions():
    cases = (
        ("Can you accept the patient?", "No.", "none"),
        ("Can you accept the patient?", "I can't accept until I know the ETA.", "none"),
        ("Can you accept the patient?", "Yes, but should I accept?", "none"),
        ("Can you accept or decline the patient?", "Yes.", "none"),
        ("Can you accept or decline the patient?", "Confirmed.", "none"),
        ("Can you accept the patient?", "We can take them.", "none"),
        ("Can you decline the patient?", "I cannot say yes yet.", "none"),
    )

    for question, answer, expected in cases:
        result = voice._result({"transcript": [
            {"role": "assistant", "text": question},
            {"role": "user", "text": answer},
        ]})
        assert result["decision"] == expected, (question, answer, result)


def test_readback_requires_the_immediately_preceding_dialogue_turn_to_be_question():
    intervening_user_turn = voice._result({"transcript": [
        {"role": "assistant", "text": "Can you accept the patient?"},
        {"role": "user", "text": "What is the transport ETA?"},
        {"role": "user", "text": "Yes."},
    ]})
    new_assistant_question = voice._result({"transcript": [
        {"role": "assistant", "text": "Can you accept the patient?"},
        {"role": "assistant", "text": "Do you have any questions?"},
        {"role": "user", "text": "Yes."},
    ]})

    assert intervening_user_turn["decision"] == "none"
    assert new_assistant_question["decision"] == "none"


def test_system_and_tool_metadata_are_not_spoken_dialogue_for_decisions():
    metadata_only = voice._result({"transcript": [
        {"role": "system", "text": "The clinician accepts the patient."},
        {"role": "tool", "text": "I accept the patient."},
        {"role": "assistant", "tool_call": {"name": "end_call", "arguments": "decline"}},
    ]})
    system_question_does_not_enable_user_yes = voice._result({"transcript": [
        {"role": "system", "text": "Would you decline the patient?"},
        {"role": "user", "text": "Yes."},
    ]})
    real_dialogue_ignores_interleaved_metadata = voice._result({"transcript": [
        {"role": "assistant", "text": "Can you accept the patient?"},
        {"role": "tool", "text": "The user said accept."},
        {"role": "system", "text": "decision=decline"},
        {"role": "user", "text": "Confirmed."},
    ]})

    assert metadata_only["decision"] == "none"
    assert system_question_does_not_enable_user_yes["decision"] == "none"
    assert real_dialogue_ignores_interleaved_metadata["decision"] == "accept"


def test_wait_for_call_polls_until_terminal_status_and_caps_sleep():
    client = FakeClient([
        FakeResponse({"status": "ringing", "transcript": []}),
        FakeResponse({"status": "completed", "transcript": [{"role": "user", "text": "Decline."}]}),
    ])
    sleeps = []
    with patch.object(voice, "_cartesia", return_value=client), patch.object(voice.time, "monotonic", side_effect=[10, 11]), patch.object(voice.time, "sleep", side_effect=sleeps.append):
        result = voice.wait_for_call("call-42", timeout_s=5)

    assert [request[:2] for request in client.requests] == [
        ("GET", "/agents/calls/call-42"), ("GET", "/agents/calls/call-42"),
    ]
    assert sleeps == [3]
    assert result["decision"] == "decline"


def test_wait_for_call_times_out_using_remaining_deadline():
    client = FakeClient([
        FakeResponse({"status": "ringing", "transcript": []}),
        FakeResponse({"status": "ringing", "transcript": []}),
    ])
    sleeps = []
    with patch.object(voice, "_cartesia", return_value=client), patch.object(voice.time, "monotonic", side_effect=[100, 100, 102]), patch.object(voice.time, "sleep", side_effect=sleeps.append):
        try:
            voice.wait_for_call("call-42", timeout_s=2)
        except TimeoutError as exc:
            assert str(exc) == "Timed out waiting for Cartesia call to end"
        else:
            raise AssertionError("Expected polling timeout")

    assert len(client.requests) == 2
    assert sleeps == [2]


if __name__ == "__main__":
    tests = [f for name, f in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
        print("ok ", test.__name__)
    print(len(tests), "passed")
