const fs    = require('fs');
const https = require('https');
const path  = require('path');

const SCREENSHOT = path.join(process.cwd(), 'dashboard.png');

const CONFIG = {
  dashboardUrl:   'https://vin-tracker-delivery.vercel.app/',
  slackWebhook:   process.env.SLACK_WEBHOOK || 'https://hooks.slack.com/services/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',
  viewport:       { width: 1600, height: 900 },
  dataTimeout:    30000,
  settleMs:       4000,
};

async function takeScreenshot() {
  const puppeteer = require('puppeteer');

  console.log('🌐 Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
    ],
    executablePath: process.env.PUPPETEER_EXEC_PATH || undefined,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(CONFIG.viewport);

    console.log(`📡 Loading: ${CONFIG.dashboardUrl}`);
    await page.goto(CONFIG.dashboardUrl, {
      waitUntil: 'networkidle2',
      timeout: 45000,
    });

    console.log('⏳ Waiting for data...');
    try {
      await page.waitForSelector('#metrics .metric', { timeout: CONFIG.dataTimeout });
      console.log('✅ Data loaded');
    } catch {
      console.log('⚠ Data timeout — capturing anyway');
    }

    await new Promise(r => setTimeout(r, CONFIG.settleMs));

    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await new Promise(r => setTimeout(r, 500));

    await page.screenshot({
      path: SCREENSHOT,
      clip: { x: 0, y: 0, width: CONFIG.viewport.width, height: CONFIG.viewport.height },
      type: 'png',
    });

    const kb = Math.round(fs.statSync(SCREENSHOT).size / 1024);
    console.log(`📸 Screenshot saved: ${SCREENSHOT} (${kb} KB)`);
  } finally {
    await browser.close();
  }
}

function nowIST() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

async function postToSlack() {
  const token   = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL;
  const now     = nowIST();

  // Mode A: Bot token → upload real image
  if (token && channel) {
    console.log('📤 Uploading screenshot to Slack...');
    const imgBuffer = fs.readFileSync(SCREENSHOT);
    const boundary  = 'B' + Date.now();

    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="channels"\r\n\r\n${channel}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="initial_comment"\r\n\r\n` +
        `📊 *QC Pendency Dashboard*  ·  ${now} IST\n<${CONFIG.dashboardUrl}|🔗 Open Live Dashboard>\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="filename"\r\n\r\ndashboard.png\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="dashboard.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`
      ),
      imgBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const ok = await new Promise(resolve => {
      const req = https.request({
        hostname: 'slack.com',
        path:     '/api/files.upload',
        method:   'POST',
        headers:  {
          'Authorization':  `Bearer ${token}`,
          'Content-Type':   `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.ok) { console.log('✅ Screenshot posted to Slack!'); resolve(true); }
            else { console.error('❌ Slack error:', j.error); resolve(false); }
          } catch(e) { console.error('Parse error:', e.message); resolve(false); }
        });
      });
      req.on('error', e => { console.error('Request error:', e.message); resolve(false); });
      req.write(body);
      req.end();
    });

    if (ok) return;
    console.log('Falling back to webhook...');
  }

  // Mode B: Webhook → text message
  console.log('📨 Sending webhook message...');
  const payload = JSON.stringify({
    text: `📊 *QC Pendency Dashboard*  ·  ${now} IST\n<${CONFIG.dashboardUrl}|🔗 Open Live Dashboard>`,
  });

  await new Promise((resolve, reject) => {
    const url = new URL(CONFIG.slackWebhook);
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        if (res.statusCode === 200) { console.log('✅ Webhook sent'); resolve(); }
        else reject(new Error(`Slack ${res.statusCode}: ${b}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

(async () => {
  console.log(`\n🚀 QC Bot  —  ${new Date().toISOString()}\n`);
  try {
    await takeScreenshot();
    await postToSlack();
    console.log('\n✅ All done!\n');
  } catch (err) {
    console.error('\n❌ Fatal error:', err);
    process.exit(1);
  }
})();
