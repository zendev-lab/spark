export type CopyLanguage = "en" | "zh";

export function detectCopyLanguage(text: string): CopyLanguage {
  return /[\u4e00-\u9fff]/u.test(text) ? "zh" : "en";
}
