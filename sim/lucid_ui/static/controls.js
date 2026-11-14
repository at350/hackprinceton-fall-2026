// The scan controls in the top bar, shared by both views.
export function setupControls() {
  const $ = (id) => document.getElementById(id);
  fetch('/api/scenarios').then((r) => r.json()).then(({ source, scenarios }) => {
    const select = $('scenario');
    for (const [key, label] of Object.entries(scenarios)) select.add(new Option(label, key));
    if (source.kind !== 'sim') {
      $('scenario-field').hidden = true;
      $('start').textContent = source.kind === 'serial' ? 'Start reading the probe' : 'Play recording';
    }
  });
  $('controls').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = new URLSearchParams({ scenario: $('scenario').value, speed: $('speed').value, seed: Math.floor(Math.random() * 1000) });
    fetch(`/api/start?${q}`);
    $('start').textContent = 'Restart scan';
  });
}

export const pct = (p) => (p >= 0.995 ? '>99%' : p < 0.005 ? '<1%' : `${Math.round(p * 100)}%`);
