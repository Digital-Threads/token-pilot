import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Minimal tar extractor — extracts a single named file from a tar buffer.
 * Tar format: 512-byte headers + 512-byte aligned data blocks.
 */
export async function tarExtract(
  tarData: Buffer,
  destDir: string,
  targetName: string,
): Promise<void> {
  let offset = 0;

  while (offset + 512 <= tarData.length) {
    const header = tarData.subarray(offset, offset + 512);

    // Empty block = end of archive
    if (header.every(b => b === 0)) break;

    // Parse file name (bytes 0-99, null-terminated)
    const rawName = header.subarray(0, 100).toString('utf-8').replace(/\0/g, '');
    // Also check prefix field (bytes 345-499) for long names
    const prefix = header.subarray(345, 500).toString('utf-8').replace(/\0/g, '');
    const fullName = prefix ? `${prefix}/${rawName}` : rawName;

    // Parse file size (bytes 124-135, octal)
    const sizeStr = header.subarray(124, 136).toString('utf-8').replace(/\0/g, '').trim();
    const size = parseInt(sizeStr, 8) || 0;

    // Parse type flag (byte 156): '0' or '\0' = regular file
    const typeFlag = header[156];
    const isFile = typeFlag === 0x30 || typeFlag === 0x00;

    offset += 512; // Move past header

    // Check if this is the file we want
    const baseName = fullName.split('/').pop() ?? '';
    if (isFile && (baseName === targetName || fullName === targetName)) {
      const fileData = tarData.subarray(offset, offset + size);
      await writeFile(resolve(destDir, targetName), fileData);
      return;
    }

    // Skip data blocks (512-byte aligned)
    const blocks = Math.ceil(size / 512);
    offset += blocks * 512;
  }

  throw new Error(`"${targetName}" not found in tar archive`);
}
