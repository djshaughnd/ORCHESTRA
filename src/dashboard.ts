/**
 * Single-page status dashboard served at GET /. Zero build step, zero
 * dependencies — polls /status and /health every 2s. Nice on an iPad
 * in the booth.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ORCHESTRA</title>
<style>
  body { font: 15px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; background: #101012; color: #eee; margin: 24px; }
  h1 { font-size: 20px; letter-spacing: 2px; }
  h1 small { color: #777; font-weight: 400; letter-spacing: 0; font-size: 12px; margin-left: 10px; }
  .grid { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
  .tile { min-width: 170px; padding: 14px 16px; border-radius: 10px; background: #1c1c1f; border-left: 4px solid #444; }
  .tile.ok { border-left-color: #34c759; }
  .tile.bad { border-left-color: #ff453a; }
  .tile.rec { border-left-color: #ff453a; background: #2a1416; }
  .k { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
  .v { font-size: 20px; font-weight: 600; margin-top: 2px; }
  .d { color: #999; font-size: 12px; margin-top: 4px; }
</style>
</head>
<body>
<h1>ORCHESTRA<small id="up"></small></h1>
<div class="grid" id="grid"><div class="tile">loading…</div></div>
<script>
function tile(cls, k, v, d) {
  return '<div class="tile ' + cls + '"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="d">' + (d || '') + '</div></div>';
}
async function poll() {
  const grid = document.getElementById('grid');
  try {
    const [s, h] = await Promise.all([
      fetch('/status').then(r => r.json()),
      fetch('/health').then(r => r.json()),
    ]);
    document.getElementById('up').textContent = 'up ' + Math.floor(s.uptimeSeconds / 60) + 'm';
    let html = '';
    html += s.session
      ? tile('ok', 'Session', s.session.name, s.session.profile + ' · ' + s.session.markers + ' markers')
      : tile('', 'Session', '—', 'no active session');
    html += s.record.active
      ? tile('rec', 'REC', '● ' + (s.record.timecode || '').split('.')[0], 'recording')
      : tile('', 'REC', 'stopped', '');
    html += tile(s.auto && s.auto.armed ? 'ok' : '', 'Auto-switch', s.auto && s.auto.armed ? 'ARMED cam ' + s.auto.program : 'off', 'profile: ' + s.profile);
    for (const name in h.checks) {
      const c = h.checks[name];
      html += tile(c.ok ? 'ok' : 'bad', name, c.ok ? 'OK' : 'FAIL', c.detail);
    }
    grid.innerHTML = html;
  } catch (e) {
    grid.innerHTML = tile('bad', 'daemon', 'UNREACHABLE', String(e));
  }
}
setInterval(poll, 2000);
poll();
</script>
</body>
</html>`;
