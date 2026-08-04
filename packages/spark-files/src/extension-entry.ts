/**
 * External Pi already owns read/write/edit and shell-backed search tools.
 * Spark's versioned file surface is Spark-native only: overriding Pi's built-ins
 * would couple ordinary file access to daemon/session compatibility for little
 * product benefit.
 */
export default function unsupportedPiFilesCompatibilityExtension(): void {}
