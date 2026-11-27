import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PeArchitecture, PeInspectionResult } from "./types";

const MACHINE_X86 = 0x014c;
const MACHINE_X64 = 0x8664;
const MACHINE_ARM64 = 0xaa64;

const OPTIONAL_MAGIC_PE32 = 0x010b;
const OPTIONAL_MAGIC_PE32_PLUS = 0x020b;

const IMPORT_DIRECTORY_INDEX = 1;
const SECURITY_DIRECTORY_INDEX = 4;
const MAX_IMPORT_DESCRIPTORS = 2048;
const MAX_DLL_NAME_LENGTH = 260;

/**
 * クリーンな Windows VM に既定で含まれず、未同梱・依存未宣言のまま起動すると
 * STATUS_DLL_NOT_FOUND (0xC0000135) の原因になりやすい代表的なランタイム DLL パターン。
 */
const NON_STANDARD_RUNTIME_DLL_PATTERNS = [
  /^vcruntime\d+(?:_\d+)?\.dll$/i,
  /^msvcp\d+(?:_\d+)?\.dll$/i,
  /^concrt\d+\.dll$/i,
  /^mfc\d+u?\.dll$/i,
  /^vcomp\d+\.dll$/i,
  /^libgcc_s_(?:seh|dw2|sjlj)-\d+\.dll$/i,
  /^libstdc\+\+-\d+\.dll$/i,
  /^libwinpthread-\d+\.dll$/i,
];

interface PeSection {
  virtualAddress: number;
  virtualSize: number;
  rawSize: number;
  rawPointer: number;
}

function mapMachine(machine: number): PeArchitecture {
  switch (machine) {
    case MACHINE_X64:
      return "x64";
    case MACHINE_X86:
      return "x86";
    case MACHINE_ARM64:
      return "arm64";
    default:
      return "unknown";
  }
}

function rvaToFileOffset(rva: number, sections: readonly PeSection[]): number | null {
  for (const sec of sections) {
    const span = Math.max(sec.virtualSize, sec.rawSize);
    if (rva >= sec.virtualAddress && rva < sec.virtualAddress + span) {
      const offsetInSection = rva - sec.virtualAddress;
      if (offsetInSection < sec.rawSize) {
        return sec.rawPointer + offsetInSection;
      }
      return null;
    }
  }
  return null;
}

function readAsciiCString(buf: Uint8Array, offset: number): string | null {
  if (offset < 0 || offset >= buf.length) return null;
  const endLimit = Math.min(buf.length, offset + MAX_DLL_NAME_LENGTH);
  let end = offset;
  while (end < endLimit && buf[end] !== 0) {
    const byte = buf[end];
    if (byte < 0x20 || byte > 0x7e) return null;
    end++;
  }
  if (end === offset || end >= buf.length || buf[end] !== 0) {
    return null;
  }
  return Buffer.from(buf.subarray(offset, end)).toString("ascii");
}

function isNonStandardRuntimeDll(dllName: string): boolean {
  return NON_STANDARD_RUNTIME_DLL_PATTERNS.some((pattern) => pattern.test(dllName));
}

function invalidResult(filePath: string, error: string): PeInspectionResult {
  return {
    valid: false,
    filePath,
    format: "invalid",
    architecture: "unknown",
    importedDlls: [],
    nonStandardRuntimeDlls: [],
    hasAuthenticodeSignature: false,
    error,
  };
}

export function inspectPeBuffer(
  buf: Uint8Array,
  filePath: string,
  siblingFiles: readonly string[] = [],
): PeInspectionResult {
  if (buf.byteLength < 64) {
    return invalidResult(filePath, "ファイルサイズが PE ヘッダ最小長 (64 bytes) 未満です");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // DOS Magic "MZ"
  if (view.getUint16(0, true) !== 0x5a4d) {
    return invalidResult(filePath, "DOS マジック (MZ) が一致しません");
  }

  const peOffset = view.getUint32(0x3c, true);
  if (peOffset + 24 > buf.byteLength) {
    return invalidResult(filePath, "PE ヘッダオフセット (e_lfanew) がファイル範囲外です");
  }
  // PE\0\0
  if (view.getUint32(peOffset, true) !== 0x00004550) {
    return invalidResult(filePath, "PE シグネチャ (PE\\0\\0) が一致しません");
  }

  const coffOffset = peOffset + 4;
  const machine = view.getUint16(coffOffset, true);
  const numberOfSections = view.getUint16(coffOffset + 2, true);
  const sizeOfOptionalHeader = view.getUint16(coffOffset + 16, true);

  const optionalHeaderOffset = coffOffset + 20;
  if (sizeOfOptionalHeader < 96 || optionalHeaderOffset + sizeOfOptionalHeader > buf.byteLength) {
    return invalidResult(filePath, "Optional Header が欠損またはファイル範囲外です");
  }

  const magic = view.getUint16(optionalHeaderOffset, true);
  let format: "PE32" | "PE32+";
  let dataDirOffset: number;
  let numRvaOffset: number;
  if (magic === OPTIONAL_MAGIC_PE32) {
    format = "PE32";
    numRvaOffset = optionalHeaderOffset + 92;
    dataDirOffset = optionalHeaderOffset + 96;
  } else if (magic === OPTIONAL_MAGIC_PE32_PLUS) {
    format = "PE32+";
    numRvaOffset = optionalHeaderOffset + 108;
    dataDirOffset = optionalHeaderOffset + 112;
  } else {
    return invalidResult(filePath, `未対応の Optional Header Magic: 0x${magic.toString(16)}`);
  }

  if (numRvaOffset + 4 > optionalHeaderOffset + sizeOfOptionalHeader) {
    return invalidResult(filePath, "Optional Header が短すぎます");
  }
  const numberOfRvaAndSizes = Math.min(view.getUint32(numRvaOffset, true), 16);

  const readDataDirectory = (index: number): { rva: number; size: number } => {
    if (index >= numberOfRvaAndSizes) return { rva: 0, size: 0 };
    const off = dataDirOffset + index * 8;
    if (off + 8 > optionalHeaderOffset + sizeOfOptionalHeader) return { rva: 0, size: 0 };
    return {
      rva: view.getUint32(off, true),
      size: view.getUint32(off + 4, true),
    };
  };

  // セクションテーブル読込
  const sectionTableOffset = optionalHeaderOffset + sizeOfOptionalHeader;
  const sections: PeSection[] = [];
  for (let i = 0; i < numberOfSections; i++) {
    const off = sectionTableOffset + i * 40;
    if (off + 40 > buf.byteLength) break;
    sections.push({
      virtualSize: view.getUint32(off + 8, true),
      virtualAddress: view.getUint32(off + 12, true),
      rawSize: view.getUint32(off + 16, true),
      rawPointer: view.getUint32(off + 20, true),
    });
  }

  // Import Directory (Index 1) から DLL 名を抽出
  const importedDllSet = new Set<string>();
  const importDir = readDataDirectory(IMPORT_DIRECTORY_INDEX);
  if (importDir.rva !== 0) {
    const importFileOffset = rvaToFileOffset(importDir.rva, sections);
    if (importFileOffset !== null) {
      for (let i = 0; i < MAX_IMPORT_DESCRIPTORS; i++) {
        const descOffset = importFileOffset + i * 20;
        if (descOffset + 20 > buf.byteLength) break;
        const originalFirstThunk = view.getUint32(descOffset, true);
        const timeDateStamp = view.getUint32(descOffset + 4, true);
        const forwarderChain = view.getUint32(descOffset + 8, true);
        const nameRva = view.getUint32(descOffset + 12, true);
        const firstThunk = view.getUint32(descOffset + 16, true);
        if (
          originalFirstThunk === 0 &&
          timeDateStamp === 0 &&
          forwarderChain === 0 &&
          nameRva === 0 &&
          firstThunk === 0
        ) {
          break;
        }
        const nameFileOffset = rvaToFileOffset(nameRva, sections);
        if (nameFileOffset !== null) {
          const dllName = readAsciiCString(buf, nameFileOffset);
          if (dllName) {
            importedDllSet.add(dllName);
          }
        }
      }
    }
  }

  // Certificate Table (Index 4): PE 仕様上 VirtualAddress フィールドはファイルオフセット
  const securityDir = readDataDirectory(SECURITY_DIRECTORY_INDEX);
  const hasAuthenticodeSignature =
    securityDir.rva > 0 &&
    securityDir.size >= 8 &&
    securityDir.rva + securityDir.size <= buf.byteLength;

  const siblingLower = new Set(siblingFiles.map((f) => f.toLowerCase()));
  const importedDlls = [...importedDllSet].sort((a, b) => a.localeCompare(b));
  const nonStandardRuntimeDlls = importedDlls.filter(
    (dll) => isNonStandardRuntimeDll(dll) && !siblingLower.has(dll.toLowerCase()),
  );

  return {
    valid: true,
    filePath,
    format,
    architecture: mapMachine(machine),
    importedDlls,
    nonStandardRuntimeDlls,
    hasAuthenticodeSignature,
  };
}

export function inspectPeFile(filePathInput: string): PeInspectionResult {
  const filePath = resolve(filePathInput);
  let buf: Uint8Array;
  try {
    buf = readFileSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalidResult(filePath, `ファイルを読み込めません: ${message}`);
  }
  let siblingFiles: string[] = [];
  try {
    siblingFiles = readdirSync(dirname(filePath));
  } catch {
    siblingFiles = [];
  }
  return inspectPeBuffer(buf, filePath, siblingFiles);
}
