#!/usr/bin/env node

/**
 * Generate WordPress-style sitemaps
 * Creates:
 * - sitemap_index.xml (main index with XSL)
 * - post-sitemap.xml, post-sitemap2.xml, ... (articles with images, max 200 per file)
 * - category-sitemap.xml (category pages)
 * - sitemap.xsl (stylesheet)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const MAX_URLS_PER_SITEMAP = 200;

// Read site config from keywords.json
const keywordsPath = path.join(ROOT_DIR, 'keywords.json');
const keywordsData = JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));

// Auto-detect site URL from astro.config.mjs
function getSiteUrl() {
  const configPath = path.join(ROOT_DIR, 'astro.config.mjs');
  const config = fs.readFileSync(configPath, 'utf-8');
  const match = config.match(/site:\s*['"]([^'"]+)['"]/);
  return match ? match[1] : 'https://example.com';
}

const SITE_URL = getSiteUrl();
const SITE_NAME = new URL(SITE_URL).hostname.replace(/^www\./, '');
const now = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');

// Get categories from keywords.json or extract from completed articles
function getCategories() {
  if (keywordsData.categories && keywordsData.categories.length > 0) {
    return keywordsData.categories;
  }
  // Fallback: extract unique categories from completed articles
  const seen = new Set();
  const cats = [];
  for (const article of (keywordsData.completed || [])) {
    if (article.categorySlug && !seen.has(article.categorySlug)) {
      seen.add(article.categorySlug);
      cats.push({ name: article.category || article.categorySlug, slug: article.categorySlug });
    }
  }
  return cats;
}

// Read date from .astro frontmatter as fallback
function getDateFromAstro(slug) {
  const astroFile = path.join(ROOT_DIR, 'src', 'pages', `${slug}.astro`);
  try {
    if (!fs.existsSync(astroFile)) return null;
    const content = fs.readFileSync(astroFile, 'utf-8');
    // Try publishDate, modifiedDate, or date
    const match = content.match(/(?:publishDate|modifiedDate|date):\s*["']([^"']+)["']/);
    return match ? match[1] : null;
  } catch { return null; }
}

// Get completed articles sorted by date descending (newest first)
function getArticles() {
  const articles = keywordsData.completed || [];
  // Fill in missing dates from .astro frontmatter
  for (const article of articles) {
    if (!article.date && !article.modifiedDate) {
      const slug = article.slug || slugify(article.keyword);
      const astroDate = getDateFromAstro(slug);
      if (astroDate) article.date = astroDate;
    }
  }
  articles.sort((a, b) => {
    const dateA = new Date(a.modifiedDate || a.date || 0).getTime();
    const dateB = new Date(b.modifiedDate || b.date || 0).getTime();
    return dateB - dateA;
  });
  return articles;
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[ăâ]/g, 'a').replace(/[îï]/g, 'i')
    .replace(/[șş]/g, 's').replace(/[țţ]/g, 't')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function formatDate(dateStr) {
  if (!dateStr) return now;
  return new Date(dateStr).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

// Generate post sitemaps (paginated at 200)
function generatePostSitemaps() {
  const articles = getArticles();
  const chunks = [];
  for (let i = 0; i < articles.length; i += MAX_URLS_PER_SITEMAP) {
    chunks.push(articles.slice(i, i + MAX_URLS_PER_SITEMAP));
  }
  if (chunks.length === 0) chunks.push([]);

  const filenames = [];

  chunks.forEach((chunk, idx) => {
    let urlEntries = '';
    for (const article of chunk) {
      const slug = article.slug || slugify(article.keyword);
      const imageFile = path.join(DIST_DIR, 'images', 'articles', `${slug}.webp`);
      const hasImage = fs.existsSync(imageFile);

      urlEntries += `
	<url>
		<loc>${SITE_URL}/${slug}/</loc>
		<lastmod>${formatDate(article.modifiedDate || article.date)}</lastmod>${hasImage ? `
		<image:image>
			<image:loc>${SITE_URL}/images/articles/${slug}.webp</image:loc>
		</image:image>` : ''}
	</url>`;
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${urlEntries}
</urlset>`;

    const filename = idx === 0 ? 'post-sitemap.xml' : `post-sitemap${idx + 1}.xml`;
    fs.writeFileSync(path.join(DIST_DIR, filename), xml);
    console.log(`Created: ${filename} (${chunk.length} articles)`);
    filenames.push(filename);
  });

  return filenames;
}

// Generate category sitemap
function generateCategorySitemap() {
  const categories = getCategories();
  let urlEntries = '';

  for (const cat of categories) {
    urlEntries += `
	<url>
		<loc>${SITE_URL}/${cat.slug}/</loc>
		<lastmod>${now}</lastmod>
	</url>`;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urlEntries}
</urlset>`;

  fs.writeFileSync(path.join(DIST_DIR, 'category-sitemap.xml'), xml);
  console.log(`Created: category-sitemap.xml (${categories.length} categories)`);
}

// Generate sitemap index
function generateSitemapIndex(postFilenames) {
  const articles = getArticles();
  const latestDate = articles.length > 0
    ? formatDate(articles[0].modifiedDate || articles[0].date)
    : now;

  let sitemapEntries = '';
  for (const filename of postFilenames) {
    sitemapEntries += `
	<sitemap>
		<loc>${SITE_URL}/${filename}</loc>
		<lastmod>${latestDate}</lastmod>
	</sitemap>`;
  }
  sitemapEntries += `
	<sitemap>
		<loc>${SITE_URL}/category-sitemap.xml</loc>
		<lastmod>${latestDate}</lastmod>
	</sitemap>`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemapEntries}
</sitemapindex>`;

  fs.writeFileSync(path.join(DIST_DIR, 'sitemap_index.xml'), xml);
  console.log('Created: sitemap_index.xml');
}

// Generate XSL stylesheet
function generateSitemapXsl() {
  const capitalizedName = SITE_NAME.charAt(0).toUpperCase() + SITE_NAME.slice(1);
  const xsl = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="2.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:sitemap="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
<xsl:output method="html" version="1.0" encoding="UTF-8" indent="yes"/>
<xsl:template match="/">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>XML Sitemap - ${capitalizedName}</title>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
  <style type="text/css">
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #333; max-width: 1200px; margin: 0 auto; padding: 20px; }
    h1 { color: #1a1a1a; border-bottom: 3px solid #4f46e5; padding-bottom: 10px; }
    table { border-collapse: collapse; width: 100%; margin-top: 20px; }
    th, td { text-align: left; padding: 12px; border-bottom: 1px solid #e5e7eb; }
    th { background: #f3f4f6; font-weight: 600; }
    tr:hover { background: #f9fafb; }
    a { color: #4f46e5; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .count { background: #4f46e5; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>XML Sitemap</h1>
  <xsl:choose>
    <xsl:when test="sitemap:sitemapindex">
      <p>Acest sitemap index contine <span class="count"><xsl:value-of select="count(sitemap:sitemapindex/sitemap:sitemap)"/></span> sitemap-uri.</p>
      <table>
        <tr><th>Sitemap</th><th>Ultima Modificare</th></tr>
        <xsl:for-each select="sitemap:sitemapindex/sitemap:sitemap">
          <tr>
            <td><a href="{sitemap:loc}"><xsl:value-of select="sitemap:loc"/></a></td>
            <td><xsl:value-of select="substring(sitemap:lastmod, 1, 10)"/></td>
          </tr>
        </xsl:for-each>
      </table>
    </xsl:when>
    <xsl:otherwise>
      <p>Acest sitemap contine <span class="count"><xsl:value-of select="count(sitemap:urlset/sitemap:url)"/></span> URL-uri.</p>
      <table>
        <tr><th>URL</th><th>Imagini</th><th>Ultima Modificare</th></tr>
        <xsl:for-each select="sitemap:urlset/sitemap:url">
          <tr>
            <td><a href="{sitemap:loc}"><xsl:value-of select="sitemap:loc"/></a></td>
            <td><xsl:value-of select="count(image:image)"/></td>
            <td><xsl:value-of select="substring(sitemap:lastmod, 1, 10)"/></td>
          </tr>
        </xsl:for-each>
      </table>
    </xsl:otherwise>
  </xsl:choose>
</body>
</html>
</xsl:template>
</xsl:stylesheet>`;

  fs.writeFileSync(path.join(DIST_DIR, 'sitemap.xsl'), xsl);
  console.log('Created: sitemap.xsl (stylesheet)');
}

// Main
function main() {
  console.log('Generating WordPress-style sitemaps...\n');

  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }

  const postFilenames = generatePostSitemaps();
  generateCategorySitemap();
  generateSitemapIndex(postFilenames);
  generateSitemapXsl();

  console.log('\nDone! Sitemaps generated successfully.');
}

main();
