import * as fs from 'node:fs';
import * as path from 'node:path';

const PACKET_MAX_AGE_MS = 60 * 60 * 1000;

export async function sweepStalePackets(scratchDir: string): Promise<void> {
  let names: string[] = [];
  try { names = await fs.promises.readdir(scratchDir); } catch { return; }
  const cutoff = Date.now() - PACKET_MAX_AGE_MS;
  await Promise.all(names.filter((name) => /^packet-[^/\\]+\.json$/u.test(name)).map(async (name) => {
    const packetPath = path.join(scratchDir, name);
    try {
      const stat = await fs.promises.stat(packetPath);
      if (stat.mtimeMs < cutoff) await fs.promises.rm(packetPath, { force: true });
    } catch {
      // A concurrent invocation may have removed the file already.
    }
  }));
}

export async function removePacket(packetPath: string): Promise<void> {
  // Windows can keep the file handle briefly after OMP exits.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fs.promises.rm(packetPath, { force: true });
      if (!fs.existsSync(packetPath)) return;
    } catch {
      // Retry below; cleanup must not mask the model result.
    }
    await new Promise((resolve) => setTimeout(resolve, 100 * (2 ** attempt)));
  }
}
