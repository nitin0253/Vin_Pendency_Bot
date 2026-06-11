const fs    = require('fs');
const https = require('https');
const path  = require('path');
const sharp = require('sharp');

const DASHBOARD_URL = 'https://spyne-qc-hub.vercel.app/';
const BOT_TOKEN     = process.env.SLACK_BOT_TOKEN;
const CHANNEL       = process.env.SLACK_CHANNEL;
const WEBHOOK       = process.env.SLACK_WEBHOOK;

// Crop height — captures header + overview cards + hourly breakdown only
const CROP_H = 620;
const SS_W   = 1600;

const TABS = [
  { name: 'Images', dataId: 'images', file: 'qc-images.png', emoji: '🖼',  waitForData: true  },
  { name: 'Videos', dataId: 'videos', file: 'qc-videos.png', emoji: '🎬',  waitForData: true  },
  { name: '360°',   dataId: '360',    file: 'qc-360.png',    emoji: '🔁',  waitForData: false }, // Coming soon — no data loads
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

// ── Wait for loading spinner to disappear ────────────────────────
// Uses waitForSelector to detect the spinner element disappearing —
// more reliable than textContent checks in headless mode
async function waitForDataLoaded(page, tabName, timeoutMs = 45000) {
  console.log(`  ⏳ Waiting for "${tabName}" data...`);
  const start = Date.now();

  try {
    // Wait for the spinner/loading element to vanish from DOM
    // The loading screen shows a <div class="loading"> or similar with the spinner
    // We wait until it's gone OR a known data element appears
    await page.waitForFunction(() => {
      const body = document.body;
      if (!body) return false;

      // Check for any visible spinner/loading elements
      const spinners = body.querySelectorAll(
        '.loading, .spinner, [class*="loading"], [class*="spinner"], [class*="fetching"]'
      );
      for (const el of spinners) {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
          return false; // still loading
        }
      }

      // Also check for the loading text directly
      const allText = Array.from(body.querySelectorAll('*'))
        .filter(el => el.children.length === 0)
        .map(el => el.textContent.trim())
        .join(' ');

      if (allText.includes('FETCHING QC PENDING DATA') || allText.includes('Loading...')) {
        return false; // still loading
      }

      return true;
    }, { timeout: timeoutMs, polling: 500 });

    console.log(`  ✅ Loaded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log(`  ⚠ Timed out after ${((Date.now() - start) / 1000).toFixed(1)}s — proceeding anyway`);
  }

  // Extra settle for animations/charts
  await new Promise(r => setTimeout(r, 2500));
}

// ── 1. Take 3 screenshots (cropped to hourly breakdown) ───────────
async function takeScreenshots() {
  const puppeteer = require('puppeteer');
  console.log('🌐 Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'],
  });

  const screenshots = [];

  try {
    const page = await browser.newPage();
    // Make viewport tall enough to render all content, we'll crop after
    await page.setViewport({ width: SS_W, height: 900 });

    console.log('📡 Loading dashboard...');
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Force dark theme
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

    // Wait for Images tab (default) to load
    await waitForDataLoaded(page, 'Images');

    for (const tab of TABS) {
      console.log(`\n🔖 Tab: ${tab.name}`);

      if (tab.dataId !== 'images') {
        // Call activate() — mirrors onclick="activate('videos')"
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

        // Confirm the tab button went active
        try {
          await page.waitForFunction((dataId) => {
            const btn = document.querySelector(`button[data-id="${dataId}"]`);
            return btn && btn.classList.contains('active');
          }, { timeout: 10000 }, tab.dataId);
          console.log(`  ✅ Tab button active`);
        } catch {
          console.log(`  ⚠ Active class check timed out`);
        }

        // Wait for data only on tabs that actually load data
        if (tab.waitForData) {
          await waitForDataLoaded(page, tab.name);
        } else {
          // 360° is "Coming soon" — just wait a moment for tab transition
          console.log(`  ⏭ Skipping data wait (Coming Soon tab)`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      // Screenshot cropped to CROP_H — cuts off below hourly breakdown
      const filePath = path.join(process.cwd(), tab.file);
      await page.screenshot({ path: filePath, clip: { x: 0, y: 0, width: SS_W, height: CROP_H } });
      const kb = Math.round(fs.statSync(filePath).size / 1024);
      console.log(`  📸 ${tab.file} (${kb} KB) — cropped to ${CROP_H}px`);
      screenshots.push({ ...tab, filePath });
    }
  } finally {
    await browser.close();
  }

  return screenshots;
}

// ── 2. Stitch 3 screenshots vertically into one image ─────────────
async function stitchScreenshots(screenshots) {
  const LABEL_H = 44;
  const GAP     = 8;
  const TOTAL_W = SS_W;
  const TOTAL_H = (CROP_H + LABEL_H + GAP) * screenshots.length - GAP;
  const outPath = path.join(process.cwd(), 'qc-combined.png');

  const composites = [];

  for (let i = 0; i < screenshots.length; i++) {
    const yBase = i * (CROP_H + LABEL_H + GAP);

    // Label bar SVG for this panel
    const labelSvg = Buffer.from(`
      <svg width="${TOTAL_W}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${TOTAL_W}" height="${LABEL_H}" fill="#1a1d23"/>
        <text x="800" y="30" text-anchor="middle"
          font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#ffffff">
          ${screenshots[i].emoji}  ${screenshots[i].name} Pendency
        </text>
      </svg>`);

    composites.push({ input: labelSvg,                       top: yBase,              left: 0 });
    composites.push({ input: screenshots[i].filePath,        top: yBase + LABEL_H,    left: 0 });
  }

  await sharp({
    create: { width: TOTAL_W, height: TOTAL_H, channels: 4, background: { r: 17, g: 19, b: 23, alpha: 1 } }
  })
  .png()
  .composite(composites)
  .toFile(outPath);

  const kb = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`\n🖼 Combined image: qc-combined.png (${TOTAL_W}×${TOTAL_H}px, ${kb} KB)`);
  return outPath;
}

// ── 3. Upload one image to Slack ──────────────────────────────────
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
  const u = new URL(upload_url);
  await httpsRequest(u.hostname, u.pathname + u.search, 'POST',
    { 'Content-Type': 'image/png', 'Content-Length': size }, img);

  const body3 = JSON.stringify({
    files: [{ id: file_id, title }],
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
