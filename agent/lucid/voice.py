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
INSTRUCTIONS = '''You are Lucid, an automated screening aid calling an on-call clinician about a pre-alert approved by a medic. The initial message gives the finding and the supplied transport details, then asks whether they accept or decline the patient. Speak like a person on a radio. Keep answers to one short sentence, use no filler or thanks, and do not repeat the opening.

When interrupted, stop speaking, listen and respond to what was asked. Questions, objections, "wait", and "no" followed by a question are NOT refusals to talk: answer them, even if the clinician says no or is hostile. When in doubt, answer the question. For location and ETA, give the transport details below. If asked where the patient is, provide the available unit and ETA; if no precise location is given, say the exact location is unavailable. For a known fact, answer directly in one sentence and stop speaking; do not ask accept-or-decline again in that response. For ETA, just state the transport and ETA without any question. If a requested fact is not provided, such as the destination bay, patient name, vitals or mechanism of injury, say: "I don't have that. The medic will radio it. Can you accept pending that, or do you decline?" Never invent a fact or claim it is in a message if it is not. If the caller is hostile, stay level and offer an accept-or-decline choice or the option to decide by text; do not hang up unless the person refuses to talk or hangs up.

Only when the person actually refuses to talk at all, says they cannot talk, not now, stop calling, or says this is the wrong person or number: stop, do not read or repeat clinical details, say exactly "Understood. The details are in your messages; reply ACCEPT or DECLINE there.", and end the call. A refusal to talk is not a patient decline; the end-call reason must say "no decision given".

Only an explicit acceptance or decline of the patient is a decision. Answer only from the approved report, evidence and transport below. Never claim a diagnosis: describe what the screening scan suggests. Do not say "not a diagnosis", "confirm with CT", or a similar disclaimer unless asked whether it is a diagnosis. Never give treatment advice. When the clinician explicitly accepts or declines the patient, immediately invoke the end_call tool and say exactly "Text recap follows." as the tool's pre-action speech. Do not ask whether they are still there or repeat clinical details; invoking end_call is mandatory.
Patient ID, only if asked: {{patient_id}}
Approved pre-alert: {{message}}
Approved report: {{report}}
Evidence: {{evidence}}
Transport: {{transport}}'''
INITIAL = 'This is Lucid, an automated screening aid, with a pre-alert a medic approved. {{voice_prealert}} {{transport}} Do you accept or decline the patient?'
AGENT_CONFIG = {'instructions': INSTRUCTIONS, 'initial_message': INITIAL,
                'initial_message_interruptions': 'allow',
                'audio': {'output': {'speed': 1.30}},
                'system_tools': {'end_call': {'pre_tool_speech': 'force', 'description': 'Immediately end after the clinician makes an explicit patient decision or refuses to talk. For a decision, say Text recap follows. For refusal, say the exact refusal sentence from the instructions. The tool must be invoked, not just described.'}}}


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
            finding += f", about {size.group(1)} millilitres"
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
                 'transport': str(variables.get('transport') or 'Transport location and ETA are not available.')}
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


def _result(call):
    transcript = call.get('transcript') or []
    # Only the clinician's own words count. Ambiguous or conflicting words stay undecided.
    matches = []
    for turn in transcript:
        if turn.get('role') != 'user':
            continue
        text = turn.get('text') or ''
        # Keep a later explicit decision even if the same turn began with a question or conditional.
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
    decisions = {m[0] for m in matches}
    decision = next(iter(decisions)) if len(decisions) == 1 else 'none'
    note = next((text for d, text in reversed(matches) if d == decision), '')
    duration = None
    if call.get('start_time') and call.get('end_time'):
        try:
            duration = max(0, (datetime.fromisoformat(call['end_time'].replace('Z', '+00:00')) - datetime.fromisoformat(call['start_time'].replace('Z', '+00:00'))).total_seconds())
        except (ValueError, TypeError):
            pass
    # Cartesia may conflate refusing the call with declining the patient.
    summary = 'No decision was given on the call.' if decision == 'none' else (call.get('summary') or '')
    return {'answered': bool(transcript), 'answered_at': call.get('start_time') if transcript else None, 'ended_at': call.get('end_time'), 'duration_s': duration, 'decision': decision, 'note': note,
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
        models = []
        page = None
        while True:
            result = _request(c, 'GET', '/v1/agents/models', params={'starting_after': page} if page else {})
            models += result['data']
            if not result.get('has_more') or not result.get('next_page'):
                break
            page = result['next_page']
        model = min((x for x in models if x.get('average_latency_ms') is not None), key=lambda x: x['average_latency_ms'])['id']
        agent = _request(c, 'POST', '/v1/agents', json={'name': 'Lucid pre-alert', 'config': {**AGENT_CONFIG, 'model': {'id': model}, 'speculative_generation': True}})
        agent_id = agent['id']
        _save_once('CARTESIA_AGENT_ID', agent_id)
        print('Cartesia model:', model)
    else:
        agent = _request(c, 'GET', '/v1/agents/' + agent_id)
        config = agent.get('config') or {}
        end_call = (config.get('system_tools') or {}).get('end_call') or {}
        if (config.get('instructions') != INSTRUCTIONS or config.get('initial_message') != INITIAL
                or config.get('initial_message_interruptions') != 'allow' or end_call != AGENT_CONFIG['system_tools']['end_call']
                or ((config.get('audio') or {}).get('output') or {}).get('speed') != 1.30):
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
        call_id = place_call(args.number, {'patient_id': 'demo-patient', 'message': 'A screening scan suggests a possible temporal bleed.', 'report': 'Screening suggests a possible temporal bleed.', 'evidence': 'Simulated scan; no validated diagnosis.'})
        print('Call ID:', call_id)
        print(json.dumps(wait_for_call(call_id), indent=2))


if __name__ == '__main__':
    main()
