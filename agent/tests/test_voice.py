"""Offline tests for Cartesia call requests, transcript decisions and polling.

Run from agent/: .venv/bin/python tests/test_voice.py
"""

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
    variables = {"patient_id": "demo-7", "message": "Approved pre-alert", "report": "Report", "evidence": "Evidence"}
    with patch.dict("os.environ", {"CARTESIA_AGENT_ID": "agent-9", "CARTESIA_FROM_NUMBER_ID": "number-4"}), patch.object(voice, "_cartesia", return_value=client):
        call_id = voice.place_call("+15551234567", variables)

    assert call_id == "call-123"
    assert client.requests == [(
        "POST", "/agents/calls", {"json": {
            "agent_id": "agent-9",
            "from_number_id": "number-4",
            "ringing_timeout_seconds": 30,
            "outbound_calls": [{"to_number": "+15551234567", "dynamic_variables": variables}],
        }},
    )]


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
    ambiguous = voice._result({"transcript": [{"role": "user", "text": "Should we accept or decline?"}]})
    conflicting = voice._result({"transcript": [
        {"role": "user", "text": "I accept."},
        {"role": "user", "text": "Actually, decline."},
    ]})
    assistant_only = voice._result({"transcript": [{"role": "assistant", "text": "The clinician accepted."}]})

    assert ambiguous["decision"] == "none" and ambiguous["note"] == ""
    assert conflicting["decision"] == "none" and conflicting["note"] == ""
    assert assistant_only["decision"] == "none" and assistant_only["note"] == ""
    assert assistant_only["answered"] is True  # transcript exists, even without a user decision


def test_result_treats_negated_user_decisions_as_undecided():
    cannot_accept = voice._result({"transcript": [{"role": "user", "text": "I cannot accept."}]})
    do_not_decline = voice._result({"transcript": [{"role": "user", "text": "Do not decline."}]})

    assert cannot_accept["decision"] == "none" and cannot_accept["note"] == ""
    assert do_not_decline["decision"] == "none" and do_not_decline["note"] == ""


def test_result_reports_no_answer_for_empty_transcript():
    result = voice._result({"transcript": [], "summary": "No answer"})
    assert result["answered"] is False
    assert result["decision"] == "none"
    assert result["note"] == ""
    assert result["summary"] == "No answer"


def test_result_uses_last_user_note_when_decision_is_consistent():
    result = voice._result({"transcript": [
        {"role": "user", "text": "I accepted."},
        {"role": "user", "text": "Still accepting."},
    ]})
    assert result["decision"] == "accept"
    assert result["note"] == "Still accepting."


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
