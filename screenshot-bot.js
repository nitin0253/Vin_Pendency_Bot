const fs    = require('fs');
const https = require('https');
const path  = require('path');

const SCREENSHOT = path.join(process.cwd(), 'dashboard.png');

const DASHBOARD_URL = 'https://vin-tracker-delivery.vercel.app/';
const WEBHOOK       = process.env.SLACK_WEBHOOK || 'https://hooks.slack.com/services/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';
const BOT_TOKEN     = process.env.SLACK_BOT_TOKEN;
const CHANNEL       = process.env.SLACK_CHANNEL;

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

// ── 2. HTTPS helper ───────────────────────────────────────────────
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── 3. Upload image using new Slack files API ─────────────────────
async function uploadToSlack() {
  const imgBuffer = fs.readFileSync(SCREENSHOT);
  const fileSize  = imgBuffer.length;
  const now       = new Date().toLocaleString('en-IN', { timeZone:'Asia/Kolkata', dateStyle:'medium', timeStyle:'short' });
  const comment   = `📊 *QC Pendency Dashboard*  ·  ${now} IST\n<${DASHBOARD_URL}|🔗 Open Live Dashboard>`;

  // Step 1: Get upload URL
  console.log('📤 Getting Slack upload URL...');
  const urlRes = await request({
    hostname: 'slack.com',
    path: '/api/files.getUploadURLExternal',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
  }, JSON.stringify({ filename: 'dashboard.png', length: fileSize }));

  const urlData = JSON.parse(urlRes.body);
  if (!urlData.ok) throw new Error(`getUploadURL failed: ${urlData.error}`);
  
  const { upload_url, file_id } = urlData;
  console.log('✅ Got upload URL, file_id:', file_id);

  // Step 2: Upload the file to the provided URL
  console.log('📤 Uploading image...');
  const uploadUrlObj = new URL(upload_url);
  const uploadRes = await request({
    hostname: uploadUrlObj.hostname,
    path: uploadUrlObj.pathname + uploadUrlObj.search,
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': fileSize,
    },
  }, imgBuffer);

  console.log('Upload response:', uploadRes.status, uploadRes.body.slice(0, 100));

  // Step 3: Complete the upload (publish to channel)
  console.log('📤 Publishing to channel...');
  const completeRes = await request({
    hostname: 'slack.com',
    path: '/api/files.completeUploadExternal',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
  }, JSON.stringify({
    files: [{ id: file_id, title: 'QC Pendency Dashboard' }],
    channel_id: CHANNEL,
    initial_comment: comment,
  }));

  const completeData = JSON.parse(completeRes.body);
  if (!completeData.ok) throw new Error(`completeUpload failed: ${completeData.error}`);
  console.log('✅ Screenshot posted to Slack!');
}

// ── 4. Webhook fallback ───────────────────────────────────────────
async function sendWebhook() {
  const now = new Date().toLocaleString('en-IN', { timeZone:'Asia/Kolkata', dateStyle:'medium', timeStyle:'short' });
  console.log('📨 Sending webhook message...');
  const payload = JSON.stringify({
    text: `📊 *QC Pendency Dashboard*  ·  ${now} IST\n<${DASHBOARD_URL}|🔗 Open Live Dashboard>`,
  });
  const res = await request({
    hostname: 'hooks.slack.com',
    path: WEBHOOK.replace('https://hooks.slack.com', ''),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, payload);
  console.log('Webhook response:', res.status, res.body);
  if (res.status !== 200) throw new Error(`Webhook failed: ${res.status} ${res.body}`);
  console.log('✅ Webhook sent!');
}

// ── Main ──────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🚀 QC Bot  —  ${new Date().toISOString()}\n`);
  try {
    await takeScreenshot();
    if (BOT_TOKEN && CHANNEL) {
      try {
        await uploadToSlack();
        return;
      } catch (e) {
        console.error('Image upload failed:', e.message, '— falling back to webhook');
      }
    }
    await sendWebhook();
  } catch (err) {
    console.error('\n❌ Fatal:', err.message);
    process.exit(1);
  }
})();
