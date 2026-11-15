"""Cartesia managed-agent calls over a Photon SIP trunk."""
from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
import secrets
import time

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
ENV = ROOT / '.env'
# The bridge is a separate process and may start before setup adds the IDs.
load_dotenv(ENV)
CARTESIA = 'https://api.cartesia.ai'
PHOTON = 'https://api.photon.codes'
INSTRUCTIONS = '''You are Lucid, an automated screening aid calling the on-call clinician with a medic-approved pre-alert. Speak like a calm, competent medic talking to another clinician. The initial message already introduces you, delivers the headline and transport, and asks whether they can take the patient. Do not repeat it. If the line is silent after the opening, use one light human check-in, such as "Are you there?" or "Can you take them?"; do this only once. If asked who or what you are, answer truthfully in one short sentence: you are Lucid, the scan assistant the medic is using. Never claim to be a person.

Listen first. One thought per turn. Use contractions, spoken numbers, and occasional brief acknowledgements like "Sure" or "Yep, one sec" where natural, with no padding. Answer the specific question directly from the information below and stop. Do not tack on an acceptance question after a single factual answer; ask it again naturally only after a pause or two or three answers, varying the wording. Give fit, range, measurement method, contact quality, and competing findings only when asked. If interrupted, stop, listen and answer the question. If the person pushes back or is short, stay calm and natural, for example "Fair enough. What do you need to know?" If a fact is missing, say plainly and naturally that you do not have it and the medic can radio it over; never claim details are in their messages unless they are.

An acknowledgement such as "go ahead", "okay" or "right" by itself is not a patient decision or a read-back confirmation; offer only one short follow-up, for example "Can you take them, or do you need anything first?", then listen. Do not repeat the pre-alert or volunteer the medic notes, vital signs, age or mechanism after an acknowledgement; those details are for direct questions. A patient decision may be expressed in ordinary words, such as "bring them in", "we can take them", "we're full" or "divert". When you hear an apparent decision, do not end yet. Read it back as a closed confirmation question containing exactly one decision word: for acceptance, "Just to confirm, you're accepting the patient?"; for decline, "So that's a decline?" The read-back question is an ordinary spoken turn, never a tool call or pre-tool speech. STOP and wait for their next turn. Do not invoke end_call when asking the read-back, or because they said "bring them in" or "divert"; those are not a confirmation. Only a clear affirmative in a later separate user turn, such as "yes", "yeah", "correct", "that's right" or "confirmed", confirms it. If they say no or ask a question, that is not confirmation; listen and clarify. Once they affirm the read-back, do not invoke end_call yet. Ask one short natural question such as "Got it. Anything else you need from me?" and listen. If they ask a question, answer directly from the approved facts in one thought, then ask once more whether they need anything else. If they answer yes to the anything-else question, wait for their question: that yes is not a decision confirmation. If they say no, nope, that's all, no thanks, goodbye, or remain silent for a few seconds after your anything-else check, say the appropriate fixed closing and invoke end_call. Use the inactivity check-in as the cue to close after silence; do not ask another question then. Never ask anything else more than twice in a row without an intervening question. If they change their mind, read the new decision back and wait for a clear affirmative before accepting the reversal. For an accepted patient, say exactly "Great, I'll text you a recap." before ending. For a declined patient, say exactly "Understood. I'll let the medic know and text you a recap." before ending.

If you hear a voicemail greeting or carrier announcement, stop speaking immediately and invoke voicemail_detection without saying anything further. Never leave a message or disclose clinical details to a recording.

Never ask whether they need anything else after a genuine refusal to talk or a voicemail greeting. A question, objection, "wait", or a "no" followed by a question is not a refusal to talk. Only if they actually refuse to speak, cannot talk, say not now or stop calling, or say wrong person or number: stop, disclose no further clinical information, say exactly "Understood. The details are in your messages; reply ACCEPT or DECLINE there.", and end the call. This is no decision given, not a patient decline. Do not hang up merely because someone is hostile.

Never invent facts, never claim a diagnosis, and never give treatment advice. Repeat ages and other numbers as given, preserving qualifiers such as "about"; do not turn an approximate value into an exact one. Describe what the screening scan suggests. Do not say "not a diagnosis", "confirm with CT", or similar disclaimers unless directly asked whether it is a diagnosis. If a detail is absent, say you do not have it. Use only these approved facts:
Headline: {{voice_prealert}}
Transport and ETA: {{transport}}
Medic unit: {{unit}}
Medic notes: {{medic_notes}}
Approved pre-alert: {{message}}
Approved report: {{report}}
Evidence: {{evidence}}
Patient ID, only when asked: {{patient_id}}'''
INITIAL = "Hi, this is Lucid. I've got a head-injury pre-alert: {{voice_prealert}} {{transport}} Can you take the patient?"
VOICE_ID = 'aa2cafe9-97ba-4052-ac3c-875000f95212'  # Zander, measured and calm.
MODEL_ID = 'gpt-5.4'  # Better read-back turn-taking in the managed-model preview.
AGENT_CONFIG = {'instructions': INSTRUCTIONS, 'initial_message': INITIAL,
                'initial_message_interruptions': 'allow',
                'audio': {'output': {'voice_id': VOICE_ID, 'speed': 1.1}},
                'turn': {'inactivity_check_in_secs': 5, 'inactivity_end_call_secs': 60},
                'model': {'id': MODEL_ID}, 'speculative_generation': True,
                'system_tools': {'end_call': {'pre_tool_speech': 'force', 'description': 'Never call this tool while asking a read-back question. After a separately confirmed read-back, ask whether they need anything else and listen. End only after they say no or goodbye, or are silent for a few seconds after that question. Use the decision-specific closing. For a genuine refusal to talk, say the refusal line and end without the check.'},
                                 'voicemail_detection': {'description': 'Use immediately when you hear a voicemail greeting or carrier announcement. Do not speak or leave a message.', 'pre_tool_speech': 'off', 'message': None}}}


def enabled() -> bool:
    load_dotenv(ENV)
    return all(os.getenv(k) for k in ('CARTESIA_API_KEY', 'CARTESIA_AGENT_ID', 'CARTESIA_FROM_NUMBER_ID'))


def _cartesia() -> httpx.Client:
    load_dotenv(ENV)
    return httpx.Client(base_url=CARTESIA, headers={'X-API-Key': os.environ['CARTESIA_API_KEY'], 'Cartesia-Version': '2026-08-14'}, timeout=20)


def _request(client, method, path, **kwargs):
    response = client.request(method, path, **kwargs)
    if response.is_error:
        # Bodies may contain credentials or patient data: never include them in errors.
        raise RuntimeError(f'{method} {path} returned HTTP {response.status_code}')
    return response.json() if response.content else None


def _voice_prealert(message):
    """Condense the approved finding without inventing details or reading log fields."""
    message = str(message or "")
    sentences = re.split(r"(?<=[.!?])\s+|[\r\n]+", message)
    finding_text = next((part for part in sentences if re.search(r"\bbleed\b", part, re.I)), "")
    if finding_text and not re.search(r"\b(?:no|not|without|negative|absence|ruled out|unlikely)\b.{0,50}\bbleed\b", finding_text, re.I | re.S):
        kind = re.search(r"\b(epidural|subdural|intraparenchymal)\b", finding_text, re.I)
        side = re.search(r"\b(left|right)\b", finding_text, re.I)
        region = re.search(r"\b(temporal|frontal|parietal|occipital)\b", finding_text, re.I)
        qualifier = re.search(r"\b(likely|possible|suspected)\b", finding_text, re.I)
        size = re.search(r"\b(\d+(?:\.\d+)?)\s*(?:mL|millilit(?:er|re)s?)\b", finding_text, re.I)
        parts = [m.group(1).lower() for m in (qualifier, side, region, kind) if m]
        description = " ".join([*parts, "bleed"])
        article = "an" if description[0] in "aeiou" else "a"
        finding = f"The scan suggests {article} {description}"
        if size:
            finding += f", about {size.group(1)} mils"
        return finding + "."
    # For unusual reports preserve only a short finding, never IDs, times or scoring fields.
    text = re.sub(r"(?i)\bscreening aid\s*[,;:-]?\s*not a diagnosis\.?", "", message)
    for part in re.split(r"(?<=[.!?])\s+|[\r\n]+", text):
        if re.search(r"\b(?:diagnos\w*|CT|accept|declin\w*|reply|fit|range|patient|scan taken)\b|\d{4}-\d\d-\d\d", part, re.I):
            continue
        if part.strip() and not re.fullmatch(r"(?:Lucid\s+)?pre-?alert\s*[:.,-]?", part.strip(), re.I):
            return part.strip()
    return "Please review the pre-alert in your messages."


def place_call(to_number, variables):
    variables = {**variables, 'voice_prealert': _voice_prealert(variables.get('message')),
                 'transport': str(variables.get('transport') or 'Transport location and ETA are not available.'),
                 'unit': str(variables.get('unit') or 'an unspecified unit'),
                 'medic_notes': str(variables.get('medic_notes') or 'not provided')}
    with _cartesia() as client:
        result = _request(client, 'POST', '/agents/calls', json={
            'agent_id': os.environ['CARTESIA_AGENT_ID'],
            'from_number_id': os.environ['CARTESIA_FROM_NUMBER_ID'],
            'ringing_timeout_seconds': 30,
            'outbound_calls': [{'to_number': to_number, 'dynamic_variables': variables}],
        })
    calls = result.get('calls') or []
    if not calls or calls[0].get('error') or not calls[0].get('agent_call_id'):
        raise RuntimeError('Cartesia did not start the call')
    return calls[0]['agent_call_id']


_MACHINE_PHRASES = re.compile(
    r"\b(?:voicemail|voice mail|mailbox|mail box|has not been set up|is not available|"
    r"leave a message|after the tone|try your call again|"
    r"the person you are trying to reach|cannot be completed)\b", re.I)
_MACHINE_SIGNOFF = re.compile(r"\s*(?:goodbye|good bye|bye)[.!\s]*\Z", re.I)


def _machine_answered(call, transcript):
    # Cartesia's tool can positively detect voicemail even with no transcript.
    if call.get('end_reason') == 'voicemail_detected':
        return True
    turns = [str(t.get('text') or '').strip() for t in transcript
             if t.get('role') == 'user' and str(t.get('text') or '').strip()]
    # STT can split an announcement and its closing "Goodbye" into separate turns.
    # Require at least one machine phrase and reject mixed, substantive human speech.
    return bool(turns and any(_MACHINE_PHRASES.search(t) for t in turns)
                and all(_MACHINE_PHRASES.search(t) or _MACHINE_SIGNOFF.fullmatch(t)
                        for t in turns))


def _result(call):
    transcript = call.get('transcript') or []
    machine = _machine_answered(call, transcript)
    # Only the clinician's own words count. Ambiguous or conflicting words stay undecided.
    matches = []
    preceding = None
    for turn in transcript:
        role, text = turn.get('role'), turn.get('text') or ''
        if role not in ('user', 'assistant') or not text.strip():
            continue
        if role == 'assistant':
            preceding = ('assistant', text)
            continue
        had_prior_decision = bool(matches)
        # Only a clear affirmative to the immediately preceding spoken read-back counts.
        if preceding and preceding[0] == 'assistant':
            question = preceding[1]
            options = {'accept' if m.group().lower().startswith('accept') else 'decline'
                       for m in re.finditer(r"\b(accept(?:ed|ing)?|declin(?:e|ed|ing))\b", question, re.I)}
            affirmative = re.match(r"^\s*(?:yes|yeah|yep|correct|that's right|that is right|confirmed|affirmative)\b", text, re.I)
            negative = re.search(r"\b(?:no|not|never|don'?t|doesn'?t|can'?t|cannot|won'?t|unable)\b", text, re.I)
            question_words = re.search(r"\b(?:where|when|why|how|what|who|which)\b", text, re.I)
            anything_else = re.search(r"\b(?:anything|something|anyone|anybody)\s+else\b", question, re.I)
            if '?' in question and len(options) == 1 and affirmative and not negative and not question_words and '?' not in text and not anything_else:
                # A separately confirmed read-back supersedes prior decisions,
                # including an explicit or implied reversal.
                matches = [(next(iter(options)), text)]
        # An explicit user decision still counts; questions and hypotheticals do not.
        for clause in re.split(r"(?<=[.!?])\s+|,\s*(?:but|however)\s+", text, flags=re.I):
            words = list(re.finditer(r'\b(accept(?:ed|ing)?|declin(?:e|ed|ing))\b', clause, re.I))
            if '?' in clause or re.search(r"\b(?:before|if|whether|until)\b", clause, re.I):
                continue
            valid = []
            for m in words:
                if re.search(r"\b(not|no|never|don'?t|doesn'?t|can'?t|cannot|won'?t|unable to)\s+(\w+\s+)?$", clause[:m.start()], re.I):
                    continue
                if re.match(r"\s+(?:to\s+(?:talk|speak|listen|hear|continue)|(?:this|the|your)\s+(?:call|conversation))\b", clause[m.end():], re.I):
                    continue
                valid.append(('accept' if m.group().lower().startswith('accept') else 'decline', text))
            if len({d for d, _ in valid}) == 1:
                matches.extend(valid)
        # Ordinary-word reversals are tentative until separately confirmed by
        # a read-back. Recognize them only once a prior decision exists; initial
        # conversational signals still require a confirmed read-back.
        if had_prior_decision:
            if re.search(r"\b(?:can(?:not|'?t)|won'?t|unable to)\s+(?:take\s+(?:them|him|her|the patient)|accept(?:\s+(?:them|him|her|the patient))?)\b|\b(?:we(?:'re| are) full|(?:have to|must|need to) divert)\b", text, re.I):
                matches.append(('decline', text))
            elif re.search(r"\b(?:we (?:can|will|'?ll) take (?:them|him|her|the patient)|bring (?:them|him|her|the patient) in)\b", text, re.I):
                matches.append(('accept', text))
        preceding = ('user', text)
    decisions = {m[0] for m in matches}
    decision = next(iter(decisions)) if len(decisions) == 1 and not machine else 'none'
    note = next((text for d, text in reversed(matches) if d == decision), '')
    duration = None
    if call.get('start_time') and call.get('end_time'):
        try:
            duration = max(0, (datetime.fromisoformat(call['end_time'].replace('Z', '+00:00')) - datetime.fromisoformat(call['start_time'].replace('Z', '+00:00'))).total_seconds())
        except (ValueError, TypeError):
            pass
    # Cartesia may conflate refusing the call with declining the patient.
    summary = 'No decision was given on the call.' if decision == 'none' else (call.get('summary') or '')
    answered = bool(transcript) and not machine
    return {'answered': answered, 'answered_at': call.get('start_time') if answered else None, 'ended_at': call.get('end_time'), 'duration_s': duration, 'decision': decision, 'note': note,
            'summary': summary, 'transcript': transcript}


def wait_for_call(call_id, timeout_s=240):
    deadline = time.monotonic() + timeout_s
    with _cartesia() as client:
        while True:
            call = _request(client, 'GET', f'/agents/calls/{call_id}')
            if call.get('status') in ('completed', 'failed'):
                return _result(call)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('Timed out waiting for Cartesia call to end')
            time.sleep(min(3, remaining))


def _save_once(key, value):
    """Append secrets/IDs without overwriting any existing .env entry."""
    if os.getenv(key):
        if os.environ[key] != value:
            raise RuntimeError(f'{key} already exists with a different value; resolve it manually')
        return
    # Quote safely for dotenv, including arbitrary characters in one-time passwords.
    with ENV.open('a', encoding='utf-8') as f:
        f.write(f'\n{key}={json.dumps(str(value))}\n')
        f.flush()
        os.fsync(f.fileno())
    os.environ[key] = str(value)


def _ensure_agent(c):
    agent_id = os.getenv('CARTESIA_AGENT_ID')
    if not agent_id:
        agent = _request(c, 'POST', '/v1/agents', json={'name': 'Lucid pre-alert', 'config': AGENT_CONFIG})
        agent_id = agent['id']
        _save_once('CARTESIA_AGENT_ID', agent_id)
        print('Cartesia model:', MODEL_ID)
    else:
        agent = _request(c, 'GET', '/v1/agents/' + agent_id)
        config = agent.get('config') or {}
        end_call = (config.get('system_tools') or {}).get('end_call') or {}
        voicemail_detection = (config.get('system_tools') or {}).get('voicemail_detection')
        if (config.get('instructions') != INSTRUCTIONS or config.get('initial_message') != INITIAL
                or config.get('initial_message_interruptions') != 'allow' or end_call != AGENT_CONFIG['system_tools']['end_call']
                or voicemail_detection != AGENT_CONFIG['system_tools']['voicemail_detection']
                or ((config.get('audio') or {}).get('output') or {}).get('speed') != AGENT_CONFIG['audio']['output']['speed']
                or ((config.get('audio') or {}).get('output') or {}).get('voice_id') != VOICE_ID
                or (config.get('model') or {}).get('id') != MODEL_ID
                or (config.get('turn') or {}).get('inactivity_check_in_secs') != 5
                or (config.get('turn') or {}).get('inactivity_end_call_secs') != 60
                or config.get('speculative_generation') is not True):
            _request(c, 'PATCH', '/v1/agents/' + agent_id, json={'config': AGENT_CONFIG})
    print('Cartesia agent:', agent_id)
    return agent_id


def setup():
    with _cartesia() as c:
        _ensure_agent(c)
    project = os.environ['PHOTON_PROJECT_ID']
    pbase = f'/v1/projects/{project}/platforms/voice/profiles'
    with httpx.Client(base_url=PHOTON, headers={'Authorization': f"Bearer {os.environ['PHOTON_API_KEY']}"}, timeout=20) as p, _cartesia() as c:
        response = p.get(pbase + '/default')
        if response.status_code == 404:
            profile = _request(p, 'PUT', pbase + '/default', json={'protocol': 'sip'})
        elif response.is_success:
            profile = response.json()
        else:
            raise RuntimeError(f'Photon default profile lookup returned HTTP {response.status_code}')
        pid = profile['profileId']
        base = f'{pbase}/{pid}'
        if not os.getenv('CARTESIA_INBOUND_USERNAME'):
            _save_once('CARTESIA_INBOUND_USERNAME', 'lucid-' + secrets.token_hex(8))
        if not os.getenv('CARTESIA_INBOUND_PASSWORD'):
            _save_once('CARTESIA_INBOUND_PASSWORD', secrets.token_hex(24))
        inbound_creds = {'username': os.environ['CARTESIA_INBOUND_USERNAME'], 'password': os.environ['CARTESIA_INBOUND_PASSWORD']}
        inbound = profile['configuration'].get('inbound')
        if not inbound:
            _request(p, 'PUT', base + '/inbound', json={'credentials': inbound_creds, 'destinationUri': 'sips:sip.cartesia.ai:5061', 'expectedVersion': profile['version']})
        elif inbound.get('destinationUri') != 'sips:sip.cartesia.ai:5061' or (inbound.get('credentials') or {}).get('username') != inbound_creds['username']:
            raise RuntimeError('Existing Photon inbound destination differs; resolve it manually')
        profile = _request(p, 'GET', base)
        outbound = profile['configuration'].get('outbound')
        if not outbound:
            result = _request(p, 'PUT', base + '/outbound', headers={'Idempotency-Key': f'lucid-voice-{pid}'}, json={'authentication': {'algorithm': 'sha-256'}, 'expectedVersion': profile['version']})
            outbound = result['outbound']
            if not result.get('password'):
                raise RuntimeError('Photon did not return the one-time SIP password; manual recovery required')
            _save_once('PHOTON_SIP_PASSWORD', result['password'])
            _save_once('PHOTON_SIP_USERNAME', outbound['authentication']['username'])
            profile = _request(p, 'GET', base)
        elif not os.getenv('PHOTON_SIP_PASSWORD'):
            raise RuntimeError('Photon outbound credentials exist but their password is unavailable locally; manual recovery required')
        else:
            _save_once('PHOTON_SIP_USERNAME', outbound['authentication']['username'])
        endpoints = outbound['connection']['endpoints']
        endpoint = next((x for x in endpoints if x['transport'].lower() == 'tls'), None)
        if not endpoint:
            raise RuntimeError('Photon did not provide a TLS SIP endpoint')
        providers = _request(c, 'GET', '/agents/phone-numbers/providers')
        provider = next((x for x in providers if x.get('label') == 'Lucid Photon'), None)
        if not provider:
            provider = _request(c, 'POST', '/agents/phone-numbers/providers', json={
                'type': 'sip_trunk', 'label': 'Lucid Photon',
                # Inbound is optional and can be configured separately.
                'outbound': {'address': f"{endpoint['host']}:{endpoint['port']}", 'transport': 'tls', 'destination_country': 'US', 'media_encryption': 'allowed', 'credentials': {'username': os.environ['PHOTON_SIP_USERNAME'], 'password': os.environ['PHOTON_SIP_PASSWORD']}},
            })
        print('Photon voice profile:', pid, 'Cartesia SIP provider:', provider['id'])
        agent_id = _ensure_agent(c)
        number = os.getenv('PHOTON_VOICE_NUMBER')
        if not number:
            print('Set PHOTON_VOICE_NUMBER after the Photon number is available, then rerun setup.')
            return
        numbers = _request(c, 'GET', '/agents/phone-numbers')
        match = next((x for x in numbers['data'] if x.get('number') == number), None)
        if not match:
            body = {'label': 'Lucid Photon', 'number': number, 'provider': {'id': provider['id']}}
            if provider.get('inbound'):
                body['agent_id'] = agent_id
            match = _request(c, 'POST', '/agents/phone-numbers', json=body)
        elif (match.get('provider') or {}).get('id') != provider['id']:
            raise RuntimeError('Number already belongs to another Cartesia provider')
        elif provider.get('inbound') and (match.get('agent') or {}).get('id') != agent_id:
            match = _request(c, 'PATCH', '/agents/phone-numbers/' + match['id'], json={'agent_id': agent_id})
        _save_once('CARTESIA_FROM_NUMBER_ID', match['id'])
        print('Cartesia number id:', match['id'])


def main():
    load_dotenv(ENV)
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['setup', 'call'])
    parser.add_argument('number', nargs='?')
    args = parser.parse_args()
    if args.command == 'setup':
        setup()
    else:
        if not args.number:
            parser.error('call requires a destination number')
        call_id = place_call(args.number, {'patient_id': 'patient-1', 'message': 'A screening scan suggests a possible temporal bleed.', 'report': 'Screening suggests a possible temporal bleed.', 'evidence': 'Simulated scan; no validated diagnosis.'})
        print('Call ID:', call_id)
        print(json.dumps(wait_for_call(call_id), indent=2))


if __name__ == '__main__':
    main()
