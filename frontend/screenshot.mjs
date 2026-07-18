import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome'
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('http://localhost:5173/login');
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/login.png' });
await browser.close();
console.log('done');
