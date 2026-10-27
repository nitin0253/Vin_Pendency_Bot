const fs    = require('fs');
const https = require('https');
const path  = require('path');
const sharp = require('sharp');

const DASHBOARD_URL = 'https://spyne-qc-hub.vercel.app/';
const BOT_TOKEN     = process.env.SLACK_BOT_TOKEN;
const CHANNEL       = process.env.SLACK_CHANNEL;
const WEBHOOK       = process.env.SLACK_WEBHOOK;

const SS_W = 1600;

// The Images tab embeds this dashboard; its /api/data can be slow (~60s, ~11MB)
// or return HTTP 500. We wait for it explicitly (bounded) instead of relying on
// networkidle0, which never settles while that request is in flight.
const IMAGES_API_HOST = 'vin-tracker-delivery.vercel.app';

// Each tab's iframe lives on its own origin. frameHostMatch is used to look
// the frame up via page.frames() (same-origin iframes aren't accessible via
// document.querySelectorAll from the shell).
const TABS = [
  { name: 'Images', dataId: 'images', file: 'qc-images.png', emoji: '🖼', waitForData: true, cropH: 560,
    frameHostMatch: 'vin-tracker-delivery' },
  { name: 'Videos', dataId: 'videos', file: 'qc-videos.png', emoji: '🎬', waitForData: true, cropH: 560,
    frameHostMatch: 'video-tracker-delivery' },
  { name: '360°',   dataId: '360',    file: 'qc-360.png',    emoji: '🔁', waitForData: true, cropH: 560,
    frameHostMatch: '360-qc-pendency.spyne.ai' },
];

// How long (ms) to wait per tab for #loading → #dash and real numbers to render.
const TAB_READY_TIMEOUT_MS = 60000;

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

// ── Force light theme on the shell + every (cross-origin) iframe ──
// The outer shell (spyne-qc-hub) is hardcoded dark CSS, so we inject an
// override stylesheet. The 3 inner iframes support `data-theme="light"`.
const SHELL_LIGHT_CSS = `
  html,body{background:#f4f5fa !important;color:#090c1a !important;}
  .hdr{background:#eef0f8 !important;border-bottom:1px solid #dde1f0 !important;}
  .tab{color:#3d4568 !important;}
  .tab:hover{color:#090c1a !important;background:rgba(58,92,240,.06) !important;}
  .tab.active{color:#3a5cf0 !important;background:rgba(58,92,240,.1) !important;border-color:rgba(58,92,240,.3) !important;}
  iframe{background:#f4f5fa !important;}
  .soon,.frame-wrap{background:#f4f5fa !important;}
`;

async function applyLightTheme(page) {
  // Outer shell
  try {
    await page.addStyleTag({ content: SHELL_LIGHT_CSS });
  } catch(e) {}
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    try { localStorage.setItem('qc-theme', 'light'); } catch(e) {}
    try { localStorage.setItem('vpend-theme', 'light'); } catch(e) {}
  });
  // Each iframe (cross-origin — reach via page.frames())
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      await f.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'light');
        try { localStorage.setItem('qc-theme', 'light'); } catch(e) {}
        try { localStorage.setItem('vpend-theme', 'light'); } catch(e) {}
        const btn = document.getElementById('tbtn');
        if (btn) btn.textContent = '☀️';
      });
    } catch(e) {}
  }
}

// ── Find the live Puppeteer Frame for a given tab ───────────────
// Each tab is a cross-origin iframe; page.frames() reaches across origins
// (document.contentDocument from the shell page does NOT — that's what the
// earlier version silently fell through, screenshotting the loading screen).
function findTabFrame(page, hostMatch) {
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    if (f.url().includes(hostMatch)) return f;
  }
  return null;
}

// ── Wait until an iframe actually shows real data, not the spinner ──
// Each inner dashboard flips #loading → display:none and #dash → display:block
// only after its /api/data fetch + processData() finish. We poll that state
// AND confirm at least one metric card has rendered text — belt-and-braces
// against a race where #dash is shown but numbers haven't painted yet.
async function waitForTabReady(page, tab, timeoutMs = TAB_READY_TIMEOUT_MS) {
  const start = Date.now();
  let lastReason = 'frame-not-found';

  while (Date.now() - start < timeoutMs) {
    const frame = findTabFrame(page, tab.frameHostMatch);
    if (!frame) {
      lastReason = 'frame-not-found';
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    try {
      const state = await frame.evaluate(() => {
        const loading = document.getElementById('loading');
        const dash    = document.getElementById('dash');
        if (!loading || !dash) return { ready: false, reason: 'elements-missing' };

        const loadingDisp = (loading.style.display || getComputedStyle(loading).display);
        const dashDisp    = (dash.style.display    || getComputedStyle(dash).display);
        if (loadingDisp !== 'none')      return { ready: false, reason: 'loading-visible' };
        if (dashDisp === 'none')         return { ready: false, reason: 'dash-hidden'   };

        // Numbers painted? Any metric/stat/hour card with non-empty text is enough.
        // We DON'T require >0 — a true zero count is a legitimate rendered state.
        const vals = dash.querySelectorAll('.metric-val, .stat-card-val, .hcard-n');
        if (vals.length === 0) return { ready: false, reason: 'no-value-nodes' };
        const painted = Array.from(vals).some(el => (el.textContent || '').trim().length > 0);
        return painted
          ? { ready: true,  reason: 'ok', count: vals.length }
          : { ready: false, reason: 'values-empty' };
      });

      if (state.ready) {
        console.log(`  ✅ ${tab.name} ready (${state.count} value nodes rendered)`);
        return true;
      }
      lastReason = state.reason;
    } catch (e) {
      // Frame can navigate / detach while we poll — treat as still-loading.
      lastReason = `evaluate-error:${e.message.slice(0, 60)}`;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  throw new Error(`${tab.name} tab did not render within ${timeoutMs}ms (last: ${lastReason})`);
}

// ── Block non-essential requests to cut data transfer per run ────
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

// ── Pre-warm the VIN-Tracker cache so the dashboard loads instantly ──
async function warmImageCache() {
  console.log('🔥 Pre-warming VIN-Tracker cache...');
  try {
    const r = await httpsRequest(IMAGES_API_HOST, '/api/data?force=1', 'GET',
      { 'User-Agent': 'QC-Bot/1.0' }, null);
    console.log(`  Warm response: HTTP ${r.status} (${r.body.length} bytes)`);
    return r.status;
  } catch (e) {
    console.warn(`  Warm failed: ${e.message}`);
    return 0;
  }
}

// ── 1a. Take 3 screenshots (single attempt) ───────────────────────
async function takeScreenshotsOnce() {
  const puppeteer = require('puppeteer');

  await warmImageCache();

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
    const imagesDataPromise = page
      .waitForResponse(
        r => r.url().includes(IMAGES_API_HOST) && r.url().includes('/api/data'),
        { timeout: 90000 }
      )
      .then(r => ({ status: r.status(), url: r.url() }))
      .catch(() => ({ status: 0, url: 'timeout' }));

    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await applyLightTheme(page);

    const imagesData = await imagesDataPromise;
    console.log(`  Images data: HTTP ${imagesData.status}`);

    // If the API returned an error, reload once — the pre-warm or cron should
    // have populated the CDN cache by now.
    if (imagesData.status !== 200) {
      console.log('  ⚠ Non-200 — reloading to pick up warmed cache...');
      await new Promise(r => setTimeout(r, 5000));
      const retryPromise = page
        .waitForResponse(
          r => r.url().includes(IMAGES_API_HOST) && r.url().includes('/api/data'),
          { timeout: 90000 }
        )
        .then(r => r.status())
        .catch(() => 0);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await applyLightTheme(page);
      const retryStatus = await retryPromise;
      console.log(`  Retry: HTTP ${retryStatus}`);
    }

    for (const tab of TABS) {
      console.log(`\n🔖 Tab: ${tab.name}`);

      if (tab.dataId !== 'images') {
        // Switch to the tab in the shell; the iframe lazy-loads its src here.
        const method = await page.evaluate((dataId) => {
          if (typeof activate === 'function') { activate(dataId); return 'activate()'; }
          const btn = document.querySelector(`button[data-id="${dataId}"]`);
          if (btn) { btn.click(); return 'btn.click()'; }
          return 'not found';
        }, tab.dataId);
        console.log(`  Switched via: ${method}`);
      }

      // The hard gate: don't screenshot until #loading is gone, #dash is
      // visible, and real values are painted inside the iframe. Throws on
      // timeout so the outer retry wrapper gets another shot.
      await waitForTabReady(page, tab);

      // Lazy-loaded iframes (videos/360) have fresh document roots — re-apply
      // light theme so the capture isn't dark. Harmless on the images tab too.
      await applyLightTheme(page);
      // Tiny settle for the fadeUp CSS animation on #dash > *.
      await new Promise(r => setTimeout(r, 600));

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

// ── 1b. Retry wrapper — ride out intermittent upstream slowness/500s ──
async function takeScreenshots(maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`\n🔁 Screenshot attempt ${attempt}/${maxAttempts}`);
      return await takeScreenshotsOnce();
    } catch (err) {
      lastErr = err;
      console.error(`⚠ Attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 5000));
    }
  }
  throw lastErr;
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
        <rect width="${SS_W}" height="${LABEL_H}" fill="#eef0f8"/>
        <text x="800" y="30" text-anchor="middle"
          font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#090c1a">
          ${tab.emoji}  ${tab.name} Pendency
        </text>
      </svg>`
    );

    composites.push({ input: labelSvg,      top: yOffset,              left: 0 });
    composites.push({ input: tab.filePath,  top: yOffset + LABEL_H,    left: 0 });
    yOffset += LABEL_H + tab.cropH + GAP;
  }

  await sharp({
    create: { width: SS_W, height: TOTAL_H, channels: 4, background: { r: 244, g: 245, b: 250, alpha: 1 } }
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
