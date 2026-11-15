// The Gemini panel: a hand-off note written when the scan finishes, and questions about the scan. The server
// sends Gemini the numbers behind this screen; nothing else.
const $ = (id) => document.getElementById(id);

export class GeminiPanel {
  constructor() {
    this.history = [];
    this.busy = false;
    this.written = false;
    $('gemini-write').addEventListener('click', () => this.handoff(true));
    $('gemini-ask').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('gemini-q').value.trim();
      if (q) this.ask(q);
    });
  }

  reset() {
    this.history = [];
    this.written = false;
    $('gemini-out').hidden = true;
    $('gemini-chat').innerHTML = '';
    $('gemini-write').textContent = 'Write it now';
    $('gemini-sub').textContent = 'Written when the scan finishes, from the numbers on this screen only.';
  }

  async handoff(force = false) {
    if (this.busy || (this.written && !force)) return;
    this.written = true;
    const out = $('gemini-out');
    out.hidden = false;
    out.className = 'gemini-out busy';
    out.textContent = 'Gemini is reading the scan…';
    const r = await this.call({});
    out.className = `gemini-out${r.error ? ' error' : ''}`;
    out.textContent = r.error || r.text;
    if (r.model) {
      const m = document.createElement('span');
      m.className = 'model';
      m.textContent = `${r.model} · check against the readings before sending`;
      out.append(m);
      this.history = [{ role: 'user', text: 'Write the hand-off.' }, { role: 'model', text: r.text }];
    }
    $('gemini-write').textContent = 'Write it again';
  }

  async ask(question) {
    if (this.busy) return;
    const chat = $('gemini-chat');
    const q = document.createElement('li');
    q.className = 'q';
    q.textContent = question;
    const a = document.createElement('li');
    a.className = 'a';
    a.textContent = '…';
    chat.append(q, a);
    $('gemini-q').value = '';
    const r = await this.call({ question, history: this.history });
    a.textContent = r.error || r.text;
    if (!r.error) this.history.push({ role: 'user', text: question }, { role: 'model', text: r.text });
  }

  async call(body) {
    this.busy = true;
    for (const el of document.querySelectorAll('#gemini-ask button, #gemini-ask input')) el.disabled = true;
    try {
      const res = await fetch('/api/gemini', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return await res.json();
    } catch (e) {
      return { error: `Could not reach the Lucid server: ${e.message}` };
    } finally {
      this.busy = false;
      for (const el of document.querySelectorAll('#gemini-ask button, #gemini-ask input')) el.disabled = false;
    }
  }
}
