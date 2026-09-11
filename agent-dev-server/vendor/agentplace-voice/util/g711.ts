/**
 * ITU-T G.711 companding — µ-law and A-law, both directions.
 *
 * Lives in `util/` rather than beside a provider adapter because it belongs to
 * no provider: G.711 is what the PSTN carries, so every telephony leg and every
 * upstream that serves telephony meets it. µ-law is the standard in North
 * America and Japan, A-law across most of Europe.
 *
 * These are conversion helpers for a caller whose audio is in one format and
 * whose negotiated leg is in another. An adapter whose negotiated format
 * already matches the wire must not call them: converting audio that is already
 * correct is pure loss of time, and in the A-law/µ-law direction, of quality.
 *
 * Both laws round-trip their own code words exactly, with one exception noted
 * on `muLawToPcm16`.
 */

const G711_BIAS = 0x84;
const G711_CLIP = 32_635;

/** Upper bound of each A-law segment, in the 13-bit domain the law is defined over. */
const ALAW_SEGMENT_ENDS = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
/** Saturation point of that domain — A-law's counterpart to µ-law's clip. */
const ALAW_CLIP = 0xfff;
/** Alternating-bit mask G.711 applies so silence is not a run of identical bytes. */
const ALAW_POSITIVE_MASK = 0xd5;
const ALAW_NEGATIVE_MASK = 0x55;

function encodeMuLawSample(sample: number): number {
  const sign = (sample >> 8) & 0x80;
  let magnitude = sign === 0 ? sample : -sample;
  if (magnitude > G711_CLIP) {
    magnitude = G711_CLIP;
  }
  magnitude += G711_BIAS;
  let exponent = 7;
  let mask = 0x4000;
  while ((magnitude & mask) === 0 && exponent > 0) {
    exponent -= 1;
    mask >>= 1;
  }
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function decodeMuLawByte(code: number): number {
  const inverted = ~code & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  const magnitude = (((mantissa << 3) + G711_BIAS) << exponent) - G711_BIAS;
  return sign === 0 ? magnitude : -magnitude;
}

function alawSegmentOf(magnitude: number): number {
  let segment = 0;
  while (segment < ALAW_SEGMENT_ENDS.length - 1 && magnitude > ALAW_SEGMENT_ENDS[segment]) {
    segment += 1;
  }
  return segment;
}

function encodeALawSample(sample: number): number {
  // A-law is defined over 13 bits; the low 3 bits of a 16-bit sample are dropped.
  const narrowed = sample >> 3;
  const positive = narrowed >= 0;
  const magnitude = Math.min(positive ? narrowed : -narrowed - 1, ALAW_CLIP);
  const mask = positive ? ALAW_POSITIVE_MASK : ALAW_NEGATIVE_MASK;
  const segment = alawSegmentOf(magnitude);
  const shift = segment < 2 ? 1 : segment;
  return ((segment << 4) | ((magnitude >> shift) & 0x0f)) ^ mask;
}

function decodeALawByte(code: number): number {
  const unmasked = code ^ ALAW_NEGATIVE_MASK;
  const segment = (unmasked & 0x70) >> 4;
  let magnitude = (unmasked & 0x0f) << 4;
  if (segment === 0) {
    magnitude += 8;
  } else if (segment === 1) {
    magnitude += 0x108;
  } else {
    magnitude = (magnitude + 0x108) << (segment - 1);
  }
  return (unmasked & 0x80) === 0 ? -magnitude : magnitude;
}

function readPcm16(pcm: Uint8Array): Buffer {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

function compand(pcm: Uint8Array, encodeSample: (sample: number) => number): Buffer {
  const source = readPcm16(pcm);
  const sampleCount = Math.floor(source.length / 2);
  const encoded = Buffer.alloc(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    encoded[index] = encodeSample(source.readInt16LE(index * 2));
  }
  return encoded;
}

function expand(encoded: Uint8Array, decodeByte: (code: number) => number): Buffer {
  const pcm = Buffer.alloc(encoded.length * 2);
  for (let index = 0; index < encoded.length; index += 1) {
    pcm.writeInt16LE(decodeByte(encoded[index] ?? 0), index * 2);
  }
  return pcm;
}

/** Linear PCM16 little-endian to G.711 µ-law. A trailing odd byte is dropped. */
export function pcm16ToMuLaw(pcm: Uint8Array): Buffer {
  return compand(pcm, encodeMuLawSample);
}

/**
 * G.711 µ-law to linear PCM16 little-endian.
 *
 * 255 of the 256 code words survive a round trip back to µ-law unchanged. The
 * exception is `0x7f`, negative zero, which linear PCM cannot represent
 * separately from `0xff`; it is silence either way.
 */
export function muLawToPcm16(encoded: Uint8Array): Buffer {
  return expand(encoded, decodeMuLawByte);
}

/** Linear PCM16 little-endian to G.711 A-law. A trailing odd byte is dropped. */
export function pcm16ToALaw(pcm: Uint8Array): Buffer {
  return compand(pcm, encodeALawSample);
}

/** G.711 A-law to linear PCM16 little-endian. Every code word round-trips exactly. */
export function aLawToPcm16(encoded: Uint8Array): Buffer {
  return expand(encoded, decodeALawByte);
}
