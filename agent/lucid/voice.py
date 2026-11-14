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
INSTRUCTIONS = '''You are Lucid, an automated screening aid calling the on-call clinician with a pre-alert approved by a medic. Read the pre-alert in two sentences. Answer questions only using the report and evidence below; plainly say when the scan cannot show something. Ask whether the clinician accepts or declines the patient. Never provide treatment advice or claim a diagnosis. Keep turns short. After the decision, say a text recap follows, then end the call.
Patient: {{patient_id}}
Approved pre-alert: {{message}}
Approved report: {{report}}
Evidence: {{evidence}}'''
INITIAL = 'This is Lucid, an automated screening aid, calling with a pre-alert from a medic. Do you have thirty seconds?'


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


def place_call(to_number, variables):
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
    negated = False
    for turn in transcript:
        if turn.get('role') != 'user':
            continue
        text = turn.get('text') or ''
        for m in re.finditer(r'\b(accept(?:ed|ing)?|declin(?:e|ed|ing))\b', text, re.I):
            if re.search(r"\b(not|no|never|don'?t|doesn'?t|can'?t|cannot|won'?t|unable to)\s+(\w+\s+)?$", text[:m.start()], re.I):
                negated = True
            matches.append(('accept' if m.group().lower().startswith('accept') else 'decline', text))
    decisions = {m[0] for m in matches}
    decision = next(iter(decisions)) if len(decisions) == 1 and not negated else 'none'
    note = next((text for d, text in reversed(matches) if d == decision), '')
    duration = None
    if call.get('start_time') and call.get('end_time'):
        try:
            duration = max(0, (datetime.fromisoformat(call['end_time'].replace('Z', '+00:00')) - datetime.fromisoformat(call['start_time'].replace('Z', '+00:00'))).total_seconds())
        except (ValueError, TypeError):
            pass
    return {'answered': bool(transcript), 'duration_s': duration, 'decision': decision, 'note': note,
            'summary': call.get('summary') or '', 'transcript': transcript}


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
        agent = _request(c, 'POST', '/v1/agents', json={'name': 'Lucid pre-alert', 'config': {'instructions': INSTRUCTIONS, 'initial_message': INITIAL, 'model': {'id': model}, 'system_tools': {'end_call': {}}, 'speculative_generation': True}})
        agent_id = agent['id']
        _save_once('CARTESIA_AGENT_ID', agent_id)
        print('Cartesia model:', model)
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
        call_id = place_call(args.number, {'patient_id': 'demo-patient', 'message': 'A screening scan suggests a possible temporal bleed. Please accept or decline this pre-alert.', 'report': 'Screening suggests a possible temporal bleed; this is not a diagnosis.', 'evidence': 'Simulated scan; no validated diagnosis.'})
        print('Call ID:', call_id)
        print(json.dumps(wait_for_call(call_id), indent=2))


if __name__ == '__main__':
    main()
