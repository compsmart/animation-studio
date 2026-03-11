/**
 * Test Kie image upload - verifies uploadRefImageToKie works.
 * Run: node scripts/test-kie-upload.js
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { uploadRefImageToKie } from './kling-video.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    console.error('ERROR: KIE_API_KEY not set in .env');
    process.exit(1);
  }

  // Use spiderman.png if it exists, otherwise a tiny 1x1 PNG
  const testPaths = [
    path.join(__dirname, '..', 'spiderman.png'),
    path.join(__dirname, '..', 'public', 'index.html'), // fallback - won't be valid image
  ];
  let imagePath = testPaths.find((p) => fs.existsSync(p) && p.endsWith('.png'));
  if (!imagePath) {
    // Create minimal 1x1 red PNG for test
    const minimalPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    imagePath = path.join(__dirname, '..', 'data', 'test-pixel.png');
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, minimalPng);
  }

  const imageBuffer = fs.readFileSync(imagePath);
  console.log(`Testing with: ${path.basename(imagePath)} (${imageBuffer.length} bytes)\n`);

  try {
    console.log('1. Uploading to Kie...');
    const downloadUrl = await uploadRefImageToKie({
      apiKey,
      imageBuffer,
      fileName: `test-${Date.now()}.png`,
    });
    console.log('   OK - Got downloadUrl\n');

    console.log('2. Verifying URL is accessible...');
    const fetchRes = await fetch(downloadUrl);
    if (!fetchRes.ok) {
      throw new Error(`Fetch failed: ${fetchRes.status} ${fetchRes.statusText}`);
    }
    const contentType = fetchRes.headers.get('content-type') || '';
    const bodyLen = (await fetchRes.arrayBuffer()).byteLength;
    console.log(`   OK - ${fetchRes.status}, ${contentType}, ${bodyLen} bytes\n`);

    console.log('3. Summary:');
    console.log(`   URL length: ${downloadUrl.length} chars`);
    console.log(`   URL: ${downloadUrl.slice(0, 80)}...`);
    console.log('\nPASS - Kie image upload verified');
  } catch (err) {
    console.error('\nFAIL:', err.message);
    process.exit(1);
  }
}

run();
