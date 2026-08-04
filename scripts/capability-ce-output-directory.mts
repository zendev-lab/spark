import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export async function assertSafeCapabilityCeOutputDirectory(input: {
  repositoryRoot: string;
  outputDir: string;
}): Promise<void> {
  const reportsRoot = join(input.repositoryRoot, "reports");
  const pathFromReports = relative(reportsRoot, input.outputDir);
  if (
    !pathFromReports ||
    pathFromReports === ".." ||
    pathFromReports.startsWith(`..${sep}`) ||
    isAbsolute(pathFromReports)
  ) {
    throw new Error(
      "Nightly CE output directory must be a child of the repository reports directory",
    );
  }

  let candidate = reportsRoot;
  for (const segment of ["", ...pathFromReports.split(sep)]) {
    candidate = segment ? join(candidate, segment) : candidate;
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `Nightly CE output directory must not traverse a symbolic link: ${candidate}`,
        );
      }
      if (!metadata.isDirectory()) {
        throw new Error(`Nightly CE output path component must be a directory: ${candidate}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
