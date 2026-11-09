import { describe, expect, test } from "bun:test"
import { canonical, conflicts, excludes, firstConflict, mergeSpecs, normalizeKey, relConflicts, sameFamily } from "../src/keys.ts"
import { join, normalize, relativeInside } from "../src/paths.ts"

describe("jlock 0.3 keys: resources, modes, families", () => {
  test("resource: keys are normalized like jlock and conflict only with the same resource and *", () => {
    expect(normalizeKey("resource:Port:08080", "D:/p", "win32")).toBe("resource:port:8080")
    expect(normalizeKey("resource:Desktop", "D:/p", "win32")).toBe("resource:desktop")
    expect(conflicts("resource:desktop", "resource:desktop")).toBe(true)
    expect(conflicts("resource:desktop", "resource:clipboard")).toBe(false)
    expect(conflicts("resource:desktop", "d:/p")).toBe(false)
    expect(conflicts("resource:desktop", "name:desktop")).toBe(false)
    expect(conflicts("resource:desktop", "*")).toBe(true)
  })

  test("two shared holds coexist, an exclusive one excludes; the stronger mode wins when a key comes twice", () => {
    expect(excludes({ key: "resource:machine", mode: "shared" }, { key: "resource:machine", mode: "shared" })).toBe(false)
    expect(excludes({ key: "resource:machine", mode: "exclusive" }, { key: "resource:machine", mode: "shared" })).toBe(true)
    expect(excludes({ key: "d:/p/src", mode: "shared" }, { key: "d:/p/src/a.ts", mode: "exclusive" })).toBe(true)
    expect(mergeSpecs([{ key: "b", mode: "shared" }, { key: "a", mode: "shared" }, { key: "b", mode: "exclusive" }])).toEqual([
      { key: "a", mode: "shared" },
      { key: "b", mode: "exclusive" },
    ])
  })

  test("an owner, its ancestors and descendants are one family; siblings are not", () => {
    expect(sameFamily("gt:r/T1", "gt:r/T1/exec-2")).toBe(true)
    expect(sameFamily("gt:r/T1/exec-2", "gt:r/T1")).toBe(true)
    expect(sameFamily("gt:r/T1/exec-1", "gt:r/T1/exec-2")).toBe(false)
    expect(sameFamily("gt:r/T1", "gt:r/T10")).toBe(false)
  })
})
import { setDefaultTimeout } from "bun:test"

// Real git and jlock processes: the preload's default reaches only the first file of a run.
setDefaultTimeout(60_000)

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
