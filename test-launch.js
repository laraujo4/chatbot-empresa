const puppeteer = require('puppeteer');

(async () => {
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.goto('https://www.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('✅ Puppeteer abriu o navegador e carregou o site com sucesso.');
    await browser.close();
  } catch (err) {
    console.error('❌ Erro ao lançar o browser com puppeteer:', err);
    process.exit(1);
  }
})();