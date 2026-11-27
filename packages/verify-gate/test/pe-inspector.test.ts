import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePeInspectionFindings } from "../src/gate-runner";
import { inspectPeBuffer, inspectPeFile } from "../src/pe-inspector";

/**
 * テスト用の最小有効 PE32 / PE32+ バイナリを合成するヘルパー。
 */
export function buildSyntheticPe(options: {
  machine: number;
  pe32Plus: boolean;
  importedDlls?: string[];
  hasSignature?: boolean;
}): Uint8Array {
  const { machine, pe32Plus, importedDlls = [], hasSignature = false } = options;
  const peOffset = 0x80;
  const optionalHeaderSize = pe32Plus ? 240 : 224;
  const sectionTableOffset = peOffset + 4 + 20 + optionalHeaderSize;
  const rdataRawOffset = 0x400;
  const rdataRva = 0x2000;
  const rdataSize = 0x400;
  const sigOffset = rdataRawOffset + rdataSize;
  const sigSize = hasSignature ? 64 : 0;
  const totalSize = sigOffset + sigSize;

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);

  // DOS header
  view.setUint16(0, 0x5a4d, true); // "MZ"
  view.setUint32(0x3c, peOffset, true);

  // PE\0\0 + COFF
  view.setUint32(peOffset, 0x00004550, true);
  const coffOffset = peOffset + 4;
  view.setUint16(coffOffset, machine, true);
  view.setUint16(coffOffset + 2, 1, true); // NumberOfSections = 1
  view.setUint16(coffOffset + 16, optionalHeaderSize, true);

  // Optional Header
  const optOffset = coffOffset + 20;
  view.setUint16(optOffset, pe32Plus ? 0x020b : 0x010b, true);
  const numRvaOffset = optOffset + (pe32Plus ? 108 : 92);
  const dataDirOffset = optOffset + (pe32Plus ? 112 : 96);
  view.setUint32(numRvaOffset, 16, true);

  // Import directory (Index 1)
  if (importedDlls.length > 0) {
    view.setUint32(dataDirOffset + 1 * 8, rdataRva, true);
    view.setUint32(dataDirOffset + 1 * 8 + 4, (importedDlls.length + 1) * 20, true);
  }

  // Security directory (Index 4: file offset)
  if (hasSignature) {
    view.setUint32(dataDirOffset + 4 * 8, sigOffset, true);
    view.setUint32(dataDirOffset + 4 * 8 + 4, sigSize, true);
    view.setUint32(sigOffset, sigSize, true);
  }

  // Section header ".rdata"
  buf.set(Buffer.from(".rdata\0\0", "ascii"), sectionTableOffset);
  view.setUint32(sectionTableOffset + 8, rdataSize, true); // VirtualSize
  view.setUint32(sectionTableOffset + 12, rdataRva, true); // VirtualAddress
  view.setUint32(sectionTableOffset + 16, rdataSize, true); // SizeOfRawData
  view.setUint32(sectionTableOffset + 20, rdataRawOffset, true); // PointerToRawData

  // IMAGE_IMPORT_DESCRIPTOR array + DLL ASCII strings
  let strCursor = (importedDlls.length + 1) * 20;
  for (const [idx, dll] of importedDlls.entries()) {
    const descOff = rdataRawOffset + idx * 20;
    view.setUint32(descOff + 12, rdataRva + strCursor, true); // Name RVA
    view.setUint32(descOff + 16, rdataRva + strCursor, true); // FirstThunk non-zero
    const bytes = Buffer.from(`${dll}\0`, "ascii");
    buf.set(bytes, rdataRawOffset + strCursor);
    strCursor += bytes.length;
  }

  return buf;
}

describe("pe-inspector", () => {
  test.each([
    { label: "x64 PE32+", machine: 0x8664, pe32Plus: true, expectedArch: "x64", format: "PE32+" },
    {
      label: "arm64 PE32+",
      machine: 0xaa64,
      pe32Plus: true,
      expectedArch: "arm64",
      format: "PE32+",
    },
    { label: "x86 PE32", machine: 0x014c, pe32Plus: false, expectedArch: "x86", format: "PE32" },
  ] as const)(
    "$label のアーキテクチャ・DLL・署名を正しく解析する",
    ({ machine, pe32Plus, expectedArch, format }) => {
      const buf = buildSyntheticPe({
        machine,
        pe32Plus,
        importedDlls: ["KERNEL32.dll", "VCRUNTIME140.dll", "MSVCP140.dll"],
        hasSignature: true,
      });
      const result = inspectPeBuffer(buf, "app.exe");
      expect(result.valid).toBe(true);
      expect(result.format).toBe(format);
      expect(result.architecture).toBe(expectedArch);
      expect(result.importedDlls).toEqual(["KERNEL32.dll", "MSVCP140.dll", "VCRUNTIME140.dll"]);
      expect(result.nonStandardRuntimeDlls).toEqual(["MSVCP140.dll", "VCRUNTIME140.dll"]);
      expect(result.hasAuthenticodeSignature).toBe(true);
    },
  );

  test("同ディレクトリに同梱されている DLL は未同梱リスクから除外する", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-pe-test-"));
    try {
      const exePath = join(tmpDir, "tool.exe");
      const buf = buildSyntheticPe({
        machine: 0x8664,
        pe32Plus: true,
        importedDlls: ["KERNEL32.dll", "VCRUNTIME140.dll"],
        hasSignature: false,
      });
      writeFileSync(exePath, buf);
      writeFileSync(join(tmpDir, "vcruntime140.dll"), new Uint8Array(16));

      const result = inspectPeFile(exePath);
      expect(result.valid).toBe(true);
      expect(result.nonStandardRuntimeDlls).toEqual([]);
      expect(result.hasAuthenticodeSignature).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("VCRUNTIME140.dll 依存は PackageDependencies 宣言ありなら pass、なしなら fail になる", () => {
    const buf = buildSyntheticPe({
      machine: 0x8664,
      pe32Plus: true,
      importedDlls: ["KERNEL32.dll", "VCRUNTIME140.dll"],
      hasSignature: false,
    });
    const pe = inspectPeBuffer(buf, "app.exe");

    const withoutDep = evaluatePeInspectionFindings(pe, { expectedArchitectures: ["x64"] });
    expect(withoutDep.find((f) => f.id === "PKG-PORT-01")?.status).toBe("fail");
    expect(withoutDep.find((f) => f.id === "CMN-07")?.status).toBe("warn");

    const withDep = evaluatePeInspectionFindings(pe, {
      expectedArchitectures: ["x64"],
      declaredDependencies: ["Microsoft.VCRedist.2015+.x64"],
    });
    expect(withDep.find((f) => f.id === "PKG-PORT-01")?.status).toBe("pass");

    const wrongArch = evaluatePeInspectionFindings(pe, { expectedArchitectures: ["arm64"] });
    expect(wrongArch.find((f) => f.id === "PKG-PORT-05")?.status).toBe("fail");
  });

  test("不正なバイナリや存在しないファイルは安全に invalid として報告する", () => {
    expect(inspectPeBuffer(new Uint8Array(10), "tiny.bin").valid).toBe(false);
    expect(inspectPeBuffer(new Uint8Array(128), "zeros.bin").valid).toBe(false);
    expect(inspectPeFile(join(tmpdir(), "non-existent-verify-gate-binary.exe")).valid).toBe(false);
  });
});
