# Spark Web parity

Local workbench coverage versus TUI and former dsh web. Uncovered items stay
documented until a later surface pass; they are not treated as done.

| Capability | Spark Web | TUI | Former dsh web |
| --- | --- | --- | --- |
| Daemon workspace list | yes | mixed | yes |
| Local workspace register | yes (path + optional name; no Hub token) | CLI | n/a |
| Sessions list / create | yes (per daemon workspace) | yes | yes |
| Transcript / composer / queue / stop / retry | yes | yes | yes |
| Ask / approval parts | render | yes | yes |
| Model / thinking / mode | model+thinking; mode is read-only (claimed command) | yes | yes |
| Slash catalog | prefix menu | full | full |
| Provider API keys | settings page | TUI + daemon | dsh Models page |
| Workflows panel | no | yes | yes |
| Reviews / graft panels | no | yes | mixed |
| `/compact` | no | yes | yes |
| Export / import / share | no | yes | yes |
| `/tree` | no | yes | no |
| Hotkeys | no | yes | mixed |
