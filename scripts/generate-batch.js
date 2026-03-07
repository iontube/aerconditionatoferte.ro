#!/usr/bin/env node

/**
 * Generate a batch of articles from temp-articles.json
 */

import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectDir = path.join(__dirname, '..');

// Load .env for standalone usage
import { readFileSync, existsSync } from 'fs';
try {
  const envContent = readFileSync(path.join(projectDir, '.env'), 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0 && !process.env[key.trim()]) {
        process.env[key.trim()] = valueParts.join('=').trim();
      }
    }
  }
} catch (e) {}

// ========== CONFIG ==========
const GEMINI_API_KEYS = [
  'AIzaSyAbRzbs0WRJMb0gcojgyJlrjqOPr3o2Cmk',
  'AIzaSyDZ2TklBMM8TU3FA6aIS8vdUc-2iMyHWaM',
  'AIzaSyBdmChQ0ARDdDAqSMSlDIit_xz5ucrWjkY',
  'AIzaSyAE57AIwobFO4byKbeoa-tVDMV5lMgcAxQ',
  'AIzaSyBskPrKeQvxit_Rmm8PG_NO0ZhMQsrktTE',
  'AIzaSyAkUcQ3YiD9cFiwNh8pkmKVxVFxEKFJl2Q',
  'AIzaSyDnX940N-U-Sa0202-v3_TOjXf42XzoNxE',
  'AIzaSyAMl3ueRPwzT1CklxkylmTXzXkFd0A_MqI',
  'AIzaSyA82h-eIBvHWvaYLoP26zMWI_YqwT78OaI',
  'AIzaSyBRI7pd1H2EdCoBunJkteKaCDSH3vfqKUg',
  'AIzaSyA3IuLmRWyTtygsRJYyzHHvSiTPii-4Dbk',
  'AIzaSyB6RHadv3m1WWTFKb_rB9ev_r4r2fM9fNU',
  'AIzaSyCexyfNhzT2py3FLo3sXftqKh0KUdAT--A',
  'AIzaSyC_SN_RdQ2iXzgpqng5Byr-GU5KC5npiAE',
  'AIzaSyBOV9a_TmVAayjpWemkQNGtcEf_QuiXMG0',
  'AIzaSyCFOafntdykM82jJ8ILUqY2l97gdOmwiGg',
  'AIzaSyACxFhgs3tzeeI5cFzrlKmO2jW0l8poPN4',
  'AIzaSyBhZXBhPJCv9x8jKQljZCS4b5bwF3Ip3pk',
  'AIzaSyDF7_-_lXcAKF81SYpcD-NiA5At4Bi8tp8',
  'AIzaSyAwinD7oQiQnXeB2I5kyQsq_hEyJGhSrNg',
];

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

let currentKeyIndex = 0;
let currentAuthorIndex = 0;

const AUTHORS = [
  'Andrei Petrescu',
  'Elena Voicu',
  'Mihai Stanescu',
  'Cristina Lazar',
  'Adrian Ionita',
  'Laura Nistor'
];

function getNextApiKey() {
  const key = GEMINI_API_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
  return key;
}

function getNextAuthor() {
  const author = AUTHORS[currentAuthorIndex];
  currentAuthorIndex = (currentAuthorIndex + 1) % AUTHORS.length;
  return author;
}

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Escape quotes for safe use in templates
function escapeForTemplate(str) {
  return str
    .replace(/"/g, '') // Remove double quotes
    .replace(/"/g, '') // Remove smart quotes
    .replace(/"/g, '') // Remove smart quotes
    .replace(/„/g, '') // Remove Romanian quotes
    .replace(/'/g, "'") // Normalize single quotes
    .trim();
}

function stripStrong(str) {
  return str.replace(/<\/?strong>/g, '');
}

function stripFakeLinks(html, pagesDir) {
  return html.replace(/<a\s+href="\/([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (match, linkPath, text) => {
    const slug = linkPath.replace(/\/$/, '');
    if (existsSync(path.join(pagesDir, `${slug}.astro`))) return match;
    if (existsSync(path.join(pagesDir, slug))) return match;
    return text;
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== TRANSLATE TO ENGLISH ==========
async function translateToEnglish(text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const apiKey = getNextApiKey();
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Translate the following Romanian text to English. Return ONLY the English translation, nothing else:\n\n${text}` }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 200 }
        })
      });
      const data = await response.json();
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text.trim();
      }
      console.error(`  Translation attempt ${attempt + 1} failed: no candidates`);
    } catch (error) {
      console.error(`  Translation attempt ${attempt + 1} error: ${error.message}`);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
  }
  return text;
}

// ========== GENERATE IMAGE ==========

// Strip brand names from image prompt to avoid Cloudflare AI content filter
function stripBrands(text) {
  return text
    .replace(/\b[A-Z][a-z]+[A-Z]\w*/g, '')  // camelCase brands: HyperX, PlayStation
    .replace(/\b[A-Z]{2,}\b/g, '')            // ALL CAPS: ASUS, RGB, LED
    .replace(/\s{2,}/g, ' ')                   // collapse double spaces
    .trim();
}

// Use Gemini to rephrase a title into a generic description without brand names
async function rephraseWithoutBrands(text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const apiKey = getNextApiKey();
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Rephrase the following into a short, generic English description for an image prompt. Remove ALL brand names, trademarks, product names, and game names. Replace them with generic descriptions of what they are. Return ONLY the rephrased text, nothing else.\n\nExample: "Boggle classic word game" -> "classic letter dice word game on a table"\nExample: "Kindle Paperwhite review" -> "slim e-reader device with paper-like screen"\nExample: "Duolingo app for learning languages" -> "colorful language learning mobile app interface"\n\nText: "${text}"` }] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 100 }
        })
      });
      const data = await response.json();
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        const result = data.candidates[0].content.parts[0].text.trim();
        console.log(`  Rephrased prompt (no brands): ${result}`);
        return result;
      }
    } catch (error) {
      console.error(`  Rephrase attempt ${attempt + 1} error: ${error.message}`);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
  }
  // Fallback to basic stripBrands
  return stripBrands(text);
}

// Use Gemini to create a maximally safe image prompt, avoiding people/brands entirely
async function generateSafePrompt(text, categorySlug) {
  const categoryFallbacks = {
    'aparate-aer-conditionat': 'a modern white air conditioning unit mounted on a clean wall in a bright contemporary room',
    'instalare-montaj': 'air conditioning installation tools and copper pipes arranged on a clean surface',
    'intretinere-curatare': 'clean air conditioning filter and maintenance spray on a white background',
    'eficienta-energetica': 'modern energy-efficient air conditioning unit with digital display showing temperature',
    'ghiduri-sfaturi': 'sleek air conditioning unit in a stylish modern living room with comfortable furniture',
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const apiKey = getNextApiKey();
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Create a short, safe English image prompt for a stock photo related to this topic. The prompt must describe ONLY objects, scenery, and atmosphere. NEVER mention people, children, babies, faces, hands, or any human body parts. NEVER use brand names. Focus on products, objects, books, devices, furniture, or abstract scenes. Return ONLY the description.\n\nTopic: "${text}"` }] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 100 }
        })
      });
      const data = await response.json();
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        const result = data.candidates[0].content.parts[0].text.trim();
        console.log(`  Safe prompt generated: ${result}`);
        return result;
      }
    } catch (error) {
      console.error(`  Safe prompt attempt ${attempt + 1} error: ${error.message}`);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
  }
  // Fallback to hardcoded category description
  return categoryFallbacks[categorySlug] || 'modern technology devices and accessories arranged on a clean minimalist desk';
}

async function generateImage(imagePrompt, slug, categorySlug) {
  const categoryPrompts = {
    'aparate-aer-conditionat': 'mounted on white wall in a bright modern room, clean contemporary interior, soft natural lighting',
    'instalare-montaj': 'in a professional installation setting, clean modern room, bright ambient lighting',
    'intretinere-curatare': 'in a clean bright room, maintenance context, soft natural daylight',
    'eficienta-energetica': 'in an energy-efficient modern home, contemporary minimalist design, warm ambient lighting',
    'ghiduri-sfaturi': 'in a stylish modern living room, comfortable interior design, soft natural lighting',
  };

  console.log(`  Generating image for: ${imagePrompt}`);

  const MAX_IMAGE_RETRIES = 4;
  let promptFlagged = false;

  for (let attempt = 1; attempt <= MAX_IMAGE_RETRIES; attempt++) {

    if (attempt > 1) {

      console.log(`  Image retry attempt ${attempt}/${MAX_IMAGE_RETRIES}...`);

      await new Promise(r => setTimeout(r, 3000 * attempt));

    }


  try {
    let prompt;
    if (attempt >= 3) {
      const safeSubject = await generateSafePrompt(imagePrompt, categorySlug);
      prompt = `Realistic photograph of ${safeSubject}, no text, no writing, no words, no letters, no numbers. Photorealistic, high quality, professional photography.`;
      console.log(`  Using safe prompt (attempt ${attempt}): ${prompt}`);
    } else {
      const titleEn = await translateToEnglish(imagePrompt);
      console.log(`  Translated title: ${titleEn}`);

      const setting = categoryPrompts[categorySlug] || 'in a modern home setting, soft natural lighting, clean contemporary background';
      const subject = promptFlagged ? await rephraseWithoutBrands(titleEn) : titleEn;
      prompt = `Realistic photograph of ${subject} ${setting}, no text, no brand name, no writing, no words, no letters, no numbers. Photorealistic, high quality, professional product photography.`;
    }

    const formData = new FormData();
    formData.append('prompt', prompt);
    formData.append('steps', '20');
    formData.append('width', '1024');
    formData.append('height', '768');

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-2-dev`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CF_API_TOKEN}`,
        },
        body: formData,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`  Image API error: ${response.status} - ${errorText.slice(0, 200)}`);
      if (errorText.includes('flagged')) promptFlagged = true;
      continue;
    }

    const data = await response.json();
    if (!data.result?.image) {
      console.error('  No image in response');
      continue;
    }

    const imageBuffer = Buffer.from(data.result.image, 'base64');
    const imagePath = await downloadAndCompressImage(imageBuffer, slug);
    return imagePath;
  } catch (error) {
    console.error(`  Image generation error: ${error.message}`);
    continue;
  }


  }

  console.error('  Image generation failed after all retries');

  return null;
}

async function downloadAndCompressImage(imageBuffer, slug) {
  const imagesDir = path.join(projectDir, 'public', 'images', 'articles');
  await fs.mkdir(imagesDir, { recursive: true });

  const imagePath = path.join(imagesDir, `${slug}.webp`);
  const publicPath = `/images/articles/${slug}.webp`;

  await sharp(imageBuffer)
    .resize(800, 600, { fit: 'cover' })
    .webp({ quality: 82, effort: 6 })
    .toFile(imagePath);

  console.log(`  Image saved: ${publicPath}`);
  return publicPath;
}

// ========== GENERATE ARTICLE CONTENT ==========
async function generateArticleContent(keyword, category, completedArticles = []) {
  
  // Build interlink list from completed articles
  const currentSlug = keyword.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const interlinkCandidates = completedArticles
    .filter(a => a.keyword !== keyword)
    .map(a => {
      const aSlug = a.keyword.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      return { title: a.keyword.charAt(0).toUpperCase() + a.keyword.slice(1), slug: aSlug, category: a.category, categorySlug: a.categorySlug };
    });
  // Prioritize same category, then others, max 15
  const sameCategory = interlinkCandidates.filter(a => a.categorySlug === completedArticles.find(c => c.keyword === keyword)?.categorySlug);
  const otherCategory = interlinkCandidates.filter(a => !sameCategory.includes(a));
  const interlinkList = [...sameCategory, ...otherCategory].slice(0, 15)
    .map(a => `- <a href="/${a.slug}/">${a.title}</a> (categorie: ${a.category})`)
    .join('\n');

const prompt = `Scrii articole pe un site romanesc despre oferte si comparatii de aparate de aer conditionat din Romania — toate brandurile: Daikin, Mitsubishi, LG, Samsung, Gree, Midea, Cooper&Hunter, Vivax, Vortex, Tesla, Whirlpool etc. Stilul e informativ, practic si directionat spre conversie. NU esti un AI.

Keyword: "${keyword}"
Categorie: "${category}"

=== TONUL SI STILUL ===

INTRO:
- Primul paragraf = raspunsul direct la intentia de cautare cu date concrete (model, pret, BTU). Fara preambul, fara "bun venit", fara "ai nimerit unde trebuie".
- Al doilea paragraf = context: pentru cine e potrivit, ce trebuie luat in calcul, alternative.
- Al treilea (optional) = ce gaseste cititorul in articol. Fara clisee.

REVIEW-URI PRODUSE:
- TON INFORMATIONAL, NU PERSONAL. NU folosi: "am testat", "am instalat", "un client mi-a zis", "din experienta mea", "am avut ocazia". Scrie la persoana a doua sau impersonal.
- Fiecare review incepe cu un paragraf introductiv despre produs, apoi 4-5 paragrafe cu intrebari retorice ca deschidere: "Ce performante ofera compresorul inverter?", "Cat de silentios e in functionare?", "Merita diferenta de pret fata de modelele mai ieftine?"
- Include specificatii concrete (capacitate BTU, clasa energetica, nivel zgomot dB, tip compresor, refrigerant, dimensiuni).
- Preturi realiste in lei, piata Romania 2026.
- Fiecare review = 5-7 paragrafe, minim 250 cuvinte. Ultimul paragraf = pentru cine e potrivit si de ce.
- Minim 4-5 avantaje si 3-4 dezavantaje per produs. Dezavantajele trebuie sa fie REALE, nu inventate.

CONVERSIE:
- Ajuta cititorul sa decida: "daca ai garsoniera, mergi pe 9000 BTU; daca ai living mare, 18000 BTU e minim"
- Fiecare produs sa aiba un paragraf final clar: pentru cine e potrivit si de ce

=== ANTI-AI SI ANTI-CLISEE (FOARTE IMPORTANT) ===
Cuvinte si expresii INTERZISE - NU le folosi NICIODATA. Daca le folosesti, articolul e RESPINS:
- Conectori AI: "Asadar", "De asemenea", "Cu toate acestea", "In plus", "Mai mult", "Prin urmare", "Totodata", "In ceea ce priveste"
- Formule de umplere: "Este important de mentionat", "Trebuie sa tinem cont", "Nu in ultimul rand", "In primul rand", "in era actuala", "merita mentionat", "este esential", "este crucial", "este important sa", "este recomandat sa"
- Adjective goale: "remarcabil", "exceptional", "revolutionar", "inovator", "de top", "extraordinar", "excelent", "superb", "impresionant", "uimitor", "deosebit", "formidabil"
- Superlative de marketing: "o alegere excelenta", "o optiune excelenta", "o solutie excelenta", "alegerea perfecta", "solutia ideala", "o propunere tentanta"
- Formulari AI tipice: "se impune ca", "se distinge prin", "se lauda cu", "contribuie la", "reprezinta o optiune", "se remarca prin", "vine echipat cu", "beneficiaza de", "dispune de", "iese in evidenta prin", "se traduce in", "se traduce prin", "promite sa", "promite un", "se bucura de", "se pozitioneaza ca", "este esential", "este esentiala", "este ideal", "este ideala"
- Construieste frazele DIRECT. In loc de "se pozitioneaza ca o solutie accesibila" scrie "costa putin si face treaba". In loc de "se traduce prin costuri mai mici" scrie "platesti mai putin la curent". In loc de "este ideal pentru" scrie "functioneaza bine in".
- Intro/Outro AI: "descopera", "vei descoperi", "vei gasi", "in concluzie", "in acest articol", "hai sa exploram", "sa aprofundam", "informatii detaliate", "informatiile necesare", "obtine toate informatiile", "vom explora", "vom analiza", "vom compara", "vom discuta", "vom raspunde", "o optiune viabila", "o optiune solida"
- Ghid/completitudine: "ghid complet", "ghid", "tot ce trebuie sa stii", "complet", "definitiv", "ultim", "suprem"
- False welcome: "ai nimerit unde trebuie", "esti in locul potrivit", "ai ajuns unde trebuie", "fara indoiala", "fara doar si poate"

INTERZIS in titluri/headings: "Ghid", "Complet", "Definitiv", "Tot ce trebuie sa stii", "Cum sa alegi", "Review", "Recenzie". Titlurile trebuie sa fie SIMPLE si DIRECTE.

INTERZIS: liste de 3 adjective consecutive, doua propozitii la rand cu acelasi cuvant, acelasi pattern de inceput de paragraf. NU incepe paragrafe cu "Acest model", "Aceasta unitate", "Acest aparat" de mai mult de 2 ori in tot articolul.

=== TAG-URI PRODUSE ===
INTERZIS: "Produs #1", "Produs #2" etc. Fiecare produs trebuie sa aiba un TAG descriptiv unic:
"Best Buy 2026", "Raport Calitate-Pret", "Premium", "Pentru Buget Mic", "Alegerea Noastra", "Cel Mai Silentios", "Eficienta Maxima", "Cel Mai Vandut", "Performanta Top"
NU folosi "Alegerea Editorului" sau "Buget Optimizat".

Tonul e informational, accesibil, scris pentru un cititor care cauta sa ia o decizie de cumparare. NU e personal (fara "eu", "am testat", "am instalat"). Scrie la persoana a doua ("te poti astepta la", "vei observa ca", "ai nevoie de") sau impersonal.
Amesteca propozitii scurte (3-5 cuvinte) cu propozitii lungi (18-22 cuvinte). Paragrafele sa varieze: 2-3 propozitii, apoi 3-4, apoi 2.
Include critici oneste si dezavantaje reale pentru fiecare produs.

=== PARAGRAFE CU INTREBARI ===
In textul review-urilor si al ghidului, pune intrebari retorice naturale ca sub-titluri sau in text:
"Dar merita pretul?" / "Cat consuma pe ora?" / "Raceste suficient dormitorul?"
Asta optimizeaza pentru AI search (Perplexity, SGE) care cauta raspunsuri la intrebari concrete.

=== STRUCTURA JSON ===
Returneaza DOAR JSON valid, fara markdown, fara \`\`\`:
{
  "intro": "2-3 paragrafe HTML (<p>). Primul paragraf INCEPE cu o intrebare directa legata de keyword (ex: 'Cautati un aer conditionat Beko 12000 BTU?') urmata imediat de raspunsul cu date concrete (model, pret, BTU). Intrebarea la inceput e importanta pentru featured snippets si AI search. Al doilea = context practic: pentru ce spatiu e potrivit, ce alternative exista. Al treilea (optional) = ce acopera articolul, scurt si direct. FARA: 'vom analiza', 'vom explora', 'vom compara', 'vei descoperi', 'informatii detaliate'. Total minim 120 cuvinte.",
  "items": [ // OBLIGATORIU 4-5 produse
    {
      "name": "Numele complet al produsului/subiectului",
      "tag": "Best Buy 2026 / Raport Calitate-Pret / Premium / Pentru Buget Mic / Alegerea Noastra / Cel Mai Silentios / Eficienta Maxima",
      "specs": {
        "capacitate": "ex: 12000 BTU / 3.5 kW",
        "clasa energetica": "ex: A++ racire / A+ incalzire",
        "nivel zgomot": "ex: 22 dB(A) interior / 52 dB(A) exterior",
        "compresor": "ex: Inverter / On-Off",
        "refrigerant": "ex: R32 / R410A",
        "dimensiuni": "ex: 805 x 285 x 194 mm (unitate interioara)"
      },
      "review": "HTML (<p>, <strong>, <ul>/<li>) cu review-ul detaliat. Minim 250 cuvinte per produs. Include experienta de utilizare, performanta reala, comparatie cu alternative. Paragrafele scurte, max 3-4 propozitii.",
      "pros": ["avantaj 1", "avantaj 2", "avantaj 3", "avantaj 4", "avantaj 5"],
      "cons": ["dezavantaj real 1", "dezavantaj real 2", "dezavantaj real 3", "dezavantaj real 4"]
    }
  ],
  "comparison": {
    "heading": "Titlu simplu si direct cu keyword (FARA cuvantul 'comparatie', 'ghid', 'complet')",
    "rows": [
      {"model":"...", "capacitate":"...", "clasa energetica":"...", "zgomot":"...", "pret":"...", "potrivit pentru":"..."}
    ]
  },
  "guide": {
    "heading": "Titlu simplu si direct cu keyword (FARA 'ghid', 'complet', 'tot ce trebuie sa stii')",
    "content": "HTML (<p>, <h4>, <ul>/<li>) cu sfaturi practice: criterii, greseli de evitat. Minim 400 cuvinte. h4-urile sa fie intrebari directe."
  },
  "faq": [
    {
      "question": "Intrebare EXACT cum ar tasta-o un roman in Google",
      "answer": "Prima propozitie = raspuns direct. Apoi 1-2 propozitii cu detalii si cifre. Total 40-70 cuvinte."
    }
  ]
}

=== CERINTE PRODUSE (FOARTE IMPORTANT) ===
- Include OBLIGATORIU 4-5 produse in "items". Nu mai putin de 4, nu mai mult de 5.
- Foloseste NUMAI modele de aer conditionat care EXISTA pe piata din Romania. NU inventa coduri de model, nume sau serii fictive.
- Foloseste modele REALE de la branduri vandute in Romania: Daikin, Mitsubishi Electric, LG, Samsung, Gree, Midea, Cooper&Hunter, Vivax, Vortex, Tesla, Whirlpool, Beko, Toshiba, Haier, Panasonic.
- Amesteca branduri diferite in fiecare articol — nu doar un singur brand.
- Include modele din categorii de pret diferite: buget, mid-range, premium.
- NU INVENTA: coduri de model (gen "BKH 3.5kW"), serii (gen "Serie Noua"), sau nume generice. Daca nu esti sigur de un model, NU il include.
- Specificatii REALE: capacitate BTU, clasa energetica, nivel zgomot, tip compresor, refrigerant
- Preturi in lei, realiste pentru Romania 2026
- Pros/cons oneste - fiecare model minim 2 cons-uri reale
- Review HTML cu paragrafe scurte, intrebari retorice, limbaj conversational

=== CERINTE FAQ ===
- 5 intrebari naturale, formulari de cautare Google reale
- Raspunsuri cu structura featured snippet: raspuns direct + detalii cu cifre
- Acoperiti: pret, comparatie, consum, alegere, probleme frecvente

=== REGULI ===
- IMPORTANT: Articolul complet trebuie sa aiba MINIM 1500 cuvinte. Intro ~120, fiecare review ~200 (x4-5 = 800-1000), guide ~400, FAQ ~200.
- Scrie FARA diacritice (fara a, i, s, t, a - foloseste a, i, s, t, a)
- Preturile in LEI, realiste piata Romania 2026
- Keyword-ul "${keyword}" in <strong> de 4-6 ori in tot articolul, doar in <p>, NU in headings/FAQ
- NICIODATA <strong> in titluri, intrebari FAQ, sau cuprins

=== REMINDER FINAL (CITESTE ASTA INAINTE SA SCRII) ===
Verifica FIECARE propozitie inainte sa o scrii. Daca contine oricare din aceste cuvinte/expresii, RESCRIE propozitia:
"de asemenea", "in plus", "prin urmare", "totodata", "contribuie", "beneficiaza", "dispune de", "se traduce", "se pozitioneaza", "se distinge", "se impune", "se remarca", "promite", "vine echipat", "este crucial", "este esential".
RESCRIE folosind limbaj direct: subiect + verb simplu + obiect. Exemplu: "Aparatul are Wi-Fi" NU "Aparatul beneficiaza de conectivitate Wi-Fi".

${interlinkList.length > 0 ? `
=== INTERLINK-URI INTERNE (SEO) ===
Mentioneaza NATURAL in text 2-4 articole de pe site, cu link-uri <a href="/{slug}/">{titlu}</a>.
Integreaza in propozitii, NU ca lista separata. Max 4 link-uri. Doar unde are sens contextual.
NU forta link-uri daca nu au legatura cu subiectul. Mai bine 0 link-uri decat link-uri fortate.

Articole disponibile:
${interlinkList}` : ''}`;

  for (let attempt = 0; attempt < 10; attempt++) {
    const apiKey = getNextApiKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
    try {
      console.log(`  Generating content (attempt ${attempt + 1}, key ${(currentKeyIndex % GEMINI_API_KEYS.length) + 1})...`);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 40000, responseMimeType: "application/json" }
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.log(`  API error (${response.status}): ${errText.substring(0, 200)}`);
        await delay(3000);
        continue;
      }

      const data = await response.json();
      let text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) {
        console.log('  Empty response, trying next key...');
        await delay(2000);
        continue;
      }

      text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      // Extract JSON object if there's extra text
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        text = jsonMatch[0];
      }
      const content = JSON.parse(text);

      if (!content.intro || !content.items || !content.faq) {
        console.log('  Invalid structure, retrying...');
        await delay(2000);
        continue;
      }

      // Post-processing: strip AI clichés that Gemini ignores
      const stripCliches = (html) => {
        if (!html) return html;
        return html
          // Remove filler connectors
          .replace(/\bDe asemenea,?\s*/gi, '')
          .replace(/\bIn plus,?\s*/gi, '')
          .replace(/\bPrin urmare,?\s*/gi, '')
          .replace(/\bTotodata,?\s*/gi, '')
          .replace(/\bAsadar,?\s*/gi, '')
          .replace(/\bCu toate acestea,?\s*/gi, '')
          .replace(/\bNu in ultimul rand,?\s*/gi, '')
          .replace(/\bIn concluzie,?\s*/gi, '')
          // Replace AI verb constructions with direct alternatives
          .replace(/\bbeneficiaza de\b/gi, 'are')
          .replace(/\bdispune de\b/gi, 'are')
          .replace(/\bcontribuie la\b/gi, 'ajuta la')
          .replace(/\bse traduce prin\b/gi, 'inseamna')
          .replace(/\bse traduce in\b/gi, 'inseamna')
          .replace(/\bse pozitioneaza ca\b/gi, 'este')
          .replace(/\bse distinge prin\b/gi, 'are')
          .replace(/\bse impune ca\b/gi, 'este')
          .replace(/\bse remarca prin\b/gi, 'are')
          .replace(/\bvine echipat cu\b/gi, 'are')
          .replace(/\beste esential(a)?\b/gi, 'conteaza')
          .replace(/\beste crucial(a)?\b/gi, 'conteaza')
          .replace(/\bremarcabil(a|e)?\b/gi, 'bun')
          .replace(/\bexceptional(a|e)?\b/gi, 'foarte bun')
          .replace(/\bo optiune viabila\b/gi, 'o varianta')
          .replace(/\bo optiune solida\b/gi, 'o varianta buna')
          .replace(/\bo optiune excelenta\b/gi, 'o varianta buna')
          .replace(/\bo solutie (eficienta|buna|excelenta)\b/gi, 'o varianta buna')
          .replace(/\bse plaseaza ca\b/gi, 'este')
          .replace(/\bpromitand\b/gi, 'cu')
          .replace(/\beste proiectat(a)? sa\b/gi, 'poate')
          .replace(/\bcontribuie semnificativ\b/gi, 'ajuta')
          .replace(/\bun accent puternic pe\b/gi, 'accent pe')
          .replace(/\beste o caracteristica esentiala\b/gi, 'conteaza')
          .replace(/\bEste proiectata?\b/gi, 'Poate')
          .replace(/\bse adreseaza celor care\b/gi, 'e pentru cei care')
          .replace(/\bse adreseaza\b/gi, 'e pentru');
      };
      content.intro = stripCliches(content.intro);
      content.items = content.items.map(item => ({
        ...item,
        review: stripCliches(item.review)
      }));
      if (content.guide) {
        content.guide.content = stripCliches(content.guide.content);
      }

      // Post-processing: bold keyword in HTML paragraphs (max 5 times)
      const kwEscaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const kwRegex = new RegExp(`(${kwEscaped})`, 'gi');
      let boldCount = 0;
      const boldInHtml = (html) => {
        if (!html) return html;
        // Only bold inside <p> tags, skip if already in <strong>
        return html.replace(/<p[^>]*>[\s\S]*?<\/p>/gi, (pTag) => {
          return pTag.replace(kwRegex, (match) => {
            if (boldCount >= 5) return match;
            // Check if already wrapped in strong
            const before = pTag.substring(0, pTag.indexOf(match));
            if (before.lastIndexOf('<strong>') > before.lastIndexOf('</strong>')) return match;
            boldCount++;
            return `<strong>${match}</strong>`;
          });
        });
      };
      content.intro = boldInHtml(content.intro);
      content.items = content.items.map(item => ({
        ...item,
        review: boldInHtml(item.review)
      }));
      if (content.guide) {
        content.guide.content = boldInHtml(content.guide.content);
      }

      return content;
    } catch (error) {
      console.log(`  Error: ${error.message}, trying next key...`);
      await delay(2000);
    }
  }
  throw new Error(`Failed to generate content for: ${keyword}`);
}

// ========== CREATE ASTRO FILE ==========
async function createAstroFile(article, content, imagePath) {
  // Capitalize first letter of each word for proper title
  const simpleTitle = article.keyword
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
  const slug = slugify(article.keyword);
  const publishDate = new Date().toISOString();
  const author = getNextAuthor();

  // Extract excerpt from intro HTML - first <p> content, stripped of tags
  const introHtml = content.intro || '';
  const firstPMatch = introHtml.match(/<p>([\s\S]*?)<\/p>/);
  const rawExcerpt = firstPMatch ? firstPMatch[1] : introHtml.substring(0, 160);
  const cleanExcerpt = rawExcerpt.replace(/<[^>]*>/g, '');
  const excerpt = escapeForTemplate(cleanExcerpt);

  // Build TOC from items + comparison + guide + FAQ
  const tocEntries = [];
  content.items.forEach((item) => {
    const productId = slugify(stripStrong(item.name));
    tocEntries.push({ id: productId, title: stripStrong(item.name) });
  });
  if (content.comparison) {
    tocEntries.push({ id: 'comparatie', title: stripStrong(content.comparison.heading) });
  }
  if (content.guide) {
    tocEntries.push({ id: 'ghid', title: stripStrong(content.guide.heading) });
  }
  tocEntries.push({ id: 'faq', title: 'Intrebari frecvente' });

  const tocLinks = tocEntries.map(item =>
    `<a href="#${item.id}" class="block text-sm text-slate-600 hover:text-primary-600 transition-colors py-1">${item.title}</a>`
  ).join('\n                ');

  // Build items HTML
  let itemsHtml = '';
  content.items.forEach((item, i) => {
    let reviewContent = (item.review || '').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Ensure review content is wrapped in <p> tags
    if (!reviewContent.includes('<p>')) {
      reviewContent = reviewContent.split(/\n\n+/).map(p => p.trim()).filter(p => p)
        .map(p => p.match(/^<(?:ul|ol|h[1-6]|table|blockquote|div)/i) ? p : `<p>${p}</p>`).join('\n          ');
    }

    const specsChips = Object.entries(item.specs || {}).map(([key, val]) =>
      `<span data-spec><strong>${key}:</strong> ${val}</span>`
    ).join('\n              ');

    const prosHtml = (item.pros || []).map(p => `<li>${p}</li>`).join('\n                  ');
    const consHtml = (item.cons || []).map(c => `<li>${c}</li>`).join('\n                  ');

    const productId = slugify(stripStrong(item.name));
    const productTag = item.tag || `Produs ${i + 1}`;

    itemsHtml += `
          <article id="${productId}" data-review>
            <div data-review-bar>
              <h3>${stripStrong(item.name)}</h3>
              <span data-review-tag>${stripStrong(productTag)}</span>
            </div>
            <div data-specs>
              ${specsChips}
            </div>
            <div data-review-body>
              ${reviewContent}
            </div>
            <div data-pcwrap>
              <div>
                <h4 style="font-size:.85rem;margin-bottom:8px;color:var(--c-navy)">Avantaje</h4>
                <ul data-pros>
                ${prosHtml}
                </ul>
              </div>
              <div>
                <h4 style="font-size:.85rem;margin-bottom:8px;color:var(--c-navy)">Dezavantaje</h4>
                <ul data-cons>
                ${consHtml}
                </ul>
              </div>
            </div>
          </article>`;
  });

  // Build comparison table HTML
  let comparisonHtml = '';
  if (content.comparison && content.comparison.rows && content.comparison.rows.length > 0) {
    // Dynamic column headers from row keys
    const colKeys = Object.keys(content.comparison.rows[0]);
    const thCells = colKeys.map(k => `<th>${k.charAt(0).toUpperCase() + k.slice(1)}</th>`).join('');
    const rowsHtml = content.comparison.rows.map(row =>
      `<tr>${colKeys.map(k => `<td>${row[k] || ''}</td>`).join('')}</tr>`
    ).join('\n              ');

    comparisonHtml = `
          <section id="comparatie">
            <h2>${stripStrong(content.comparison.heading)}</h2>
            <div data-comparison>
              <table>
                <thead><tr>${thCells}</tr></thead>
                <tbody>
              ${rowsHtml}
                </tbody>
              </table>
            </div>
          </section>`;
  }

  // Build guide HTML
  let guideHtml = '';
  if (content.guide) {
    let guideContent = (content.guide.content || '').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    if (!guideContent.includes('<p>')) {
      guideContent = guideContent.split(/\n\n+/).map(p => p.trim()).filter(p => p)
        .map(p => p.match(/^<(?:ul|ol|h[1-6]|table|blockquote|div)/i) ? p : `<p>${p}</p>`).join('\n            ');
    }
    guideHtml = `
          <section id="ghid">
            <h2>${stripStrong(content.guide.heading)}</h2>
            <div data-guide>
              ${guideContent}
            </div>
          </section>`;
  }

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": content.faq.map(item => ({
      "@type": "Question",
      "name": stripStrong(item.question),
      "acceptedAnswer": {
        "@type": "Answer",
        "text": stripStrong(item.answer)
      }
    }))
  };

  let astroContent = `---
export const frontmatter = {
  title: "${simpleTitle.replace(/"/g, '\\"')}",
  slug: "${slug}",
  category: "${article.category}",
  categorySlug: "${article.categorySlug}",
  excerpt: "${excerpt.replace(/"/g, '\\"')}",
  image: "${imagePath || '/images/placeholder.webp'}",
  publishDate: "${publishDate}",
  modifiedDate: "${publishDate}",
  author: "${author}"
};

import Layout from '../layouts/Layout.astro';
import PrevNextNav from '../components/PrevNextNav.astro';
import SimilarArticles from '../components/SimilarArticles.astro';
import keywordsData from '../../keywords.json';

const allArticles = (keywordsData.completed || []).map(item => ({
  title: item.keyword.charAt(0).toUpperCase() + item.keyword.slice(1),
  slug: item.keyword.toLowerCase()
    .normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
  category: item.category,
  categorySlug: item.categorySlug,
  excerpt: item.excerpt || '',
  image: \`/images/articles/\${item.keyword.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.webp\`,
  date: item.date || new Date().toISOString()
}));
---

<Layout
  title={\`\${frontmatter.title} | AerConditionatOferte.ro\`}
  description={frontmatter.excerpt}
  canonical={\`/\${frontmatter.slug}/\`}
  type="article"
  image={frontmatter.image}
  author={frontmatter.author}
  publishedTime={frontmatter.publishDate}
  modifiedTime={frontmatter.modifiedDate}
  faqSchema={${JSON.stringify(faqSchema, null, 2).split('\n').join('\n  ')}}
  breadcrumbs={[
    { name: "Acasa", url: "/" },
    { name: "${escapeForTemplate(article.category)}", url: "/${article.categorySlug}/" },
    { name: "${escapeForTemplate(simpleTitle)}", url: "/${slug}/" }
  ]}
>
  <article>
    <header data-article-hdr>
      <div data-shell>
        <div data-article-hdr-inner>
          <nav data-breadcrumb>
            <a href="/">Acasa</a>
            <span>/</span>
            <a href={\`/\${frontmatter.categorySlug}/\`}>{frontmatter.category}</a>
            <span>/</span>
            <span>{frontmatter.title}</span>
          </nav>
          <h1>{frontmatter.title}</h1>
          <div data-article-meta>
            <span>{frontmatter.author}</span>
            <span>&bull;</span>
            <time datetime={frontmatter.publishDate}>{new Date(frontmatter.publishDate).toLocaleDateString('ro-RO', { year: 'numeric', month: 'long', day: 'numeric' })}</time>
          </div>
        </div>
      </div>
    </header>

    <div data-shell>
      <div data-article-body>
        <div data-content>
        ${imagePath ? `<img src="${imagePath}" alt="${simpleTitle}" data-entry-img width="800" height="600" loading="eager" decoding="async" style="width:100%;height:auto;border-radius:12px;margin-bottom:24px;" />` : ''}

        <div data-toc-mobile id="mobileOutline">
          <button onclick="document.getElementById('mobileOutline').classList.toggle('is-open')">
            <span>Cuprins</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <ul>
            ${tocEntries.map(item => `<li><a href="#${item.id}">${item.title}</a></li>`).join('\n            ')}
          </ul>
        </div>

        <section id="intro">
          ${introHtml}
        </section>

          <h2>${simpleTitle}</h2>
          ${itemsHtml}

          ${comparisonHtml}

          ${guideHtml}

          <div data-faq>
            <h2>Intrebari frecvente</h2>
              ${content.faq.map(item => `
              <div data-faq-item>
                <button data-faq-q onclick="this.parentElement.classList.toggle('is-open')">
                  ${stripStrong(item.question)}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                </button>
                <div data-faq-a>
                  ${stripStrong(item.answer)}
                </div>
              </div>`).join('\n              ')}
          </div>

          <PrevNextNav currentSlug="${slug}" />

        </div>
      </div>
    </div>

    <SimilarArticles
      currentSlug="${slug}"
      category="${article.category}"
      categorySlug="${article.categorySlug}"
    />
  </article>

  <script>
    // Table scroll detection
    (function() {
      const outer = document.querySelector('[data-table-wrap]');
      if (!outer) return;
      const scroll = outer.querySelector('[data-table-scroll]');
      function check() {
        if (scroll.scrollWidth > scroll.clientWidth) {
          outer.classList.add('can-scroll');
        } else {
          outer.classList.remove('can-scroll');
        }
        if (scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 2) {
          outer.classList.remove('can-scroll');
        }
      }
      check();
      scroll.addEventListener('scroll', check);
      window.addEventListener('resize', check);
    })();

    // Outline tracking
    (function() {
      const links = document.querySelectorAll('#sideOutline a, #mobileOutline a');
      const secs = [];
      links.forEach(link => {
        const id = link.getAttribute('href')?.replace('#', '');
        const el = id && document.getElementById(id);
        if (el) secs.push({ el, link });
      });
      if (!secs.length) return;
      const obs = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          const m = secs.find(s => s.el === entry.target);
          if (m && entry.isIntersecting) {
            links.forEach(l => l.parentElement?.classList.remove('is-active'));
            m.link.parentElement?.classList.add('is-active');
            links.forEach(l => {
              if (l !== m.link && l.getAttribute('href') === m.link.getAttribute('href')) {
                l.parentElement?.classList.add('is-active');
              }
            });
          }
        });
      }, { rootMargin: '-72px 0px -60% 0px' });
      secs.forEach(s => obs.observe(s.el));
    })();
  </script>
</Layout>
`;

  const filePath = path.join(projectDir, 'src', 'pages', `${slug}.astro`);
  astroContent = stripFakeLinks(astroContent, path.join(projectDir, 'src', 'pages'));
  await fs.writeFile(filePath, astroContent, 'utf-8');
  console.log(`  Article saved: ${slug}.astro`);

  return { slug, excerpt };
}

// ========== MAIN ==========
async function main() {
  console.log('='.repeat(60));
  console.log('BATCH ARTICLE GENERATION');
  console.log('='.repeat(60));

  // Load keywords data for interlinking
  const keywordsPath = path.join(projectDir, 'keywords.json');
  let keywordsData = { completed: [] };
  try {
    const kwContent = await fs.readFile(keywordsPath, 'utf-8');
    keywordsData = JSON.parse(kwContent);
  } catch (e) {
    console.log('No keywords.json found, starting without interlinks');
  }

  // Read articles to generate
  const configPath = path.join(__dirname, 'temp-articles.json');
  let articles;
  try {
    const configContent = await fs.readFile(configPath, 'utf-8');
    articles = JSON.parse(configContent);
  } catch (error) {
    console.error('Could not read temp-articles.json:', error.message);
    process.exit(1);
  }

  console.log(`Articles to generate: ${articles.length}`);

  const successfulKeywords = [];

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    console.log(`\n[${i + 1}/${articles.length}] ${article.keyword}`);
    console.log('-'.repeat(50));

    let retries = 3;
    let success = false;
    while (retries > 0) {
      try {
        console.log('  Generating content...');
        const generatedContent = await generateArticleContent(article.keyword, article.category, keywordsData?.completed || []);

        await delay(1000);

        // Skip image generation in dev mode (use Cloudflare Workers AI in production)
        const skipImage = !process.env.CF_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN || process.env.SKIP_IMAGE === '1';
        let imagePath = null;
        if (!skipImage) {
          imagePath = await generateImage(article.imagePrompt || article.keyword, slugify(article.keyword), article.categorySlug);
          await delay(1000);
        } else {
          console.log('  Skipping image generation (dev mode)');
        }

        const articleData = await createAstroFile(article, generatedContent, imagePath);

        console.log('  SUCCESS!');
        success = true;
        successfulKeywords.push(article.keyword);
        break;

      } catch (error) {
        retries--;
        if (retries > 0) {
          const isRateLimit = error.message.includes('429');
          const waitTime = isRateLimit ? 60000 : 5000;
          console.log(`  Retry ${3 - retries}/3 - waiting ${waitTime/1000}s...`);
          await delay(waitTime);
        } else {
          console.error(`  FAILED: ${error.message}`);
        }
      }
    }

    if (i < articles.length - 1) {
      console.log('  Waiting before next article...');
      await delay(3000);
    }
  }

  // Write successful keywords to file for auto-generate.js to read
  const successPath = path.join(__dirname, 'successful-keywords.json');
  await fs.writeFile(successPath, JSON.stringify(successfulKeywords, null, 2));
  console.log(`\nSuccessfully generated: ${successfulKeywords.length}/${articles.length} articles`);

  console.log('\n' + '='.repeat(60));
  console.log('BATCH GENERATION COMPLETE');
  console.log('='.repeat(60));
}

main().catch(console.error);
