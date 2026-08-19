# @zendev-lab/pi-spark

Minimal Pi product compatibility adapter. This package is the only
`package.json#pi` owner and the only workspace that depends on
`@earendil-works/pi-coding-agent`.

It registers bounded additive capabilities such as Cue, Ask, Artifacts,
Models, Roles, Sessions, Memory, and Web plus the native Baidu OneAPI provider.
It does not load `@zendev-lab/spark-extension`, install a driver lifecycle, or
expose Spark Goal or Repro. Those remain Spark-native product behavior.
