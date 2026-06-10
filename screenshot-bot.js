const fs    = require('fs');
const https = require('https');
const path  = require('path');

const DASHBOARD_URL = 'https://spyne-qc-hub.vercel.app/';
const BOT_TOKEN     = process.env.SLACK_BOT_TOKEN;
const CHANNEL       = process.env.SLACK_CHANNEL;
const WEBHOOK       = process.env.SLACK_WEBHOOK;

// data-id values match the onclick="activate('...')" calls in the HTML
const TABS = [
  { name: 'Images', dataId: 'images', file: 'qc-images.png', emoji: '🖼' },
  { name: 'Videos', dataId: 'videos', file: 'qc-videos.png', emoji: '🎬' },
  { name: '360°',   dataId: '360',    file: 'qc-360.png',    emoji: '🔁' },
];

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

// ── 1. Take 3 screenshots (one per tab) ──────────────────────────
async function takeScreenshots() {
  const puppeteer = require('puppeteer');
  console.log('🌐 Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote'],
  });

  const screenshots = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });

    console.log('📡 Loading dashboard...');
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 4000));

    // Force dark theme
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

    for (const tab of TABS) {
      console.log(`\n🔖 Activating tab: ${tab.name} (data-id="${tab.dataId}")`);

      // Call activate() directly — same as the button's onclick handler
      // Falls back to clicking the [data-id] button if activate() isn't global
      const result = await page.evaluate((dataId) => {
        // Method 1: call the global activate() function directly
        if (typeof activate === 'function') {
          activate(dataId);
          return 'called activate()';
        }
        // Method 2: click the button by data-id attribute
        const btn = document.querySelector(`button[data-id="${dataId}"]`);
        if (btn) {
          btn.click();
          return 'clicked button[data-id]';
        }
        return 'nothing found';
      }, tab.dataId);

      console.log(`  Method used: ${result}`);

      // Wait for the active tab class to appear on the correct button
      try {
        await page.waitForFunction((dataId) => {
          const btn = document.querySelector(`button[data-id="${dataId}"]`);
          return btn && btn.classList.contains('active');
        }, { timeout: 10000 }, tab.dataId);
        console.log(`  ✅ Tab is now active`);
      } catch {
        console.log(`  ⚠ Active class wait timed out — proceeding`);
      }

      // Extra settle time for data/charts to render
      await new Promise(r => setTimeout(r, 5000));

      const filePath = path.join(process.cwd(), tab.file);
      await page.screenshot({ path: filePath, clip: { x: 0, y: 0, width: 1600, height: 900 } });
      const kb = Math.round(fs.statSync(filePath).size / 1024);
      console.log(`  📸 Saved ${tab.file} (${kb} KB)`);
      screenshots.push({ ...tab, filePath });
    }
  } finally {
    await browser.close();
  }

  return screenshots;
}

// ── 2. Upload a single image to Slack ────────────────────────────
async function uploadImage(filePath, title, comment) {
  const img  = fs.readFileSync(filePath);
  const size = img.length;

  const r1 = await httpsRequest(
    'slack.com',
    `/api/files.getUploadURLExternal?filename=${path.basename(filePath)}&length=${size}`,
    'GET',
    { 'Authorization': `Bearer ${BOT_TOKEN}` },
    null
  );
  const j1 = JSON.parse(r1.body);
  if (!j1.ok) throw new Error(`getUploadURLExternal: ${j1.error}`);

  const { upload_url, file_id } = j1;

  const uploadParsed = new URL(upload_url);
  await httpsRequest(
    uploadParsed.hostname,
    uploadParsed.pathname + uploadParsed.search,
    'POST',
    { 'Content-Type': 'image/png', 'Content-Length': size },
    img
  );

  const completeBody = JSON.stringify({
    files: [{ id: file_id, title }],
    channel_id: CHANNEL,
    initial_comment: comment,
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
  if (!j3.ok) throw new Error(`completeUploadExternal: ${j3.error}`);
  console.log(`  ✅ Posted: ${title}`);
}

// ── 3. Upload all 3 screenshots ───────────────────────────────────
async function uploadAllScreenshots(screenshots) {
  const now = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
  });

  for (let i = 0; i < screenshots.length; i++) {
    const { name, filePath, emoji } = screenshots[i];
    const isFirst = i === 0;

    const comment = isFirst
      ? `🚨 *QC Pendency Report* | ${now} IST\n<${DASHBOARD_URL}|🔗 Open Live Dashboard>\n\n${emoji} *${name} Pendency*\n\n<@U08VA3ARKLM> <@U098XR16D6U> <@U098QVB7BMF>`
      : `${emoji} *${name} Pendency*`;

    await uploadImage(filePath, `QC ${name} Pendency · ${now} IST`, comment);

    if (i < screenshots.length - 1) await new Promise(r => setTimeout(r, 1500));
  }
}

// ── 4. Webhook fallback ──────────────────────────────────────────
async function sendWebhook() {
  if (!WEBHOOK) { console.log('⚠ No webhook configured'); return; }
  const now = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
  });
  const payload = JSON.stringify({
    text: `🚨 *QC Pendency Alert* | Hourly Report\n<${DASHBOARD_URL}|🔗 Open Live Dashboard>  ·  ${now} IST\n\n<@U08VA3ARKLM> <@U098XR16D6U> <@U098QVB7BMF>`,
  });
  const wUrl = new URL(WEBHOOK);
  const r = await httpsRequest(
    wUrl.hostname, wUrl.pathname, 'POST',
    { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    payload
  );
  console.log('Webhook:', r.status === 200 ? '✅ Sent' : `❌ ${r.status}`);
}

// ── Main ──────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🚀 QC Bot (3-tab)  —  ${new Date().toISOString()}\n`);
  try {
    const screenshots = await takeScreenshots();
    console.log(`\n📦 ${screenshots.length} screenshots ready\n`);

    if (BOT_TOKEN && CHANNEL) {
      try {
        await uploadAllScreenshots(screenshots);
        console.log('\n✅ All 3 screenshots posted!\n');
        return;
      } catch (e) {
        console.error('❌ Upload failed:', e.message);
        console.log('→ Falling back to webhook');
      }
    } else {
      console.log('⚠ BOT_TOKEN or CHANNEL not set — using webhook fallback');
    }

    await sendWebhook();
  } catch (err) {
    console.error('\n❌ Fatal:', err.message);
    process.exit(1);
  }
})();
