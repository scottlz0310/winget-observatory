import { describe, expect, test } from "bun:test";
import { REDACTED, redactText } from "../scripts/lib/redact";

describe("redactText", () => {
  test("既知の秘密文字列を伏字にする", () => {
    const secret = "my-super-secret-token";
    const text = `Bearer ${secret} in text`;
    const result = redactText(text, [secret]);
    expect(result).not.toContain(secret);
    expect(result).toContain(REDACTED);
  });

  test("Bearer トークン形式の文字列を自動伏字にする", () => {
    const text = "Authorization: Bearer secret_abc_123456789";
    const result = redactText(text);
    expect(result).not.toContain("secret_abc_123456789");
    expect(result).toContain(`Bearer ${REDACTED}`);
  });

  test("JWT 形式の文字列を自動伏字にする", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature";
    const text = `Token: ${jwt}`;
    const result = redactText(text);
    expect(result).not.toContain("doNotLeakThisSignature");
    expect(result).toContain(REDACTED);
  });

  test("短い文字列（4文字未満）は誤爆防止のため既知秘密として置換しない", () => {
    const text = "hello abc world";
    const result = redactText(text, ["abc"]);
    expect(result).toBe("hello abc world");
  });
});
