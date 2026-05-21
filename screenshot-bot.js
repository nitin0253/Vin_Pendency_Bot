const fs    = require('fs');
const https = require('https');
const path  = require('path');

const SCREENSHOT    = path.join(process.cwd(), 'dashboard.png');
const DASHBOARD_URL = 'https://vin-tracker-delivery.vercel.app/';
const BOT_TOKEN     = process.env.SLACK_BOT_TOKEN;
const CHANNEL       = process.env.SLACK_CHANNEL;
const WEBHOOK       = process.env.SLACK_WEBHOOK;

// ── HTTPS helper ──────────────────────────────────────────────────
function httpsRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── 1. Screenshot ─────────────────────────────────────────────────
async function takeScreenshot() {
  const puppeteer = require('puppeteer');
  console.log('🌐 Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    console.log('📡 Loading dashboard...');
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    try { await page.waitForSelector('#dash', { timeout: 30000 }); } catch {}
    await new Promise(r => setTimeout(r, 5000));
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: SCREENSHOT, clip: { x:0, y:0, width:1600, height:900 } });
    const kb = Math.round(fs.statSync(SCREENSHOT).size / 1024);
    console.log(`📸 Screenshot saved (${kb} KB)`);
  } finally {
    await browser.close();
  }
}

// ── 2. Upload image to Slack (new API) ────────────────────────────
async function uploadImage() {
  const img  = fs.readFileSync(SCREENSHOT);
  const size = img.length;
  const now  = new Date().toLocaleString('en-IN', { timeZone:'Asia/Kolkata', dateStyle:'medium', timeStyle:'short' });

  // Step 1: Get upload URL
  console.log('📤 Step 1: Getting upload URL...');
  const r1 = await httpsRequest(
    'slack.com',
    `/api/files.getUploadURLExternal?filename=qc-dashboard.png&length=${size}`,
    'GET',
    { 'Authorization': `Bearer ${BOT_TOKEN}` },
    null
  );
  const j1 = JSON.parse(r1.body);
  console.log('getUploadURLExternal:', j1.ok ? '✅' : '❌ ' + j1.error);
  if (!j1.ok) throw new Error(j1.error);

  const { upload_url, file_id } = j1;

  // Step 2: Upload file bytes to the presigned URL
  console.log('📤 Step 2: Uploading image bytes...');
  const uploadParsed = new URL(upload_url);
  const r2 = await httpsRequest(
    uploadParsed.hostname,
    uploadParsed.pathname + uploadParsed.search,
    'POST',
    { 'Content-Type': 'image/png', 'Content-Length': size },
    img
  );
  console.log('Upload bytes response:', r2.status);

  // Step 3: Complete upload — share to channel
  console.log('📤 Step 3: Completing upload to channel', CHANNEL);
  const completeBody = JSON.stringify({
    files: [{ id: file_id, title: `QC Pendency Dashboard · ${now} IST` }],
    channel_id: CHANNEL,
    initial_comment: `📊 *QC Pendency Dashboard*  ·  ${now} IST\n<${DASHBOARD_URL}|🔗 Open Live Dashboard>`,
  });
  const r3 = await httpsRequest(
    'slack.com',
    '/api/files.completeUploadExternal',
    'POST',
    {
      'Authorization': `Bearer ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(completeBody),
    },
    completeBody
  );
  const j3 = JSON.parse(r3.body);
  console.log('completeUploadExternal:', j3.ok ? '✅ Image posted!' : '❌ ' + j3.error);
  if (!j3.ok) throw new Error(j3.error);
}

// ── 3. Webhook fallback (text only) ──────────────────────────────
async function sendWebhook() {
  if (!WEBHOOK) { console.log('⚠ No webhook configured'); return; }
  const now = new Date().toLocaleString('en-IN', { timeZone:'Asia/Kolkata', dateStyle:'medium', timeStyle:'short' });
  const payload = JSON.stringify({
    text: `📊 *QC Pendency Dashboard*  ·  ${now} IST\n<${DASHBOARD_URL}|🔗 Open Live Dashboard>`,
  });
  const wUrl = new URL(WEBHOOK);
  const r = await httpsRequest(
    wUrl.hostname, wUrl.pathname, 'POST',
    { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    payload
  );
  console.log('Webhook:', r.status === 200 ? '✅ Sent' : `❌ ${r.status} ${r.body}`);
}

// ── Main ──────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🚀 QC Bot  —  ${new Date().toISOString()}\n`);
  try {
    await takeScreenshot();

    if (BOT_TOKEN && CHANNEL) {
      try {
        await uploadImage();
        return; // success — done
      } catch (e) {
        console.error('❌ Image upload failed:', e.message);
        console.log('→ Falling back to webhook text message');
      }
    } else {
      console.log('⚠ BOT_TOKEN or CHANNEL not set — using webhook fallback');
    }

    await sendWebhook();
    console.log('\n✅ Done\n');
  } catch (err) {
    console.error('\n❌ Fatal:', err.message);
    process.exit(1);
  }
})();
