const fs    = require('fs');
const https = require('https');
const path  = require('path');
const sharp = require('sharp');

const DASHBOARD_URL = 'https://spyne-qc-hub.vercel.app/';
const BOT_TOKEN     = process.env.SLACK_BOT_TOKEN;
const CHANNEL       = process.env.SLACK_CHANNEL;
const WEBHOOK       = process.env.SLACK_WEBHOOK;

const SS_W = 1600;

const TABS = [
  { name: 'Images', dataId: 'images', file: 'qc-images.png', emoji: '🖼', waitForData: true,  cropH: 560 },
  { name: 'Videos', dataId: 'videos', file: 'qc-videos.png', emoji: '🎬', waitForData: true,  cropH: 560 },
  { name: '360°',   dataId: '360',    file: 'qc-360.png',    emoji: '🔁', waitForData: true,  cropH: 560 },
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

// ── Wait for a tab's data API response to complete ───────────────
function waitForDataResponse(page, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      page.off('response', handler);
      resolve('timeout');
    }, timeoutMs);

    const handler = (response) => {
      const url = response.url();
      const status = response.status();
      const ct = response.headers()['content-type'] || '';

      if (!url.startsWith('http')) return;
      if (!ct.includes('application/json')) return;
      if (url.includes('vin-tracker-delivery') || url.includes('vercel.live')) return;
      if (status !== 200) return;

      clearTimeout(timer);
      page.off('response', handler);
      resolve(url);
    };
    page.on('response', handler);
  });
}

// ── Block non-essential requests to cut data transfer per run ────
// Keeps: document, script, xhr/fetch (need JS + API data), and same-origin
// stylesheets (need layout for an accurate screenshot).
// Blocks: fonts, media, and any third-party image/font/tracking requests —
// none of these affect what the screenshot needs to look like.
function enableRequestInterception(page) {
  page.on('request', (req) => {
    const type = req.resourceType();
    const url = req.url();
    const isSameOrigin = url.startsWith(DASHBOARD_URL) || url.startsWith(DASHBOARD_URL.replace(/\/$/, ''));

    if (type === 'font' || type === 'media') {
      return req.abort();
    }
    if (type === 'image' && !isSameOrigin) {
      return req.abort();
    }
    if (/google-analytics|googletagmanager|segment\.io|hotjar|mixpanel|sentry\.io|intercom|drift\.com/.test(url)) {
      return req.abort();
    }
    req.continue();
  });
}

// ── 1. Take 3 screenshots ─────────────────────────────────────────
async function takeScreenshots() {
  const puppeteer = require('puppeteer');
  console.log('🌐 Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const screenshots = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: SS_W, height: 900 });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });

    // Must come before any navigation
    await page.setRequestInterception(true);
    enableRequestInterception(page);

    console.log('📡 Loading dashboard...');
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle0', timeout: 80000 });

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

    const bodySnippet = await page.evaluate(() => document.body.innerText.substring(0, 200));
    console.log('  Page state after load:', bodySnippet.replace(/\n/g, ' '));

    await new Promise(r => setTimeout(r, 3000));

    for (const tab of TABS) {
      console.log(`\n🔖 Tab: ${tab.name}`);

      if (tab.dataId !== 'images') {
        if (tab.waitForData) {
          const responsePromise = waitForDataResponse(page, 25000);

          const method = await page.evaluate((dataId) => {
            if (typeof activate === 'function') { activate(dataId); return 'activate()'; }
            const btn = document.querySelector(`button[data-id="${dataId}"]`);
            if (btn) { btn.click(); return 'btn.click()'; }
            return 'not found';
          }, tab.dataId);
          console.log(`  Method: ${method}`);

          const resolved = await responsePromise;
          console.log(`  ✅ Data response received: ${typeof resolved === 'string' && resolved !== 'timeout' ? resolved.substring(0, 80) : resolved}`);

          await new Promise(r => setTimeout(r, 3000));
        }
      }

      const filePath = path.join(process.cwd(), tab.file);
      await page.screenshot({ path: filePath, clip: { x: 0, y: 0, width: SS_W, height: tab.cropH } });
      const kb = Math.round(fs.statSync(filePath).size / 1024);
      console.log(`  📸 ${tab.file} — ${SS_W}x${tab.cropH}px (${kb} KB)`);
      screenshots.push({ ...tab, filePath });
    }
  } finally {
    await browser.close();
  }

  return screenshots;
}

// ── 2. Stitch screenshots vertically ─────────────────────────────
async function stitchScreenshots(screenshots) {
  const LABEL_H = 44;
  const GAP     = 8;
  const outPath = path.join(process.cwd(), 'qc-combined.png');

  const TOTAL_H = screenshots.reduce((sum, t) => sum + LABEL_H + t.cropH + GAP, 0) - GAP;

  const composites = [];
  let yOffset = 0;

  for (const tab of screenshots) {
    const labelSvg = Buffer.from(
      `<svg width="${SS_W}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${SS_W}" height="${LABEL_H}" fill="#1a1d23"/>
        <text x="800" y="30" text-anchor="middle"
          font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#ffffff">
          ${tab.emoji}  ${tab.name} Pendency
        </text>
      </svg>`
    );

    composites.push({ input: labelSvg,      top: yOffset,              left: 0 });
    composites.push({ input: tab.filePath,  top: yOffset + LABEL_H,    left: 0 });
    yOffset += LABEL_H + tab.cropH + GAP;
  }

  await sharp({
    create: { width: SS_W, height: TOTAL_H, channels: 4, background: { r: 17, g: 19, b: 23, alpha: 1 } }
  })
  .png()
  .composite(composites)
  .toFile(outPath);

  const kb = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`\n🖼 Combined: qc-combined.png — ${SS_W}×${TOTAL_H}px (${kb} KB)`);
  return outPath;
}

// ── 3. Upload one image to Slack ──────────────────────────────────
async function uploadImage(filePath, title, comment) {
  const img  = fs.readFileSync(filePath);
  const size = img.length;

  const r1 = await httpsRequest('slack.com',
    `/api/files.getUploadURLExternal?filename=${path.basename(filePath)}&length=${size}`,
    'GET', { 'Authorization': `Bearer ${BOT_TOKEN}` }, null);
  const j1 = JSON.parse(r1.body);
  if (!j1.ok) throw new Error(`getUploadURLExternal: ${j1.error}`);

  const u = new URL(j1.upload_url);
  await httpsRequest(u.hostname, u.pathname + u.search, 'POST',
    { 'Content-Type': 'image/png', 'Content-Length': size }, img);

  const body3 = JSON.stringify({
    files: [{ id: j1.file_id, title }],
    channel_id: CHANNEL,
    initial_comment: comment,
  });
  const r3 = await httpsRequest('slack.com', '/api/files.completeUploadExternal', 'POST', {
    'Authorization':  `Bearer ${BOT_TOKEN}`,
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body3),
  }, body3);
  const j3 = JSON.parse(r3.body);
  if (!j3.ok) throw new Error(`completeUploadExternal: ${j3.error}`);
  console.log(`  ✅ Posted to Slack`);
}

// ── 4. Upload combined image ──────────────────────────────────────
async function uploadCombined(combinedPath) {
  const now = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
  });
  const comment =
    `🚨 *QC Pendency Report* | ${now} IST\n` +
    `<${DASHBOARD_URL}|🔗 Open Live Dashboard>\n\n` +
    `🖼 Images  ·  🎬 Videos  ·  🔁 360°\n\n` +
    `<@U08VA3ARKLM> <@U098XR16D6U> <@U098QVB7BMF>`;
  await uploadImage(combinedPath, `QC Pendency Report · ${now} IST`, comment);
}

// ── 5. Webhook fallback ───────────────────────────────────────────
async function sendWebhook() {
  if (!WEBHOOK) { console.log('⚠ No webhook configured'); return; }
  const now = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
  });
  const payload = JSON.stringify({
    text: `🚨 *QC Pendency Alert* | ${now} IST\n<${DASHBOARD_URL}|🔗 Open Live Dashboard>\n\n<@U08VA3ARKLM> <@U098XR16D6U> <@U098QVB7BMF>`,
  });
  const wUrl = new URL(WEBHOOK);
  const r = await httpsRequest(wUrl.hostname, wUrl.pathname, 'POST',
    { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, payload);
  console.log('Webhook:', r.status === 200 ? '✅ Sent' : `❌ ${r.status}`);
}

// ── Main ──────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🚀 QC Bot (3-tab)  —  ${new Date().toISOString()}\n`);
  try {
    const screenshots = await takeScreenshots();
    console.log(`\n📦 ${screenshots.length} screenshots ready`);

    if (BOT_TOKEN && CHANNEL) {
      try {
        const combinedPath = await stitchScreenshots(screenshots);
        await uploadCombined(combinedPath);
        console.log('\n✅ Done!\n');
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
