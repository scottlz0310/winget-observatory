import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TARGET_PR,
  parseBoundedInt,
  parseTargetPrArg,
  readOptionValue,
  resolveDefaultTargetPr,
} from "../../src/cli/args";

describe("CLI args: readOptionValue", () => {
  test("フラグ直後の値を返す", () => {
    expect(readOptionValue(["--log-path", "a.csv"], 0, "ファイルパス")).toBe("a.csv");
  });

  test.each([
    [["--log-path"], "--log-path オプションにはファイルパスが必要です"],
    [["--log-path", "--no-log"], "--log-path オプションにはファイルパスが必要です"],
  ])("値の欠落・後続フラグの誤消費 %j を拒否する", (argv, message) => {
    expect(() => readOptionValue(argv, 0, "ファイルパス")).toThrow(message);
  });
});

describe("CLI args: 数値の解釈", () => {
  test.each([
    ["1", 1],
    ["464302", 464302],
  ])("parseTargetPrArg(%s) は %d を返す", (input, expected) => {
    expect(parseTargetPrArg(input)).toBe(expected);
  });

  test.each(["0", "-1", "abc", "1.5", "12abc", ""])("parseTargetPrArg(%j) は拒否する", (input) => {
    expect(() => parseTargetPrArg(input)).toThrow("--target-pr に無効な値が指定されました");
  });

  test.each([
    ["1", 1],
    ["365", 365],
  ])("parseBoundedInt(%s) は範囲内の整数を返す", (input, expected) => {
    expect(parseBoundedInt(input, "lookback-days", 1, 365)).toBe(expected);
  });

  test.each(["0", "366", "x", "-3", "2.5"])(
    "parseBoundedInt(%j) は範囲外・非整数を拒否する",
    (input) => {
      expect(() => parseBoundedInt(input, "lookback-days", 1, 365)).toThrow("無効な値");
    },
  );
});

describe("CLI args: resolveDefaultTargetPr", () => {
  test.each([
    [{}, DEFAULT_TARGET_PR],
    [{ WINGET_TARGET_PR: "" }, DEFAULT_TARGET_PR],
    [{ WINGET_TARGET_PR: "12345" }, 12345],
  ])("環境変数 %j から %d を解決する", (env, expected) => {
    expect(resolveDefaultTargetPr(env)).toBe(expected);
  });

  test.each(["abc", "0", "-5", "1e3"])("WINGET_TARGET_PR=%j は拒否する", (value) => {
    expect(() => resolveDefaultTargetPr({ WINGET_TARGET_PR: value })).toThrow(
      "無効な環境変数 WINGET_TARGET_PR",
    );
  });
});
