const fs    = require('fs');
const https = require('https');
const path  = require('path');

const DASHBOARD_URL = 'https://spyne-qc-hub.vercel.app/';
const BOT_TOKEN     = process.env.SLACK_BOT_TOKEN;
const CHANNEL       = process.env.SLACK_CHANNEL;
const WEBHOOK       = process.env.SLACK_WEBHOOK;

// Tab definitions — label must match visible button text on the dashboard
const TABS = [
  { name: 'Images',  file: 'qc-images.png'  },
  { name: 'Videos',  file: 'qc-videos.png'  },
  { name: '360°',    file: 'qc-360.png'     },
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

    // Force dark theme
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

    for (const tab of TABS) {
      console.log(`\n🔖 Switching to tab: ${tab.name}`);

      // Click the tab button that contains the tab name text
      const clicked = await page.evaluate((tabName) => {
        // Try <button> elements first, then any clickable element
        const buttons = Array.from(document.querySelectorAll('button, [role="tab"], a'));
        const btn = buttons.find(el => el.textContent.trim().startsWith(tabName));
        if (btn) { btn.click(); return true; }
        return false;
      }, tab.name);

      if (!clicked) {
        console.warn(`⚠ Could not find tab "${tab.name}" — trying XPath`);
        // Fallback: XPath text match
        try {
          await page.waitForXPath(`//*[contains(text(),'${tab.name}')]`, { timeout: 5000 });
          const [el] = await page.$x(`//*[contains(text(),'${tab.name}')]`);
          if (el) await el.click();
        } catch {
          console.warn(`⚠ XPath fallback also failed for "${tab.name}" — screenshotting current state`);
        }
      }

      // Wait for content to settle after tab switch
      await new Promise(r => setTimeout(r, 3000));

      // Try to wait for data metrics to appear
      try {
        await page.waitForSelector('.metric, [class*="metric"], [class*="card"], [class*="stat"]', { timeout: 15000 });
        console.log(`✅ Content loaded for ${tab.name}`);
      } catch {
        console.log(`⚠ Metric selector timeout for ${tab.name} — proceeding anyway`);
      }

      // Extra settle for charts/animations
      await new Promise(r => setTimeout(r, 4000));

      const filePath = path.join(process.cwd(), tab.file);
      await page.screenshot({ path: filePath, clip: { x: 0, y: 0, width: 1600, height: 900 } });
      const kb = Math.round(fs.statSync(filePath).size / 1024);
      console.log(`📸 Screenshot saved: ${tab.file} (${kb} KB)`);
      screenshots.push({ ...tab, filePath, kb });
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

  // Step 1: Get upload URL
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

  // Step 2: Upload file bytes to presigned URL
  const uploadParsed = new URL(upload_url);
  await httpsRequest(
    uploadParsed.hostname,
    uploadParsed.pathname + uploadParsed.search,
    'POST',
    { 'Content-Type': 'image/png', 'Content-Length': size },
    img
  );

  // Step 3: Complete upload — share to channel
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
  console.log(`✅ Uploaded: ${title}`);
}

// ── 3. Upload all 3 screenshots ───────────────────────────────────
async function uploadAllScreenshots(screenshots) {
  const now = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
  });

  const tabEmojis = { 'Images': '🖼', 'Videos': '🎬', '360°': '🔁' };

  for (let i = 0; i < screenshots.length; i++) {
    const { name, filePath } = screenshots[i];
    const emoji = tabEmojis[name] || '📊';
    const isFirst = i === 0;

    // Only add the header mention on the first screenshot
    const comment = isFirst
      ? `🚨 *QC Pendency Report* | ${now} IST\n<${DASHBOARD_URL}|🔗 Open Live Dashboard>\n\n${emoji} *${name} Pendency*\n\n<@U08VA3ARKLM> <@U098XR16D6U> <@U098QVB7BMF>`
      : `${emoji} *${name} Pendency*`;

    await uploadImage(
      filePath,
      `QC ${name} Pendency · ${now} IST`,
      comment
    );

    // Small delay between uploads to avoid rate limits
    if (i < screenshots.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

// ── 4. Webhook fallback (text only) ──────────────────────────────
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
  console.log('Webhook:', r.status === 200 ? '✅ Sent' : `❌ ${r.status} ${r.body}`);
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
        console.log('\n✅ All 3 screenshots posted to Slack!\n');
        return;
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
