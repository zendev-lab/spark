# Experiment Contract

Read this reference before materializing a numerical experiment Task.

Every experiment declares:

- scale profile and real model closure;
- horizon and complete training boundary;
- parent and candidate topology vectors;
- source, weight, tokenizer, data, config, and accepted patch refs;
- changed variable, control value, and treatment value;
- comparison side and exactness projection;
- repetitions and determinism prerequisite;
- GPU/memory/topology request, output namespace, timeout, and max attempts;
- observable assertions and required evidence.

Reject an experiment that changes multiple causal variables, writes over an
accepted run, uses an informal entrypoint for a formal claim, or cannot identify
its immutable parent. A passed probe is diagnostic until the formal entrypoint
repeats the same mechanism and projection.
