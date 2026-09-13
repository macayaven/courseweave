// Bounded to caller-owned local roots; never retain discovered credentials.
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function scanFiles(root: string, credentials: readonly string[]): Promise<number> {
  const needles = credentials.filter((credential) => credential.length > 0).map((credential) => Buffer.from(credential));
  let files = 0;
  let names: string[];
  try { names = await readdir(root, { recursive: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let cursor = 0;
  const worker = async () => {
    while (cursor < names.length) {
      const name = names[cursor++];
      if (name === undefined) return;
      const path = join(root, name);
      try {
        if (!(await lstat(path)).isFile()) continue;
        files += 1;
        const bytes = await readFile(path);
        if (needles.some((needle) => bytes.includes(needle))) {
          throw new Error('Installed-wheel credential scan found a retained credential.');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, names.length) }, worker));
  return files;
}
