import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { FilesystemService } from "./filesystem-service";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fs-service-test-"));
}

describe("FilesystemService", () => {
  let tmpDir: string;
  let service: FilesystemService;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    service = new FilesystemService();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("read", () => {
    test("reads a text file with line numbers", async () => {
      const filePath = path.join(tmpDir, "test.txt");
      fs.writeFileSync(filePath, "hello\nworld\n");

      const result = await service.read({ path: filePath });
      expect(result).toContain("Path: " + filePath);
      expect(result).toContain("Type: file");
      expect(result).toContain("1: hello");
      expect(result).toContain("2: world");
    });

    test("reads an empty file", async () => {
      const filePath = path.join(tmpDir, "empty.txt");
      fs.writeFileSync(filePath, "");

      const result = await service.read({ path: filePath });
      expect(result).toContain("(empty file)");
    });

    test("supports offset and limit", async () => {
      const filePath = path.join(tmpDir, "lines.txt");
      fs.writeFileSync(filePath, "a\nb\nc\nd\ne\n");

      const result = await service.read({ path: filePath, offset: 2, limit: 2 });
      expect(result).toContain("2: b");
      expect(result).toContain("3: c");
      expect(result).not.toContain("1: a");
      expect(result).not.toContain("4: d");
    });

    test("throws when offset < 1", async () => {
      const filePath = path.join(tmpDir, "test.txt");
      fs.writeFileSync(filePath, "hello\n");

      await expect(service.read({ path: filePath, offset: 0 })).rejects.toThrow(
        "offset must be greater than or equal to 1",
      );
    });

    test("throws when limit < 1", async () => {
      const filePath = path.join(tmpDir, "test.txt");
      fs.writeFileSync(filePath, "hello\n");

      await expect(service.read({ path: filePath, limit: 0 })).rejects.toThrow(
        "limit must be greater than or equal to 1",
      );
    });

    test("throws when path does not exist", async () => {
      await expect(
        service.read({ path: path.join(tmpDir, "nonexistent.txt") }),
      ).rejects.toThrow("not found");
    });

    test("reads a directory listing when path is a directory", async () => {
      fs.writeFileSync(path.join(tmpDir, "file1.txt"), "");
      fs.mkdirSync(path.join(tmpDir, "subdir"));

      const result = await service.read({ path: tmpDir });
      expect(result).toContain("Type: directory");
      expect(result).toContain("file1.txt");
      expect(result).toContain("subdir/");
    });

    test("throws for binary files", async () => {
      const filePath = path.join(tmpDir, "binary.dat");
      const buf = Buffer.alloc(1024);
      buf.fill(0);
      fs.writeFileSync(filePath, buf);

      await expect(service.read({ path: filePath })).rejects.toThrow("binary file");
    });

    test("accepts filePath as an alias for path", async () => {
      const filePath = path.join(tmpDir, "alias.txt");
      fs.writeFileSync(filePath, "content\n");

      const result = await service.read({ filePath });
      expect(result).toContain("1: content");
    });

    test("throws when path is not provided", async () => {
      await expect(service.read({})).rejects.toThrow("path is required");
    });
  });

  describe("write", () => {
    test("writes content to a new file", async () => {
      const filePath = path.join(tmpDir, "new.txt");
      const result = await service.write({ path: filePath, content: "hello world" });

      expect(result).toContain("Wrote");
      expect(result).toContain(filePath);
      expect(fs.readFileSync(filePath, "utf8")).toBe("hello world");
    });

    test("overwrites an existing file", async () => {
      const filePath = path.join(tmpDir, "overwrite.txt");
      fs.writeFileSync(filePath, "old content");

      await service.write({ path: filePath, content: "new content" });
      expect(fs.readFileSync(filePath, "utf8")).toBe("new content");
    });

    test("appends content when append=true", async () => {
      const filePath = path.join(tmpDir, "append.txt");
      fs.writeFileSync(filePath, "first ");

      const result = await service.write({ path: filePath, content: "second", append: true });
      expect(result).toContain("Appended");
      expect(fs.readFileSync(filePath, "utf8")).toBe("first second");
    });

    test("creates parent directories if needed", async () => {
      const filePath = path.join(tmpDir, "a", "b", "c", "deep.txt");
      await service.write({ path: filePath, content: "deep" });

      expect(fs.readFileSync(filePath, "utf8")).toBe("deep");
    });

    test("throws when path is a directory", async () => {
      fs.mkdirSync(path.join(tmpDir, "adir"));
      await expect(
        service.write({ path: path.join(tmpDir, "adir"), content: "x" }),
      ).rejects.toThrow("directory");
    });
  });

  describe("edit", () => {
    test("replaces a unique string occurrence", async () => {
      const filePath = path.join(tmpDir, "edit.txt");
      fs.writeFileSync(filePath, "hello world\n");

      const result = await service.edit({
        path: filePath,
        oldString: "hello",
        newString: "goodbye",
      });

      expect(result).toContain("Edit applied successfully");
      expect(fs.readFileSync(filePath, "utf8")).toBe("goodbye world\n");
    });

    test("supports old_string / new_string aliases", async () => {
      const filePath = path.join(tmpDir, "alias-edit.txt");
      fs.writeFileSync(filePath, "foo bar\n");

      await service.edit({
        path: filePath,
        old_string: "foo",
        new_string: "baz",
      });

      expect(fs.readFileSync(filePath, "utf8")).toBe("baz bar\n");
    });

    test("throws when oldString is not found", async () => {
      const filePath = path.join(tmpDir, "noedit.txt");
      fs.writeFileSync(filePath, "unchanged\n");

      await expect(
        service.edit({ path: filePath, oldString: "xyz", newString: "abc" }),
      ).rejects.toThrow("oldString was not found");
    });

    test("throws when oldString matches multiple times without replaceAll", async () => {
      const filePath = path.join(tmpDir, "multi.txt");
      fs.writeFileSync(filePath, "aaa bbb aaa\n");

      await expect(
        service.edit({ path: filePath, oldString: "aaa", newString: "ccc" }),
      ).rejects.toThrow("matched 2 occurrences");
    });

    test("replaces all occurrences with replaceAll=true", async () => {
      const filePath = path.join(tmpDir, "replaceall.txt");
      fs.writeFileSync(filePath, "aaa bbb aaa\n");

      await service.edit({
        path: filePath,
        oldString: "aaa",
        newString: "ccc",
        replaceAll: true,
      });

      expect(fs.readFileSync(filePath, "utf8")).toBe("ccc bbb ccc\n");
    });

    test("throws when oldString and newString are identical", async () => {
      const filePath = path.join(tmpDir, "same.txt");
      fs.writeFileSync(filePath, "abc\n");

      await expect(
        service.edit({ path: filePath, oldString: "abc", newString: "abc" }),
      ).rejects.toThrow("identical");
    });

    test("prepends content when oldString is empty", async () => {
      const filePath = path.join(tmpDir, "prepend.txt");
      fs.writeFileSync(filePath, "existing\n");

      await service.edit({ path: filePath, oldString: "", newString: "prefix " });
      expect(fs.readFileSync(filePath, "utf8")).toBe("prefix existing\n");
    });

    test("throws when path is a directory", async () => {
      fs.mkdirSync(path.join(tmpDir, "dir"));
      await expect(
        service.edit({ path: path.join(tmpDir, "dir"), oldString: "x", newString: "y" }),
      ).rejects.toThrow("directory");
    });

    test("throws when file does not exist", async () => {
      await expect(
        service.edit({ path: path.join(tmpDir, "nope.txt"), oldString: "x", newString: "y" }),
      ).rejects.toThrow("not found");
    });
  });

  describe("listDir", () => {
    test("lists directory entries with trailing slash for subdirs", async () => {
      fs.writeFileSync(path.join(tmpDir, "file.txt"), "");
      fs.mkdirSync(path.join(tmpDir, "sub"));

      const result = await service.listDir({ path: tmpDir });
      expect(result).toContain("file.txt");
      expect(result).toContain("sub/");
    });

    test("returns empty directory message for empty dirs", async () => {
      const emptyDir = path.join(tmpDir, "empty");
      fs.mkdirSync(emptyDir);

      const result = await service.listDir({ path: emptyDir });
      expect(result).toContain("(empty directory)");
    });

    test("throws when limit < 1", async () => {
      await expect(service.listDir({ path: tmpDir, limit: 0 })).rejects.toThrow(
        "limit must be greater than or equal to 1",
      );
    });

    test("throws when path is not a directory", async () => {
      const filePath = path.join(tmpDir, "file.txt");
      fs.writeFileSync(filePath, "");

      await expect(service.listDir({ path: filePath })).rejects.toThrow("not a directory");
    });

    test("supports recursive listing", async () => {
      fs.mkdirSync(path.join(tmpDir, "a"));
      fs.writeFileSync(path.join(tmpDir, "a", "nested.txt"), "");

      const result = await service.listDir({ path: tmpDir, recursive: true });
      expect(result).toContain("a/nested.txt");
    });

    test("supports json format", async () => {
      fs.writeFileSync(path.join(tmpDir, "item.txt"), "");

      const result = await service.listDir({ path: tmpDir, format: "json" });
      expect(result).toHaveProperty("entries");
      expect((result as any).entries).toContain("item.txt");
    });
  });

  describe("statPath", () => {
    test("returns file stats", async () => {
      const filePath = path.join(tmpDir, "stat.txt");
      fs.writeFileSync(filePath, "hello");

      const result = await service.statPath({ path: filePath });
      expect(result).toContain("Type: file");
      expect(result).toContain("Size: 5 bytes");
    });

    test("returns directory stats", async () => {
      const result = await service.statPath({ path: tmpDir });
      expect(result).toContain("Type: directory");
    });

    test("returns json format when requested", async () => {
      const filePath = path.join(tmpDir, "stat.txt");
      fs.writeFileSync(filePath, "hi");

      const result = await service.statPath({ path: filePath, format: "json" });
      expect(result).toHaveProperty("type", "file");
      expect(result).toHaveProperty("sizeBytes", 2);
    });

    test("throws when path does not exist", async () => {
      await expect(
        service.statPath({ path: path.join(tmpDir, "nope") }),
      ).rejects.toThrow("not found");
    });
  });

  describe("mkdir", () => {
    test("creates a new directory", async () => {
      const dirPath = path.join(tmpDir, "newdir");
      const result = await service.mkdir({ path: dirPath });

      expect(result).toContain("Created directory");
      expect(fs.statSync(dirPath).isDirectory()).toBe(true);
    });

    test("creates nested directories by default (recursive)", async () => {
      const dirPath = path.join(tmpDir, "a", "b", "c");
      await service.mkdir({ path: dirPath });

      expect(fs.statSync(dirPath).isDirectory()).toBe(true);
    });
  });

  describe("movePath", () => {
    test("moves a file from source to destination", async () => {
      const src = path.join(tmpDir, "src.txt");
      const dst = path.join(tmpDir, "dst.txt");
      fs.writeFileSync(src, "move me");

      const result = await service.movePath({ source: src, destination: dst });
      expect(result).toContain("Moved");
      expect(fs.existsSync(src)).toBe(false);
      expect(fs.readFileSync(dst, "utf8")).toBe("move me");
    });

    test("supports src/dst aliases", async () => {
      const src = path.join(tmpDir, "src2.txt");
      const dst = path.join(tmpDir, "dst2.txt");
      fs.writeFileSync(src, "alias");

      await service.movePath({ src, dst });
      expect(fs.existsSync(src)).toBe(false);
      expect(fs.readFileSync(dst, "utf8")).toBe("alias");
    });

    test("throws when source does not exist", async () => {
      await expect(
        service.movePath({
          source: path.join(tmpDir, "nope.txt"),
          destination: path.join(tmpDir, "dest.txt"),
        }),
      ).rejects.toThrow("not found");
    });

    test("throws when source and destination are missing", async () => {
      await expect(service.movePath({} as any)).rejects.toThrow("required");
    });
  });

  describe("copyPath", () => {
    test("copies a file", async () => {
      const src = path.join(tmpDir, "original.txt");
      const dst = path.join(tmpDir, "copy.txt");
      fs.writeFileSync(src, "copy me");

      const result = await service.copyPath({ source: src, destination: dst });
      expect(result).toContain("Copied");
      expect(fs.readFileSync(dst, "utf8")).toBe("copy me");
      expect(fs.existsSync(src)).toBe(true);
    });

    test("copies a directory recursively", async () => {
      const srcDir = path.join(tmpDir, "srcdir");
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, "inner.txt"), "inside");

      const dstDir = path.join(tmpDir, "dstdir");
      await service.copyPath({ source: srcDir, destination: dstDir, recursive: true });

      expect(fs.readFileSync(path.join(dstDir, "inner.txt"), "utf8")).toBe("inside");
    });

    test("throws when copying directory without recursive=true", async () => {
      const srcDir = path.join(tmpDir, "norecurse");
      fs.mkdirSync(srcDir);

      await expect(
        service.copyPath({
          source: srcDir,
          destination: path.join(tmpDir, "target"),
        }),
      ).rejects.toThrow("recursive=true");
    });

    test("throws when source does not exist", async () => {
      await expect(
        service.copyPath({
          source: path.join(tmpDir, "missing"),
          destination: path.join(tmpDir, "dst"),
        }),
      ).rejects.toThrow("not found");
    });
  });

  describe("deletePath", () => {
    test("deletes a file", async () => {
      const filePath = path.join(tmpDir, "delete-me.txt");
      fs.writeFileSync(filePath, "bye");

      const result = await service.deletePath({ path: filePath });
      expect(result).toContain("Deleted");
      expect(fs.existsSync(filePath)).toBe(false);
    });

    test("deletes a directory with recursive=true", async () => {
      const dirPath = path.join(tmpDir, "deldir");
      fs.mkdirSync(dirPath);
      fs.writeFileSync(path.join(dirPath, "child.txt"), "");

      await service.deletePath({ path: dirPath, recursive: true });
      expect(fs.existsSync(dirPath)).toBe(false);
    });

    test("throws when deleting a directory without recursive=true", async () => {
      const dirPath = path.join(tmpDir, "norecurse-del");
      fs.mkdirSync(dirPath);

      await expect(service.deletePath({ path: dirPath })).rejects.toThrow("recursive=true");
    });

    test("throws when path does not exist", async () => {
      await expect(
        service.deletePath({ path: path.join(tmpDir, "nope") }),
      ).rejects.toThrow("not found");
    });
  });

  describe("access control integration", () => {
    test("calls assertPathAccess on read", async () => {
      const assertPathAccess = mock((p: string) => p);
      const access = { assertPathAccess } as any;
      const svc = new FilesystemService(access);
      const filePath = path.join(tmpDir, "ac.txt");
      fs.writeFileSync(filePath, "data\n");

      await svc.read({ path: filePath });
      expect(assertPathAccess).toHaveBeenCalled();
    });

    test("throws when access control denies path", async () => {
      const access = {
        assertPathAccess: () => {
          throw new Error("Access denied");
        },
      } as any;
      const svc = new FilesystemService(access);
      const filePath = path.join(tmpDir, "denied.txt");
      fs.writeFileSync(filePath, "nope\n");

      await expect(svc.read({ path: filePath })).rejects.toThrow("Access denied");
    });
  });
});
