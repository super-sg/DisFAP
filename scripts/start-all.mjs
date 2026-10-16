import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

// 1. Load environment variables
const envPath = existsSync(resolve(rootDir, '.env')) 
  ? resolve(rootDir, '.env') 
  : resolve(rootDir, '.env.dev.example');

const env = { ...process.env };

if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!env[key]) {
        env[key] = val;
      }
    }
  }
}

// Ensure essential defaults
env.DFAP_ENV = env.DFAP_ENV || 'development';
env.API_PORT = env.API_PORT || '3000';
env.BROKER_PORT = env.BROKER_PORT || '8080';
env.BROKER_WS_PATH = env.BROKER_WS_PATH || '/tunnel';
env.BROKER_URL = env.BROKER_URL || 'ws://localhost:8080/tunnel';
env.DFAP_SIGNING_KEYS = env.DFAP_SIGNING_KEYS || 'kdev:gq12DUvetTrtZXQvojb2GIHtv9G9BBkA65jLOQTSTmc=';
env.DFAP_SIGNING_KID = env.DFAP_SIGNING_KID || 'kdev';
env.CLOUD_PROVIDER = env.CLOUD_PROVIDER || 'fake';
// Local dev runs without Postgres; enable the explicit dev fallbacks (fabricated
// session/teardown results + seeded in-memory catalog). NEVER default this on
// anywhere else — the control plane fails closed without it.
env.DFAP_DEV_FALLBACK = env.DFAP_DEV_FALLBACK || 'true';
// Local dev identity: the dev-header adapter is refused in production by
// config, and the CORS allowlist is the Vite origin only (never a wildcard).
env.DFAP_AUTH_MODE = env.DFAP_AUTH_MODE || 'dev-header';
env.DFAP_CORS_ALLOWED_ORIGINS = env.DFAP_CORS_ALLOWED_ORIGINS || 'http://localhost:5173';

console.log('\x1b[36m%s\x1b[0m', '═══════════════════════════════════════════════════════════════════');
console.log('\x1b[36m%s\x1b[0m', '  🚀 Starting DisFAP Complete Stack (API + Broker + Web UI)      ');
console.log('\x1b[36m%s\x1b[0m', '═══════════════════════════════════════════════════════════════════');
console.log(`  • DisFAP API:       http://localhost:${env.API_PORT}`);
console.log(`  • Guacamole Broker: ws://localhost:${env.BROKER_PORT}${env.BROKER_WS_PATH}`);
console.log(`  • Web Application:  http://localhost:5173/`);
console.log('\x1b[36m%s\x1b[0m', '───────────────────────────────────────────────────────────────────');

// 2. Spawn API & Broker
const apiProc = spawn('node', ['services/api/dist/server.js'], {
  cwd: rootDir,
  env,
  stdio: ['inherit', 'pipe', 'pipe']
});

apiProc.stdout.on('data', (d) => {
  process.stdout.write(`\x1b[34m[API/Broker]\x1b[0m ${d}`);
});
apiProc.stderr.on('data', (d) => {
  process.stderr.write(`\x1b[31m[API/Broker ERR]\x1b[0m ${d}`);
});

// 3. Spawn Vite Web
const webProc = spawn('npm', ['run', 'dev', '--workspace=@disfap/web'], {
  cwd: rootDir,
  env,
  stdio: ['inherit', 'pipe', 'pipe']
});

webProc.stdout.on('data', (d) => {
  process.stdout.write(`\x1b[32m[Web UI]\x1b[0m ${d}`);
});
webProc.stderr.on('data', (d) => {
  process.stderr.write(`\x1b[33m[Web UI]\x1b[0m ${d}`);
});

function cleanup() {
  console.log('\n\x1b[33m%s\x1b[0m', 'Stopping DisFAP processes...');
  try { apiProc.kill('SIGTERM'); } catch {}
  try { webProc.kill('SIGTERM'); } catch {}
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

apiProc.on('exit', (code) => {
  console.log(`\x1b[31mAPI server exited with code ${code}\x1b[0m`);
  cleanup();
});
