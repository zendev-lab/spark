# Cue integration assets

The canonical `spark-cue` Skill is maintained in
[`zendev-lab/cue`](https://github.com/zendev-lab/cue/tree/main/skills/spark-cue).
Spark keeps a verified snapshot so source checkouts and npm product builds stay
hermetic. The pinned repository revision, upstream path, and content digest are
recorded in `skills/spark-cue.upstream.json` and enforced by
`pnpm run check:cue-skill`.

To update the snapshot, copy `skills/spark-cue/SKILL.md` from an explicit Cue
commit, update the manifest revision and SHA-256, then run the verification,
Spark role, web-dsh, static, and npm product checks. Do not edit the snapshot as
an independent Spark source.
