import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, normalizePrefs, DEFAULT_PREFS } from './store.js';
import { Notifier, loadVapidKeys } from './notifier.js';
import { Watcher } from './watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const CHECK_INTERVAL_MIN = Math.max(1, Number(process.env.CHECK_INTERVAL_MIN) || 5);
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:veille-immo@example.com';
// Mot de passe facultatif : s'il est défini, il faut le saisir dans l'application
// pour s'abonner (évite que des inconnus utilisent votre serveur).
const ACCESS_CODE = process.env.ACCESS_CODE || '';

const store = new Store(DATA_DIR);
const vapid = loadVapidKeys(DATA_DIR);
const notifier = new Notifier(store, { vapid, subject: VAPID_SUBJECT });
const watcher = new Watcher(store, notifier, { intervalMs: CHECK_INTERVAL_MIN * 60 * 1000 });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

function checkAccess(req, res) {
  if (!ACCESS_CODE) return true;
  const code = req.get('x-access-code') || req.body?.accessCode || '';
  if (code === ACCESS_CODE) return true;
  res.status(401).json({ error: 'Code d\'accès incorrect' });
  return false;
}

app.get('/api/config', (req, res) => {
  res.json({
    vapidPublicKey: vapid.publicKey,
    requiresAccessCode: Boolean(ACCESS_CODE),
    checkIntervalMin: CHECK_INTERVAL_MIN,
    defaultPrefs: DEFAULT_PREFS,
  });
});

app.get('/api/listings', (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 100);
  res.json({
    lastCheck: store.state.lastCheck,
    sources: store.state.sourcesStatus,
    subscribers: store.subscriptions.length,
    listings: store.listings.slice(0, limit),
  });
});

app.post('/api/subscribe', async (req, res) => {
  if (!checkAccess(req, res)) return;
  const { subscription, prefs } = req.body || {};
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Abonnement push invalide' });
  }
  const record = store.upsertSubscription(subscription, prefs);
  res.json({ ok: true, prefs: record.prefs });
});

app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) store.removeSubscription(endpoint);
  res.json({ ok: true });
});

app.post('/api/test-notification', async (req, res) => {
  if (!checkAccess(req, res)) return;
  const { subscription } = req.body || {};
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Abonnement manquant' });
  try {
    await notifier.sendTest(subscription);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `Envoi impossible : ${err.body || err.message}` });
  }
});

app.post('/api/check-now', async (req, res) => {
  if (!checkAccess(req, res)) return;
  const result = await watcher.checkOnce();
  res.json({ ok: true, ...result, lastCheck: store.state.lastCheck });
});

app.get('/api/prefs', (req, res) => {
  const endpoint = String(req.query.endpoint || '');
  const sub = store.subscriptions.find((s) => s.endpoint === endpoint);
  res.json({ subscribed: Boolean(sub), prefs: sub ? sub.prefs : normalizePrefs() });
});

app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(ROOT, 'public', 'sw.js'));
});

app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1h', etag: true }));

app.listen(PORT, () => {
  console.log(`Veille immo Tahiti en écoute sur http://localhost:${PORT} (vérification toutes les ${CHECK_INTERVAL_MIN} min)`);
  watcher.start();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    watcher.stop();
    store.save();
    process.exit(0);
  });
}
