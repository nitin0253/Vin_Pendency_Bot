const fs    = require('fs');
const https = require('https');
const path  = require('path');

const DASHBOARD_URL = 'https://spyne-qc-hub.vercel.app/';
const BOT_TOKEN     = process.env.SLACK_BOT_TOKEN;
const CHANNEL       = process.env.SLACK_CHANNEL;
const WEBHOOK       = process.env.SLACK_WEBHOOK;

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

// ── Wait for loading spinner to disappear ─────────────────────────
// Only checks that the loading text is gone — no DOM structure assumptions
async function waitForDataLoaded(page, tabName, timeoutMs = 60000) {
  console.log(`  ⏳ Waiting for "${tabName}" data...`);
  const start = Date.now();

  try {
    await page.waitForFunction(() => {
      const text = document.body.innerText || '';
      return (
        !text.includes('FETCHING QC PENDING DATA') &&
        !text.includes('Fetching') &&
        !text.includes('Loading...')
      );
    }, { timeout: timeoutMs, polling: 500 });

    console.log(`  ✅ Loaded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log(`  ⚠ Load wait timed out — taking screenshot anyway`);
  }

  // Let charts/animations finish rendering
  await new Promise(r => setTimeout(r, 3000));
}

// ── 1. Take 3 screenshots ─────────────────────────────────────────
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

    // Force dark theme
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

    // Wait for the default Images tab to finish loading
    await waitForDataLoaded(page, 'Images');

    for (const tab of TABS) {
      console.log(`\n🔖 Tab: ${tab.name}`);

      if (tab.dataId !== 'images') {
        // Call activate() directly — same as onclick="activate('videos')"
        const method = await page.evaluate((dataId) => {
          if (typeof activate === 'function') {
            activate(dataId);
            return 'activate()';
          }
          const btn = document.querySelector(`button[data-id="${dataId}"]`);
          if (btn) { btn.click(); return 'btn.click()'; }
          return 'not found';
        }, tab.dataId);
        console.log(`  Method: ${method}`);

        // Wait for this tab's button to become active
        try {
          await page.waitForFunction((dataId) => {
            const btn = document.querySelector(`button[data-id="${dataId}"]`);
            return btn && btn.classList.contains('active');
          }, { timeout: 10000 }, tab.dataId);
        } catch {
          console.log(`  ⚠ Active class check timed out`);
        }

        // Wait for loading spinner to clear
        await waitForDataLoaded(page, tab.name);
      }

      const filePath = path.join(process.cwd(), tab.file);
      await page.screenshot({ path: filePath, clip: { x: 0, y: 0, width: 1600, height: 900 } });
      const kb = Math.round(fs.statSync(filePath).size / 1024);
      console.log(`  📸 ${tab.file} (${kb} KB)`);
      screenshots.push({ ...tab, filePath });
    }
  } finally {
    await browser.close();
  }

  return screenshots;
}

// ── 2. Upload one image to Slack ──────────────────────────────────
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
    'slack.com', '/api/files.completeUploadExternal', 'POST',
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

// ── 3. Upload all 3 ───────────────────────────────────────────────
async function uploadAllScreenshots(screenshots) {
  const now = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
  });

  for (let i = 0; i < screenshots.length; i++) {
    const { name, filePath, emoji } = screenshots[i];
    const comment = i === 0
      ? `🚨 *QC Pendency Report* | ${now} IST\n<${DASHBOARD_URL}|🔗 Open Live Dashboard>\n\n${emoji} *${name} Pendency*\n\n<@U08VA3ARKLM> <@U098XR16D6U> <@U098QVB7BMF>`
      : `${emoji} *${name} Pendency*`;

    await uploadImage(filePath, `QC ${name} Pendency · ${now} IST`, comment);
    if (i < screenshots.length - 1) await new Promise(r => setTimeout(r, 1500));
  }
}

// ── 4. Webhook fallback ───────────────────────────────────────────
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
