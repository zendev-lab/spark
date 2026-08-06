export function normalize(values, epsilon = 1e-5) {
  assertValues(values);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  // Intentional fixture defect: the reference uses sqrt(variance + epsilon).
  const denominator = variance + epsilon;
  return values.map((value) => (value - mean) / denominator);
}

function assertValues(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("normalize requires a non-empty number array");
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("normalize requires finite numbers");
  }
}
