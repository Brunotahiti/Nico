// Vérification rapide des deux sources : `npm run check`
import * as immo from './scrapers/immobilier.js';
import * as pa from './scrapers/petitesannonces.js';

for (const [name, mod] of [['immobilier.pf', immo], ['petitesannonces.pf', pa]]) {
  try {
    const items = await mod.fetchLatest({ size: 5 });
    console.log(`\n=== ${name} : ${items.length} annonces`);
    for (const it of items.slice(0, 5)) {
      console.log(`- [${it.kind}] ${it.title} — ${it.priceLabel || 'prix ?'}\n  ${it.url}`);
    }
  } catch (err) {
    console.error(`!!! ${name} : ${err.message}`);
    process.exitCode = 1;
  }
}
