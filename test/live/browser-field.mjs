// Optional Chromium counterpart to text-field.py. Playwright and the browser
// live outside the project: select the module with COMPANION_TEST_PLAYWRIGHT.
// The browser has a fresh profile, synthetic pages, and no server connection.
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const { chromium } = await import(process.env.COMPANION_TEST_PLAYWRIGHT);
const directory = process.argv[2];
const browser = await chromium.launch({
  headless: false,
  executablePath: process.env.COMPANION_TEST_CHROMIUM || '/usr/bin/chromium',
  args: ['--ozone-platform=wayland'],
});
const pages = {};
let stopping = false;

for (const name of ['A', 'B']) {
  const page = await browser.newPage();
  await page.setContent(
    `<title>Companion test ${name} ${directory}</title>` +
      '<textarea style="width:95%;height:85vh" aria-label="Disposable field"></textarea>',
  );
  await page.locator('textarea').click();
  pages[name] = page;
}

await writeFile(
  join(directory, 'editor.json'),
  JSON.stringify({ kind: 'chromium', version: browser.version() }),
);

async function save() {
  if (stopping) {
    return;
  }

  const fields = {};
  for (const [name, page] of Object.entries(pages)) {
    fields[name] = await page.locator('textarea').inputValue();
  }
  await writeFile(join(directory, 'text.tmp'), JSON.stringify(fields));
  await rename(join(directory, 'text.tmp'), join(directory, 'text.json'));
  setTimeout(() => void save().catch(() => {}), 50);
}

process.once('SIGTERM', async () => {
  stopping = true;
  await browser.close();
});
await save();
