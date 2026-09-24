import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { home } from "./config";
import { decryptBytes, encryptBytes } from "./security";

const directory = join(home, "captures");
const MAGIC = Buffer.from("PGWCAP01");
const STAGES = ["request", "effective", "upstream", "response", "output"] as const;
const MAX_BLOCK_BYTES = 16 * 1024 * 1024;

export function newCaptureStorageKey() {
  return randomUUID();
}
function validateKey(key: string) {
  if (!/^[0-9a-f-]{36}$/i.test(key)) throw new Error("Invalid capture key");
}
function validateStage(stage: string): asserts stage is (typeof STAGES)[number] {
  if (!STAGES.includes(stage as (typeof STAGES)[number]))
    throw new Error("Invalid capture stage");
}
function pathFor(key: string, stage: string) {
  validateKey(key);
  validateStage(stage);
  return join(directory, `${key}-${stage}.cap`);
}

/** One append-only file per request stage; each compressed/encrypted chunk is independently seekable. */
export async function appendCaptureBlocks(
  key: string,
  stage: string,
  blocks: Buffer[],
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(pathFor(key, stage), "a+", 0o600);
  try {
    const info = await handle.stat();
    if (info.size === 0) await handle.write(MAGIC, 0, MAGIC.length, 0);
    else {
      const header = Buffer.alloc(MAGIC.length);
      const result = await handle.read(header, 0, header.length, 0);
      if (result.bytesRead !== MAGIC.length || !header.equals(MAGIC))
        throw new Error("Invalid capture file header");
    }
    const encrypted = blocks.map((plain) =>
      encryptBytes(Bun.zstdCompressSync(plain, { level: 1 })),
    );
    let offset = info.size || MAGIC.length;
    const offsets = encrypted.map((block) => {
      const result = { offset, length: block.length };
      offset += block.length;
      return result;
    });
    if (encrypted.length) await handle.write(Buffer.concat(encrypted));
    return offsets;
  } finally {
    await handle.close();
  }
}

export async function readCaptureBlock(
  key: string,
  stage: string,
  offset: number,
  length: number,
) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < MAGIC.length ||
    length <= 0 ||
    length > MAX_BLOCK_BYTES
  )
    throw new Error("Invalid capture block index");
  const handle = await open(pathFor(key, stage), "r");
  try {
    const header = Buffer.alloc(MAGIC.length);
    const headRead = await handle.read(header, 0, header.length, 0);
    if (headRead.bytesRead !== MAGIC.length || !header.equals(MAGIC))
      throw new Error("Invalid capture file header");
    const encrypted = Buffer.alloc(length);
    const result = await handle.read(encrypted, 0, length, offset);
    if (result.bytesRead !== length) throw new Error("Truncated capture block");
    return Bun.zstdDecompressSync(decryptBytes(encrypted));
  } finally {
    await handle.close();
  }
}

export async function removeCaptureStage(key: string, stage: string) {
  try {
    await unlink(pathFor(key, stage));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
export async function removeCaptureFiles(key: string | null | undefined) {
  if (!key) return;
  await Promise.all(STAGES.map((stage) => removeCaptureStage(key, stage)));
}

/** Repair filesystem leftovers after a crash around a DB-index update or deletion. */
export async function reconcileCaptureFiles(
  referenced: Map<string, Map<string, number>>,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of await readdir(directory)) {
    const match = file.match(/^([0-9a-f-]{36})-(request|effective|upstream|response|output)\.cap$/i);
    if (!match) continue;
    const expectedLength = referenced.get(match[1])?.get(match[2]);
    if (expectedLength === undefined) {
      await removeCaptureStage(match[1], match[2]);
      continue;
    }
    const handle = await open(join(directory, file), "r+");
    try {
      const info = await handle.stat();
      if (info.size > expectedLength) await handle.truncate(expectedLength);
    } finally {
      await handle.close();
    }
  }
}
