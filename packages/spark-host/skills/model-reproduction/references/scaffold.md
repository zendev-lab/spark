# Scaffold Stage

Read this reference while the active stage is `scaffold`.

## Ownership and Structure

- Reuse the repositories and extension boundaries selected in setup. Put model-specific code with the model and reusable operators/config bridges in their owning shared modules.
- Keep commits cohesive by mechanism. Avoid workspace runtime monkey-patches as final ownership when the fix belongs in a framework repository.
- Preserve upstream defaults. Accuracy-compatible behavior should be explicit, default-off when required, and threaded from declared configuration through every derived path.

## Native Entrypoints

- Formal Torch and Paddle paths must use their declared native CLIs/loaders. Sidecar scripts may diagnose but must not replace native config parsing, model construction, optimizer, checkpoint, or data loading.
- Keep all path, model, data, result, and environment assumptions explicit in checked-in config or launcher surfaces.
- Fail closed on missing weights, incompatible artifacts, unsupported shapes/topology, or incomplete checkpoint inventories.

## Build Evidence

- Record dependency lock state, editable/source revisions, native extension build provenance, and focused tests.
- Prove the project structure can build and each formal entrypoint reaches real model construction before claiming scaffold completion.
- Keep observation code in experiment/probe surfaces. Production code must not contain cross-framework copyback, NumPy/DLPack computation replacement, dump hooks, or checker-specific shortcuts.
