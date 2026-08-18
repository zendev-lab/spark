# @zendev-lab/pi-spark

Pi product compatibility adapter. This package is the only `package.json#pi`
owner and the only workspace that depends on `@earendil-works/pi-coding-agent`.

It loads the Spark compatibility profile and then
`@zendev-lab/spark-extension`. It is not a second Spark composition root, and
Spark-native hosts do not load it.
