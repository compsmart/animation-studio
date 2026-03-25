/**
 * Standalone Kie connectivity diagnostic.
 *
 * Checks:
 * 1. Environment and proxy-related variables
 * 2. DNS resolution for the Kie API hosts
 * 3. Basic HTTPS reachability
 * 4. Authenticated file upload using a tiny inline PNG
 *
 * Run:
 *   node scripts/test-kie-connection.js
 */
import 'dotenv/config';
import dns from 'node:dns/promises';
import tls from 'node:tls';

const API_HOST = 'api.kie.ai';
const FILE_HOST = 'kieai.redpandaai.co';
const FILE_UPLOAD_URL = `https://${FILE_HOST}/api/file-base64-upload`;
const CONNECT_TIMEOUT_MS = 30000;

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
  const apiKey = process.env.KIE_API_KEY || '';

  console.log('Kie connection diagnostic');
  console.log('=========================');
  console.log(`Node: ${process.version}`);
  console.log(`KIE key present: ${apiKey ? 'yes' : 'no'}`);
  console.log(`HTTPS_PROXY: ${maskEnv(process.env.HTTPS_PROXY)}`);
  console.log(`HTTP_PROXY: ${maskEnv(process.env.HTTP_PROXY)}`);
  console.log(`HTTP_PROXYS: ${maskEnv(process.env.HTTP_PROXYS)}`);
  console.log(`ALL_PROXY: ${maskEnv(process.env.ALL_PROXY)}`);
  console.log(`NO_PROXY: ${process.env.NO_PROXY || '(not set)'}`);
  console.log(`NODE_EXTRA_CA_CERTS: ${process.env.NODE_EXTRA_CA_CERTS || '(not set)'}`);
  console.log(`NODE_USE_ENV_PROXY: ${process.env.NODE_USE_ENV_PROXY || '(not set)'}`);
  console.log('');

  const failures = [];

  await runCheck('DNS lookup api.kie.ai', failures, async () => {
    const addresses = await dns.lookup(API_HOST, { all: true });
    console.log(formatAddresses(addresses));
  });

  await runCheck('DNS lookup kieai.redpandaai.co', failures, async () => {
    const addresses = await dns.lookup(FILE_HOST, { all: true });
    console.log(formatAddresses(addresses));
  });

  await runCheck('TLS connect api.kie.ai:443', failures, async () => {
    await tlsConnect(API_HOST, 443, CONNECT_TIMEOUT_MS);
  });

  await runCheck('TLS connect kieai.redpandaai.co:443', failures, async () => {
    await tlsConnect(FILE_HOST, 443, CONNECT_TIMEOUT_MS);
  });

  await runCheck('HTTPS GET https://api.kie.ai/', failures, async () => {
    const res = await fetchWithTimeout(`https://${API_HOST}/`, {
      method: 'GET',
      redirect: 'manual',
    }, CONNECT_TIMEOUT_MS);
    console.log(`status=${res.status} content-type=${res.headers.get('content-type') || 'unknown'}`);
  });

  await runCheck('HTTPS GET https://kieai.redpandaai.co/', failures, async () => {
    const res = await fetchWithTimeout(`https://${FILE_HOST}/`, {
      method: 'GET',
      redirect: 'manual',
    }, CONNECT_TIMEOUT_MS);
    console.log(`status=${res.status} content-type=${res.headers.get('content-type') || 'unknown'}`);
  });

  if (!apiKey) {
    console.log('');
    console.log('Skipping authenticated upload because KIE_API_KEY is not set.');
  } else {
    await runCheck('Authenticated upload to Kie file endpoint', failures, async () => {
      const res = await fetchWithTimeout(FILE_UPLOAD_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          base64Data: `data:image/png;base64,${TINY_PNG_BASE64}`,
          uploadPath: 'kling-refs',
          fileName: `connect-test-${Date.now()}.png`,
        }),
      }, CONNECT_TIMEOUT_MS);

      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response (${res.status}): ${truncate(text, 200)}`);
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${json.msg || truncate(text, 200)}`);
      }
      if (!json.success || !json.data?.downloadUrl) {
        throw new Error(`Upload rejected: ${json.msg || truncate(text, 200)}`);
      }

      console.log(`downloadUrl=${json.data.downloadUrl}`);
    });
  }

  console.log('');
  if (failures.length === 0) {
    console.log('PASS: All Kie connectivity checks passed.');
    process.exit(0);
  }

  console.log(`FAIL: ${failures.length} check(s) failed.`);
  for (const failure of failures) {
    console.log(`- ${failure.name}: ${failure.message}`);
  }
  console.log('');
  console.log('Likely causes when browser works but this script fails:');
  console.log('- Node is not using the same proxy/VPN path as the browser.');
  console.log('- The network path is slow enough that Node hits its connect timeout.');
  console.log('- A firewall is allowing browser traffic but blocking this process.');
  process.exit(1);
}

async function runCheck(name, failures, fn) {
  process.stdout.write(`[check] ${name} ... `);
  try {
    await fn();
    console.log('OK');
  } catch (err) {
    const details = describeError(err);
    console.log(`FAIL (${details})`);
    failures.push({ name, message: details });
  }
}

function tlsConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      timeout: timeoutMs,
    });

    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate();
      console.log(`authorized=${socket.authorized} protocol=${socket.getProtocol()} subject=${peer.subject?.CN || 'unknown'}`);
      socket.end();
      resolve();
    });

    socket.once('timeout', () => {
      socket.destroy(new Error(`TLS connect timeout after ${timeoutMs}ms`));
    });

    socket.once('error', (err) => {
      reject(err);
    });
  });
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function formatAddresses(addresses) {
  return addresses.map((entry) => `${entry.address} (IPv${entry.family})`).join(', ');
}

function truncate(value, maxLen) {
  return value.length > maxLen ? `${value.slice(0, maxLen)}...` : value;
}

function maskEnv(value) {
  if (!value) return '(not set)';
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return '(set)';
  }
}

function describeError(err) {
  return err?.cause?.code || err?.code || err?.name || err?.message || String(err);
}

main().catch((err) => {
  console.error('Unexpected failure:', err);
  process.exit(1);
});
