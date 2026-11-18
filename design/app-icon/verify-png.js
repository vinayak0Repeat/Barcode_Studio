import fs from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function inspectPng(filename) {
  const buffer = fs.readFileSync(filename);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("invalid PNG signature");
  }

  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  let palette;
  let transparency;
  const imageData = [];

  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) throw new Error(`truncated ${type} chunk`);

    if (type === "IHDR") {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer[start + 8];
      colorType = buffer[start + 9];
      interlace = buffer[start + 12];
    } else if (type === "IDAT") {
      imageData.push(buffer.subarray(start, end));
    } else if (type === "PLTE") {
      palette = buffer.subarray(start, end);
    } else if (type === "tRNS") {
      transparency = buffer.subarray(start, end);
    }

    offset = end + 4;
    if (type === "IEND") break;
  }

  if (!width || !height || imageData.length === 0) throw new Error("missing image header or pixels");
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported PNG encoding (bitDepth=${bitDepth}, interlace=${interlace})`);

  // RGB PNGs without tRNS have no alpha channel and are opaque by format.
  if (colorType === 2 && !transparency) return { width, height, opaque: true };

  const channelCount = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
  if (!channelCount) throw new Error(`unsupported PNG colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error("indexed PNG has no palette");
  const rowLength = width * channelCount;
  const bytes = inflateSync(Buffer.concat(imageData));
  const expectedLength = height * (rowLength + 1);
  if (bytes.length !== expectedLength) throw new Error("decoded pixel data has an unexpected length");

  let previous = Buffer.alloc(rowLength);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = bytes[cursor++];
    const row = Buffer.allocUnsafe(rowLength);
    for (let x = 0; x < rowLength; x += 1) {
      const encoded = bytes[cursor++];
      const left = x >= channelCount ? row[x - channelCount] : 0;
      const above = previous[x];
      const upperLeft = x >= channelCount ? previous[x - channelCount] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? above
            : filter === 3 ? Math.floor((left + above) / 2)
              : filter === 4 ? paeth(left, above, upperLeft)
                : NaN;
      if (!Number.isFinite(predictor)) throw new Error(`invalid PNG filter ${filter}`);
      row[x] = (encoded + predictor) & 0xff;
    }

    if (colorType === 4 || colorType === 6) {
      const alphaOffset = colorType === 4 ? 1 : 3;
      for (let x = alphaOffset; x < rowLength; x += channelCount) {
        if (row[x] !== 255) return { width, height, opaque: false };
      }
    } else if (colorType === 3 && transparency) {
      for (let x = 0; x < rowLength; x += 1) {
        if (row[x] < transparency.length && transparency[row[x]] !== 255) {
          return { width, height, opaque: false };
        }
      }
    } else if ((colorType === 0 || colorType === 2) && transparency) {
      // tRNS marks a matching grayscale/RGB key fully transparent.
      const transparentKey = colorType === 0
        ? [transparency.readUInt16BE(0) & 0xff]
        : [transparency.readUInt16BE(0) & 0xff, transparency.readUInt16BE(2) & 0xff, transparency.readUInt16BE(4) & 0xff];
      for (let x = 0; x < rowLength; x += channelCount) {
        if (transparentKey.every((value, index) => row[x + index] === value)) {
          return { width, height, opaque: false };
        }
      }
    }

    previous = row;
  }
  return { width, height, opaque: true };
}

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error("Usage: node verify-png.js file.png@WIDTHxHEIGHT [...]");
  process.exit(2);
}

let passed = true;
for (const input of inputs) {
  const at = input.lastIndexOf("@");
  if (at < 1) {
    console.error(`FAIL ${input}: expected filename@WIDTHxHEIGHT`);
    passed = false;
    continue;
  }
  const relative = input.slice(0, at);
  const expected = input.slice(at + 1).match(/^(\d+)x(\d+)$/);
  if (!expected) {
    console.error(`FAIL ${relative}: invalid expected dimensions`);
    passed = false;
    continue;
  }
  const [expectedWidth, expectedHeight] = expected.slice(1).map(Number);
  const fullPath = path.join(import.meta.dirname, relative);
  try {
    const image = inspectPng(fullPath);
    const errors = [];
    if (image.width !== expectedWidth || image.height !== expectedHeight) errors.push(`expected ${expectedWidth}x${expectedHeight}`);
    if (!image.opaque) errors.push("contains transparent pixels");
    if (errors.length) {
      console.error(`FAIL ${relative}: ${image.width}x${image.height} (${errors.join(", ")})`);
      passed = false;
    } else {
      console.log(`PASS ${relative}: ${image.width}x${image.height}, fully opaque`);
    }
  } catch (error) {
    console.error(`FAIL ${relative}: ${error.message}`);
    passed = false;
  }
}

process.exit(passed ? 0 : 1);
