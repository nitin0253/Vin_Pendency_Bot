// screenshot-bot.js
// Runs in GitHub Actions every hour — takes screenshot, posts to Slack

const { execSync } = require('child_process');
const fs    = require('fs');
const https = require('https');

const CONFIG = {
  dashboardUrl:    'https://vin-tracker-delivery.vercel.app/',
  slackWebhook:    process.env.SLACK_WEBHOOK || 'https://hooks.slack.com/services/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',
  screenshotPath:  '/tmp/qc-dashboard.png',
  viewport:        { width: 1600, height: 900 },
  waitForSelector: '#metrics .metric',
  dataTimeout:     25000,
  settleMs:        3000,
};

async function takeScreenshot() {
  const puppeteer = require('puppeteer');
  console.log('🌐 Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--window-size=1600,900',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport(CONFIG.viewport);

  console.log(`📡 Loading: ${CONFIG.dashboardUrl}`);
  await page.goto(CONFIG.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('⏳ Waiting for data...');
  try {
    await page.waitForSelector(CONFIG.waitForSelector, { timeout: CONFIG.dataTimeout });
    console.log('✅ Data loaded');
  } catch {
    console.log('⚠ Timeout — capturing anyway');
  }

  await new Promise(r => setTimeout(r, CONFIG.settleMs));

  // Force dark theme
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await new Promise(r => setTimeout(r, 300));

  await page.screenshot({
    path: CONFIG.screenshotPath,
    clip: { x: 0, y: 0, width: CONFIG.viewport.width, height: CONFIG.viewport.height },
    type: 'png',
  });

  await browser.close();
  const kb = Math.round(fs.statSync(CONFIG.screenshotPath).size / 1024);
  console.log(`📸 Saved (${kb} KB)`);
}

function nowIST() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
  });
}

async function postToSlack() {
  const token   = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL;
  const now     = nowIST();

  // ── Mode A: Bot Token → upload actual image ─────────────────
  if (token && channel) {
    console.log('📤 Uploading image via Bot Token...');
    const imgBuffer = fs.readFileSync(CONFIG.screenshotPath);
    const boundary  = 'Boundary' + Date.now();

    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="channels"\r\n\r\n${channel}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="initial_comment"\r\n\r\n` +
        `📊 *QC Pendency Dashboard* · ${now} IST\n<${CONFIG.dashboardUrl}|🔗 Open Live Dashboard>\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="filename"\r\n\r\nqc-dashboard.png\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="qc-dashboard.png"\r\nContent-Type: image/png\r\n\r\n`
      ),
      imgBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const ok = await new Promise(resolve => {
      const req = https.request({
        hostname: 'slack.com', path: '/api/files.upload', method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try { const j = JSON.parse(d); console.log(j.ok ? '✅ Image sent' : '⚠ ' + j.error); resolve(j.ok); }
          catch { resolve(false); }
        });
      });
      req.on('error', e => { console.error(e.message); resolve(false); });
      req.write(body); req.end();
    });
    if (ok) return;
  }

  // ── Mode B: Webhook → text message fallback ──────────────────
  console.log('📨 Sending webhook message...');
  const payload = JSON.stringify({
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '📊 QC Pendency Dashboard — Hourly Report', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${now} IST*\n<${CONFIG.dashboardUrl}|🔗 Open Live Dashboard>` } },
    ],
  });

  await new Promise((resolve, reject) => {
    const url = new URL(CONFIG.slackWebhook);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error(`Slack ${res.statusCode}: ${b}`)));
    });
    req.on('error', reject); req.write(payload); req.end();
  });
  console.log('✅ Webhook sent');
}

(async () => {
  console.log(`\n🚀 QC Bot — ${new Date().toISOString()}`);
  try {
    await takeScreenshot();
    await postToSlack();
    console.log('✅ Done\n');
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  }
})();
