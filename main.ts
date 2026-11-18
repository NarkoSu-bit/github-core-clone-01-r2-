// Launcher tipis: entry point grader adalah `node /bot/main.ts` (Node 22).
// Semua logika ada di binary Go `forge`; file ini hanya men-spawn-nya dengan
// env diteruskan dan menunggu sampai selesai.
//
// Cara binary sampai ke grader:
// - push-files (GitHub connector) HANYA menerima file teks UTF-8, jadi binary
//   tidak bisa di-push langsung. Binary disimpan sebagai base64 terbelah
//   (`forge.b64.0` + `forge.b64.1`, masing-masing ~5,2 MB — cap per-file
//   kompetisi 8 MiB) dan di-decode saat startup.
// - Urutan: (1) pakai ./forge bila ada dan bisa jalan; (2) bila ada tapi bit
//   executable hilang, salin ke /tmp + chmod +x; (3) bila tidak ada, gabung +
//   decode ./forge.b64.* ke /tmp/forge-r5 + chmod +x. /tmp selalu bisa
//   ditulis di pod grader (sementara /bot read-only).
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
let bin = join(dir, 'forge');

function probe(path: string): boolean {
  try {
    const r = spawnSync(path, ['--version'], { stdio: 'ignore', timeout: 10_000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

if (!probe(bin)) {
  const tmp = '/tmp/forge-r5';
  // (2) Salin bila file ada tapi tidak bisa dieksekusi.
  try {
    copyFileSync(bin, tmp);
    chmodSync(tmp, 0o755);
    if (probe(tmp)) bin = tmp;
  } catch {
    // Lanjut ke fallback base64.
  }
  // (3) Decode forge.b64.* bila ./forge tetap tidak bisa jalan.
  // Binary disimpan terbelah (forge.b64.0 + forge.b64.1, masing-masing
  // ~5,2 MB) karena cap per-file kompetisi adalah 8 MiB.
  if (bin === join(dir, 'forge')) {
    try {
      const b64 = readFileSync(join(dir, 'forge.b64.0'), 'utf8') +
        readFileSync(join(dir, 'forge.b64.1'), 'utf8');
      writeFileSync(tmp, Buffer.from(b64, 'base64'));
      chmodSync(tmp, 0o755);
      if (probe(tmp)) bin = tmp;
    } catch {
      // Tetap coba path asli; error spawn akan terlihat di stderr.
    }
  }
}

const child = spawn(bin, [], { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  process.stderr.write(`[entry] failed to spawn forge: ${err.message}\n`);
  process.exit(1);
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
