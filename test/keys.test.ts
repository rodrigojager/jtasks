import { describe, expect, test } from "bun:test"
import { canonical, conflicts, firstConflict, normalizeKey, relConflicts } from "../src/keys.ts"
import { join, normalize, relativeInside } from "../src/paths.ts"

describe("normalizeKey", () => {
  test("Windows: absolute, forward slashes, lower case, no trailing slash", () => {
    expect(normalizeKey("src\\Humanizer\\Move.ts", "D:\\Temp\\Spy", "win32")).toBe("d:/temp/spy/src/humanizer/move.ts")
    expect(normalizeKey("D:\\Proj\\SRC\\", "C:/x", "win32")).toBe("d:/proj/src")
    expect(normalizeKey("src", "D:/proj", "win32")).toBe(normalizeKey("d:/proj/src", "C:/x", "win32"))
    expect(normalizeKey(".", "D:/proj", "win32")).toBe("d:/proj")
    expect(normalizeKey("a/../b/./c.ts", "D:/proj", "win32")).toBe("d:/proj/b/c.ts")
  })

  test("Linux keeps the case", () => {
    expect(normalizeKey("src/A.ts", "/home/me/Proj", "linux")).toBe("/home/me/Proj/src/A.ts")
  })

  test("names and * stay as they are", () => {
    expect(normalizeKey("name:Port-3000", "D:/p", "win32")).toBe("name:Port-3000")
    expect(normalizeKey("*", "D:/p", "win32")).toBe("*")
  })
})

describe("conflicts (jlock hierarchy rule)", () => {
  test("same key, folder above, path inside", () => {
    expect(conflicts("d:/p/src", "d:/p/src")).toBe(true)
    expect(conflicts("d:/p/src", "d:/p/src/a.ts")).toBe(true)
    expect(conflicts("d:/p/src/a.ts", "d:/p/src")).toBe(true)
  })

  test("siblings and prefixes that are not folders do not conflict", () => {
    expect(conflicts("d:/p/src/a.ts", "d:/p/src/b.ts")).toBe(false)
    expect(conflicts("d:/p/src", "d:/p/src2/a.ts")).toBe(false)
  })

  test("* conflicts with everything, name: only with the same name", () => {
    expect(conflicts("*", "name:x")).toBe(true)
    expect(conflicts("d:/p", "*")).toBe(true)
    expect(conflicts("name:x", "name:x")).toBe(true)
    expect(conflicts("name:x", "name:y")).toBe(false)
    expect(conflicts("name:x", "d:/p")).toBe(false)
  })

  test("firstConflict says via which key", () => {
    expect(firstConflict("d:/p/src/x.ts", ["d:/p/lib", "d:/p/src"])).toEqual({ key: "d:/p/src/x.ts", via: "d:/p/src" })
    expect(firstConflict("d:/p/src/x.ts", ["d:/p/lib"])).toBeUndefined()
  })

  test("canonical order", () => {
    expect(canonical(["d:/p/b", "d:/p/a", "d:/p/b"])).toEqual(["d:/p/a", "d:/p/b"])
  })

  test("relative ownership paths", () => {
    expect(relConflicts("src", "SRC/a.ts", true)).toBe(true)
    expect(relConflicts("src", "SRC/a.ts", false)).toBe(false)
    expect(relConflicts(".", "a.ts", true)).toBe(true)
  })
})

describe("paths", () => {
  test("normalize and join", () => {
    expect(normalize("D:\\a\\b\\..\\c")).toBe("D:/a/c")
    expect(join("D:/a", "b", "../c")).toBe("D:/a/c")
    expect(join("D:/a", "E:/x")).toBe("E:/x")
  })

  test("relativeInside", () => {
    expect(relativeInside("D:/Proj", "d:/proj/src/a.ts", true)).toBe("src/a.ts")
    expect(relativeInside("D:/Proj", "D:/Other/a.ts", true)).toBeUndefined()
  })
})
