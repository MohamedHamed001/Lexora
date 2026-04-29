import fs from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const repoRoot = process.cwd();
  const srcDir = path.join(repoRoot, 'extension');
  const outDir = path.join(repoRoot, 'dist', 'extension-firefox');

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(outDir), { recursive: true });

  await fs.cp(srcDir, outDir, { recursive: true });

  const ffManifestPath = path.join(srcDir, 'manifest.firefox.json');
  const ffManifestRaw = await fs.readFile(ffManifestPath, 'utf8');
  const ffManifest = JSON.parse(ffManifestRaw);

  // Write as manifest.json because Firefox expects that filename.
  const outManifestPath = path.join(outDir, 'manifest.json');
  await fs.writeFile(outManifestPath, JSON.stringify(ffManifest, null, 2) + '\n', 'utf8');

  console.log(`Built Firefox extension at: ${outDir}`);
  console.log(`Load this file in Firefox: ${outManifestPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

