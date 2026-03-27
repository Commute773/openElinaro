export type StatResult = {
  type: "directory" | "file" | "other";
  sizeBytes: number;
  modifiedAt: string;
  createdAt: string;
};

export type DirEntry = {
  name: string;
  isDirectory: boolean;
};

export type ReadFileResult =
  | { type: "directory"; entries: DirEntry[] }
  | { type: "file"; content: string };

export type GrepMatch = {
  path: string;
  lineNumber: number;
  text: string;
};

export type GrepResult = {
  matches: GrepMatch[];
  totalMatchCount: number | null;
  truncated: boolean;
};

export type ListDirResult = {
  entries: string[];
  totalEntries: number | null;
  truncated: boolean;
};

export type GlobResult = {
  matches: string[];
  truncated: boolean;
};

export interface FilesystemBackend {
  resolveCwd(cwd?: string): string;
  resolvePath(requestedPath: string, cwd: string): string;
  readFileOrDir(targetPath: string): Promise<ReadFileResult>;
  writeFile(targetPath: string, content: string, append: boolean): Promise<{ sizeBytes: number }>;
  stat(targetPath: string): Promise<StatResult | null>;
  statOrThrow(targetPath: string): Promise<StatResult>;
  listDir(targetPath: string, recursive: boolean, limit: number): Promise<ListDirResult>;
  glob(targetPath: string, pattern: string, limit: number): Promise<GlobResult>;
  grep(searchRoot: string, pattern: string, include: string | undefined, limit: number, literal: boolean, caseSensitive: boolean): Promise<GrepResult>;
  mkdir(targetPath: string, recursive: boolean): Promise<void>;
  movePath(source: string, destination: string): Promise<void>;
  copyPath(source: string, destination: string, recursive: boolean): Promise<void>;
  deletePath(targetPath: string, recursive: boolean): Promise<void>;
}
