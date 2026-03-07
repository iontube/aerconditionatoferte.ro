import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pagesDir = path.join(__dirname, '..', 'src', 'pages');

const excludeFiles = [
  'index.astro',
  'contact.astro',
  'sitemap.astro',
  'politica-de-confidentialitate.astro',
  'termeni-si-conditii.astro',
  'politica-cookies.astro',
  'disclaimer-afiliere.astro'
];

function parseFrontmatter(content) {
  const fm = {};
  const slugMatch = content.match(/slug:\s*"([^"]+)"/);
  const titleMatch = content.match(/title:\s*"([^"]+)"/);
  const categoryMatch = content.match(/category:\s*"([^"]+)"/);
  const categorySlugMatch = content.match(/categorySlug:\s*"([^"]+)"/);
  const imageMatch = content.match(/image:\s*"([^"]+)"/);

  if (slugMatch) fm.slug = slugMatch[1];
  if (titleMatch) fm.title = titleMatch[1];
  if (categoryMatch) fm.category = categoryMatch[1];
  if (categorySlugMatch) fm.categorySlug = categorySlugMatch[1];
  if (imageMatch) fm.image = imageMatch[1];

  return fm;
}

async function main() {
  console.log('Refreshing related articles...\n');

  const files = fs.readdirSync(pagesDir).filter(f =>
    f.endsWith('.astro') && !excludeFiles.includes(f) && !f.startsWith('[')
  );

  const articles = [];
  for (const file of files) {
    const filePath = path.join(pagesDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);
    if (fm.slug && fm.categorySlug) {
      articles.push({ file, filePath, ...fm });
    }
  }

  console.log(`Found ${articles.length} articles.`);
  console.log('Done! (SimilarArticles component handles related articles dynamically)');
}

main().catch(console.error);
