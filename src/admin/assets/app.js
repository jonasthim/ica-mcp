// Progressive enhancement only: every page works without this file.
document.documentElement.classList.add('js');

// copy-to-clipboard
document.addEventListener('click', async (ev) => {
  const b = ev.target instanceof Element ? ev.target.closest('[data-copy]') : null;
  if (!b) return;
  try {
    await navigator.clipboard.writeText(b.getAttribute('data-copy') ?? '');
    b.setAttribute('data-copied', '');
    setTimeout(() => b.removeAttribute('data-copied'), 1500);
  } catch { /* the value is visible next to the button */ }
});

// confirm dialogs for destructive forms (without JS the form submits directly)
const dlg = document.getElementById('confirm');
document.addEventListener('submit', (ev) => {
  const f = ev.target;
  if (!(f instanceof HTMLFormElement) || !f.dataset.confirm || f.dataset.confirmed || !(dlg instanceof HTMLDialogElement)) return;
  ev.preventDefault();
  dlg.querySelector('[data-confirm-text]').textContent = f.dataset.confirm;
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    f.dataset.confirmed = '1';
    // Actions with a server-side confirmation page skip it once the dialog has asked the same question.
    if (f.dataset.confirmField && !f.elements.namedItem(f.dataset.confirmField)) {
      const yes = document.createElement('input');
      yes.type = 'hidden'; yes.name = f.dataset.confirmField; yes.value = 'yes';
      f.append(yes);
    }
    f.requestSubmit(ev.submitter ?? undefined);
  }, { once: true });
  dlg.showModal();
});

// theme: apply at once, the form still posts to persist the cookie
document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el instanceof HTMLInputElement && el.name === 'theme') {
    if (el.value === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = el.value;
    el.form?.requestSubmit();
  }
});

// password strength hint (advice only, never blocks)
for (const input of document.querySelectorAll('input[data-strength]')) {
  const out = document.getElementById(input.getAttribute('data-strength'));
  input.addEventListener('input', () => {
    const v = input.value;
    let score = 0;
    if (v.length >= 12) score++;
    if (v.length >= 16) score++;
    if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score++;
    if (/\d/.test(v)) score++;
    if (/[^A-Za-z0-9]/.test(v)) score++;
    if (/(.)\1{2,}/.test(v) || /^(password|lösenord|ica-?hub|123456)/i.test(v)) score = Math.min(score, 1);
    if (out) out.textContent = out.dataset[`s${Math.min(score, 4)}`] ?? '';
  });
}
