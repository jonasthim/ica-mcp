// The BankID QR poller for /admin/ica/connect/:id. Texts come from the page's data-* attributes (i18n.ts).
const img = document.getElementById('qr');
const a = document.getElementById('autostart');
const msg = document.getElementById('msg');
// The playful loading line (outside the live region) goes once a code shows or the login ends.
const loading = document.getElementById('qr-loading');
const loaded = () => { if (loading) loading.hidden = true; };
if (img && a && msg) {
  const fail = (text) => { loaded(); img.hidden = true; a.hidden = true; msg.className = 'field-error'; msg.textContent = text; };
  const tick = async () => {
    let j;
    try { j = await (await fetch(img.dataset.status, { headers: { accept: 'application/json' }, cache: 'no-store' })).json(); }
    catch { fail(msg.dataset.lost); return; }
    if (j.state === 'pending') {
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(j.qrSvg);
      img.alt = img.dataset.altReady;
      loaded();
      if (j.autoStartUrl) { a.href = j.autoStartUrl; a.hidden = false; }
      setTimeout(tick, 1000);
    } else if (j.state === 'complete') { loaded(); msg.textContent = msg.dataset.done; location.href = '/admin/ica'; }
    else fail(j.reason || msg.dataset.failed);
  };
  tick();
}
