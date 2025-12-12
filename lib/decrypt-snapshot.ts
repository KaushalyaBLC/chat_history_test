/**
 * Browser-compatible snapshot decryption utility
 * Supports both JSON snapshots and binary OSNP format
 */

interface EncryptedSnapshot {
  enc: {
    wrappedKey: string;
    ciphertext: string;
    nonce: string;
    tag: string;
    compression?: string;
  };
}

/**
 * Convert PEM-formatted private key to CryptoKey for Web Crypto API
 */
async function importPrivateKey(pemKey: string): Promise<CryptoKey> {
  // Remove PEM headers and whitespace
  const pemContents = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');

  // Convert base64 to ArrayBuffer
  const binaryDer = atob(pemContents);
  const bytes = new Uint8Array(binaryDer.length);
  for (let i = 0; i < binaryDer.length; i++) {
    bytes[i] = binaryDer.charCodeAt(i);
  }

  // Import as CryptoKey
  return await crypto.subtle.importKey(
    'pkcs8',
    bytes.buffer,
    {
      name: 'RSA-OAEP',
      hash: 'SHA-256',
    },
    false,
    ['decrypt']
  );
}

/**
 * Base64 string to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decompress gzip data in browser
 */
async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
  // Create a proper ArrayBuffer copy
  const buffer = new ArrayBuffer(data.length);
  const copy = new Uint8Array(buffer);
  copy.set(data);

  const blob = new Blob([copy]);
  const stream = blob.stream().pipeThrough(
    new DecompressionStream('gzip')
  );
  const decompressed = await new Response(stream).arrayBuffer();
  return new Uint8Array(decompressed);
}

/**
 * Decrypt a JSON-formatted snapshot
 */
async function decryptJsonSnapshot(
  payload: EncryptedSnapshot,
  privateKey: CryptoKey
): Promise<any> {
  const { enc } = payload;
  if (!enc || !enc.wrappedKey || !enc.ciphertext || !enc.nonce || !enc.tag) {
    throw new Error('Invalid snapshot format: missing encryption fields');
  }

  // Decrypt the wrapped content key using RSA-OAEP
  const wrappedKeyBytes = base64ToUint8Array(enc.wrappedKey);
  const contentKeyBytes = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    wrappedKeyBytes
  );

  // Import the content key for AES-GCM decryption
  const contentKey = await crypto.subtle.importKey(
    'raw',
    contentKeyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // Prepare ciphertext with authentication tag
  const cipherBytes = base64ToUint8Array(enc.ciphertext);
  const tagBytes = base64ToUint8Array(enc.tag);
  const nonceBytes = base64ToUint8Array(enc.nonce);

  // Concatenate cipher and tag for AES-GCM
  const cipherWithTag = new Uint8Array(cipherBytes.length + tagBytes.length);
  cipherWithTag.set(cipherBytes);
  cipherWithTag.set(tagBytes, cipherBytes.length);

  // Decrypt using AES-GCM
  const plainBytes = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: nonceBytes,
      tagLength: 128,
    },
    contentKey,
    cipherWithTag
  );

  let finalBytes = new Uint8Array(plainBytes);

  // Decompress if needed
  if (enc.compression === 'gzip') {
    finalBytes = await decompressGzip(finalBytes);
  }

  // Parse as JSON
  const jsonText = new TextDecoder().decode(finalBytes);
  return JSON.parse(jsonText);
}

/**
 * Minimal MessagePack decoder for browser
 */
function decodeMsgpack(buffer: Uint8Array, offset = 0): { value: any; offset: number } {
  const readStr = (lenBytes: number) => {
    let len = 0;
    for (let i = 0; i < lenBytes; i++) {
      len = (len << 8) | buffer[offset + 1 + i];
    }
    offset += 1 + lenBytes;
    const s = new TextDecoder().decode(buffer.slice(offset, offset + len));
    offset += len;
    return s;
  };

  const readBin = (lenBytes: number) => {
    let len = 0;
    for (let i = 0; i < lenBytes; i++) {
      len = (len << 8) | buffer[offset + 1 + i];
    }
    offset += 1 + lenBytes;
    const v = buffer.slice(offset, offset + len);
    offset += len;
    return v;
  };

  const type = buffer[offset];

  // Null, boolean
  if (type === 0xc0) {
    offset += 1;
    return { value: null, offset };
  }
  if (type === 0xc2) {
    offset += 1;
    return { value: false, offset };
  }
  if (type === 0xc3) {
    offset += 1;
    return { value: true, offset };
  }

  // Positive/negative fixint
  if (type <= 0x7f) {
    offset += 1;
    return { value: type, offset };
  }
  if (type >= 0xe0) {
    offset += 1;
    return { value: type - 0x100, offset };
  }

  // Fixstr
  if ((type & 0xe0) === 0xa0) {
    const len = type & 0x1f;
    offset += 1;
    const s = new TextDecoder().decode(buffer.slice(offset, offset + len));
    offset += len;
    return { value: s, offset };
  }

  // Fixmap
  if ((type & 0xf0) === 0x80) {
    const len = type & 0x0f;
    offset += 1;
    const obj: any = {};
    for (let i = 0; i < len; i++) {
      const key = decodeMsgpack(buffer, offset);
      offset = key.offset;
      const val = decodeMsgpack(buffer, offset);
      offset = val.offset;
      obj[key.value] = val.value;
    }
    return { value: obj, offset };
  }

  // Fixarray
  if ((type & 0xf0) === 0x90) {
    const len = type & 0x0f;
    offset += 1;
    const arr = [];
    for (let i = 0; i < len; i++) {
      const v = decodeMsgpack(buffer, offset);
      offset = v.offset;
      arr.push(v.value);
    }
    return { value: arr, offset };
  }

  // Other types
  switch (type) {
    // bin formats
    case 0xc4: return { value: readBin(1), offset };
    case 0xc5: return { value: readBin(2), offset };
    case 0xc6: return { value: readBin(4), offset };

    // ext formats
    case 0xc7: {
      const len = buffer[offset + 1];
      offset += 3; // code + len + typeTag
      const v = buffer.slice(offset, offset + len);
      offset += len;
      return { value: v, offset };
    }
    case 0xc8: {
      const len = (buffer[offset + 1] << 8) | buffer[offset + 2];
      offset += 4; // code + len16 + typeTag
      const v = buffer.slice(offset, offset + len);
      offset += len;
      return { value: v, offset };
    }
    case 0xc9: {
      const len = (buffer[offset + 1] << 24) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 8) | buffer[offset + 4];
      offset += 6; // code + len32 + typeTag
      const v = buffer.slice(offset, offset + len);
      offset += len;
      return { value: v, offset };
    }

    // fixext formats
    case 0xd4: {
      offset += 2; // code + typeTag
      const v = buffer.slice(offset, offset + 1);
      offset += 1;
      return { value: v, offset };
    }
    case 0xd5: {
      offset += 2;
      const v = buffer.slice(offset, offset + 2);
      offset += 2;
      return { value: v, offset };
    }
    case 0xd6: {
      offset += 2;
      const v = buffer.slice(offset, offset + 4);
      offset += 4;
      return { value: v, offset };
    }
    case 0xd7: {
      offset += 2;
      const v = buffer.slice(offset, offset + 8);
      offset += 8;
      return { value: v, offset };
    }
    case 0xd8: {
      offset += 2;
      const v = buffer.slice(offset, offset + 16);
      offset += 16;
      return { value: v, offset };
    }

    // float formats
    case 0xca: {
      const view = new DataView(buffer.buffer, buffer.byteOffset + offset + 1, 4);
      const v = view.getFloat32(0, false); // big-endian
      offset += 5;
      return { value: v, offset };
    }
    case 0xcb: {
      const view = new DataView(buffer.buffer, buffer.byteOffset + offset + 1, 8);
      const v = view.getFloat64(0, false); // big-endian
      offset += 9;
      return { value: v, offset };
    }

    // uint formats
    case 0xcc: {
      const v = buffer[offset + 1];
      offset += 2;
      return { value: v, offset };
    }
    case 0xcd: {
      const v = (buffer[offset + 1] << 8) | buffer[offset + 2];
      offset += 3;
      return { value: v, offset };
    }
    case 0xce: {
      const v = (buffer[offset + 1] << 24) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 8) | buffer[offset + 4];
      offset += 5;
      return { value: v >>> 0, offset }; // unsigned
    }
    case 0xcf: {
      const view = new DataView(buffer.buffer, buffer.byteOffset + offset + 1, 8);
      const v = view.getBigUint64(0, false); // big-endian
      offset += 9;
      return { value: Number(v), offset };
    }

    // int formats
    case 0xd0: {
      const v = buffer[offset + 1];
      offset += 2;
      return { value: v > 127 ? v - 256 : v, offset }; // signed
    }
    case 0xd1: {
      const v = (buffer[offset + 1] << 8) | buffer[offset + 2];
      offset += 3;
      return { value: v > 32767 ? v - 65536 : v, offset }; // signed
    }
    case 0xd2: {
      const v = (buffer[offset + 1] << 24) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 8) | buffer[offset + 4];
      offset += 5;
      return { value: v | 0, offset }; // signed
    }
    case 0xd3: {
      const view = new DataView(buffer.buffer, buffer.byteOffset + offset + 1, 8);
      const v = view.getBigInt64(0, false); // big-endian
      offset += 9;
      return { value: Number(v), offset };
    }

    // str formats
    case 0xd9: return { value: readStr(1), offset };
    case 0xda: return { value: readStr(2), offset };
    case 0xdb: return { value: readStr(4), offset };

    // array formats
    case 0xdc: {
      const len = (buffer[offset + 1] << 8) | buffer[offset + 2];
      offset += 3;
      const arr = [];
      for (let i = 0; i < len; i++) {
        const v = decodeMsgpack(buffer, offset);
        offset = v.offset;
        arr.push(v.value);
      }
      return { value: arr, offset };
    }
    case 0xdd: {
      const len = (buffer[offset + 1] << 24) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 8) | buffer[offset + 4];
      offset += 5;
      const arr = [];
      for (let i = 0; i < len; i++) {
        const v = decodeMsgpack(buffer, offset);
        offset = v.offset;
        arr.push(v.value);
      }
      return { value: arr, offset };
    }

    // map formats
    case 0xde: {
      const len = (buffer[offset + 1] << 8) | buffer[offset + 2];
      offset += 3;
      const obj: any = {};
      for (let i = 0; i < len; i++) {
        const key = decodeMsgpack(buffer, offset);
        offset = key.offset;
        const val = decodeMsgpack(buffer, offset);
        offset = val.offset;
        obj[key.value] = val.value;
      }
      return { value: obj, offset };
    }
    case 0xdf: {
      const len = (buffer[offset + 1] << 24) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 8) | buffer[offset + 4];
      offset += 5;
      const obj: any = {};
      for (let i = 0; i < len; i++) {
        const key = decodeMsgpack(buffer, offset);
        offset = key.offset;
        const val = decodeMsgpack(buffer, offset);
        offset = val.offset;
        obj[key.value] = val.value;
      }
      return { value: obj, offset };
    }

    default:
      throw new Error(`Unsupported msgpack type 0x${type?.toString(16)} at offset ${offset}`);
  }
}

/**
 * Normalize MessagePack values (convert Buffers to strings)
 */
function normalizeMsgpackValue(value: any): any {
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeMsgpackValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalizeMsgpackValue(v)])
    );
  }
  return value;
}

/**
 * Decrypt OSNP binary snapshot format
 */
async function decryptOsnpSnapshot(
  buffer: Uint8Array,
  privateKey: CryptoKey
): Promise<any> {
  if (buffer.length < 32) {
    throw new Error('Snapshot buffer is too small');
  }

  const magic = new TextDecoder().decode(buffer.slice(0, 4));
  if (magic !== 'OSNP') {
    throw new Error('Not an OSNP snapshot');
  }

  // Try header at offset 9, fall back to 8
  let headerOffset = 9;
  let headerDecoded;
  try {
    headerDecoded = decodeMsgpack(buffer, headerOffset);
  } catch {
    headerOffset = 8;
    headerDecoded = decodeMsgpack(buffer, headerOffset);
  }

  const { value: header, offset: afterHeader } = headerDecoded;

  if (!header || typeof header !== 'object' || !header.wrappedKey) {
    throw new Error('Invalid OSNP header');
  }

  // Read cipher length, nonce, tag, and ciphertext
  const view = new DataView(buffer.buffer);
  const cipherLen = view.getUint32(afterHeader);
  const nonceStart = afterHeader + 4;
  const nonce = buffer.slice(nonceStart, nonceStart + 12);
  const tag = buffer.slice(nonceStart + 12, nonceStart + 28);
  const ciphertext = buffer.slice(nonceStart + 28, nonceStart + 28 + cipherLen);

  // Decrypt wrapped key
  const contentKeyBytes = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    header.wrappedKey
  );

  const contentKey = await crypto.subtle.importKey(
    'raw',
    contentKeyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // Decrypt ciphertext
  const cipherWithTag = new Uint8Array(ciphertext.length + tag.length);
  cipherWithTag.set(ciphertext);
  cipherWithTag.set(tag, ciphertext.length);

  const plainBytes = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      tagLength: 128,
    },
    contentKey,
    cipherWithTag
  );

  let finalBytes = new Uint8Array(plainBytes);

  // Decompress if needed
  if (header.compression === 'gzip') {
    finalBytes = await decompressGzip(finalBytes);
  }

  // Try JSON first, fall back to msgpack
  try {
    const jsonText = new TextDecoder().decode(finalBytes);
    return JSON.parse(jsonText);
  } catch {
    const msg = decodeMsgpack(finalBytes, 0);
    return normalizeMsgpackValue(msg.value);
  }
}

/**
 * Main decrypt function - handles both JSON and OSNP formats
 */
export async function decryptSnapshot(
  fileSource: string | ArrayBuffer | Blob,
  privateKeyPem: string,
  onProgress?: (status: string) => void
): Promise<any> {
  try {
    let arrayBuffer: ArrayBuffer;

    if (typeof fileSource === 'string') {
      onProgress?.('Downloading snapshot file...');
      const response = await fetch(fileSource);
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status}`);
      }
      arrayBuffer = await response.arrayBuffer();
    } else if (fileSource instanceof Blob) {
      onProgress?.('Reading snapshot blob...');
      arrayBuffer = await fileSource.arrayBuffer();
    } else {
      onProgress?.('Reading staged snapshot...');
      arrayBuffer = fileSource;
    }

    const buffer = new Uint8Array(arrayBuffer);

    onProgress?.('Importing private key...');

    // Import private key
    const privateKey = await importPrivateKey(privateKeyPem);

    onProgress?.('Decrypting snapshot...');

    // Try JSON format first
    try {
      const text = new TextDecoder().decode(buffer);
      const parsed = JSON.parse(text);
      return await decryptJsonSnapshot(parsed, privateKey);
    } catch {
      // Fall back to OSNP binary format
      return await decryptOsnpSnapshot(buffer, privateKey);
    }
  } catch (error) {
    console.error('Decryption error:', error);
    throw error;
  }
}

/**
 * Trigger browser download of decrypted data
 */
export function downloadDecryptedSnapshot(data: any, filename: string = 'snapshot-decrypted.json') {
  const jsonString = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
