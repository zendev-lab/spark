import type {
  ExecutionPlan,
  ExecutionSpec,
  LaunchContext,
  PipeOp,
  ResourceNeeds,
  SpawnAdapterHandle,
} from "../wire/types.ts";

const OPERATORS = ["|&>", "|!>", "|?|", "|||", "|>", "&&", "||", "->", "~>", "(", ")"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

type Token = { kind: "word"; value: string } | { kind: "operator"; value: string };

/** Compile Cue's direct-exec expression syntax without involving cued. */
export function compileExecution(
  input: string,
  options: {
    sourceName?: string;
    pty?: boolean;
    needs?: ResourceNeeds;
    cwd?: string;
    spawnAdapter?: SpawnAdapterHandle;
    retryOf?: number;
  } = {},
): ExecutionSpec {
  if (startsWithCueDirective(input)) {
    throw unsupportedCueDirective(input.trimStart().split(/[\s(]/u, 1)[0]!);
  }
  const tokens = tokenize(input);
  if (tokens.length === 0) throw new Error("Cue execution is empty");
  const parser = new Parser(tokens);
  let plan = parser.parseExpression(0);
  parser.expectEnd();
  if (options.cwd) {
    plan = {
      kind: "on_success",
      left: { kind: "context_delta", delta: { set: {}, unset: [], cwd: options.cwd } },
      right: plan,
    };
  }
  const launch_context: LaunchContext = {};
  if (options.pty !== undefined) launch_context.pty = options.pty;
  const needs = compileNeeds(options.needs);
  if (Object.keys(needs).length > 0) launch_context.needs = needs;
  if (options.spawnAdapter) launch_context.spawn_adapter = options.spawnAdapter;
  return {
    plan,
    launch_context,
    ...(options.sourceName ? { source: { name: options.sourceName } } : {}),
    ...(options.retryOf !== undefined ? { retry_of: options.retryOf } : {}),
  };
}

/** Compile a .cue file as one fail-fast execution. */
export function compileCueFile(
  input: string,
  sourceName: string,
  options: Omit<Parameters<typeof compileExecution>[1], "sourceName"> = {},
): ExecutionSpec {
  const normalized = normalizeCueFile(input);
  const directive = findCueFileDirective(normalized);
  if (directive) throw unsupportedCueDirective(directive);
  const statements = splitCueFileStatements(normalized);
  if (statements.length === 0) throw new Error("a .cue file is empty");
  const plans = statements.map((statement) => compileExecution(statement).plan);
  const plan = plans
    .slice(1)
    .reduce<ExecutionPlan>((left, right) => ({ kind: "on_success", left, right }), plans[0]!);
  return {
    ...compileExecution("true", { ...options, sourceName }),
    plan,
  };
}

function compileNeeds(needs: ResourceNeeds | undefined): NonNullable<LaunchContext["needs"]> {
  const result: NonNullable<LaunchContext["needs"]> = {};
  for (const [key, raw] of Object.entries(needs ?? {})) {
    if (!key || key.startsWith("need.")) {
      throw new Error(`invalid resource need key ${JSON.stringify(key)}`);
    }
    if (typeof raw === "number") {
      if (!Number.isSafeInteger(raw) || raw < 0) {
        throw new Error(`invalid resource count for ${key}`);
      }
      result[key] = { kind: "count", value: raw };
      continue;
    }
    result[key] = parseQuantity(raw, key);
  }
  return result;
}

function parseQuantity(input: string, key: string): { kind: "count" | "bytes"; value: number } {
  const match = input.trim().match(/^(\d[\d_]*)([A-Za-z]*)$/u);
  if (!match) throw new Error(`invalid resource quantity for ${key}: ${input}`);
  const value = Number(match[1]!.replaceAll("_", ""));
  if (!Number.isSafeInteger(value)) throw new Error(`resource quantity for ${key} is too large`);
  const suffix = match[2]!;
  if (!suffix) return { kind: "count", value };
  const multipliers: Record<string, number> = {
    B: 1,
    b: 1,
    KiB: 1024,
    Ki: 1024,
    MiB: 1024 ** 2,
    Mi: 1024 ** 2,
    GiB: 1024 ** 3,
    Gi: 1024 ** 3,
    TiB: 1024 ** 4,
    Ti: 1024 ** 4,
    KB: 1000,
    K: 1000,
    MB: 1000 ** 2,
    M: 1000 ** 2,
    GB: 1000 ** 3,
    G: 1000 ** 3,
    TB: 1000 ** 4,
    T: 1000 ** 4,
  };
  const multiplier = multipliers[suffix];
  if (multiplier === undefined || !Number.isSafeInteger(value * multiplier)) {
    throw new Error(`invalid resource quantity for ${key}: ${input}`);
  }
  return { kind: "bytes", value: value * multiplier };
}

class Parser {
  #index = 0;
  readonly #tokens: Token[];

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  parseExpression(minPrecedence: number): ExecutionPlan {
    let left = this.parsePrimary();
    while (true) {
      const operator = this.peekOperator();
      if (operator === undefined) break;
      const precedence = PRECEDENCE[operator];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.#index += 1;
      const right = this.parseExpression(precedence + 1);
      left = combine(operator, left, right);
    }
    return left;
  }

  expectEnd(): void {
    if (this.#index !== this.#tokens.length) {
      throw new Error(`unexpected token ${JSON.stringify(this.#tokens[this.#index])}`);
    }
  }

  private parsePrimary(): ExecutionPlan {
    if (this.peekOperator() === "(") {
      this.#index += 1;
      const plan = this.parseExpression(0);
      if (this.peekOperator() !== ")") throw new Error("unclosed Cue group");
      this.#index += 1;
      return plan;
    }
    return this.parsePipeline();
  }

  private parsePipeline(): ExecutionPlan {
    const segments = [];
    while (true) {
      const words: string[] = [];
      while (this.#index < this.#tokens.length && this.#tokens[this.#index]?.kind === "word") {
        words.push((this.#tokens[this.#index++] as Extract<Token, { kind: "word" }>).value);
      }
      if (words.length === 0) throw new Error("expected a command");
      const env: Record<string, string> = {};
      while (words.length > 1) {
        const assignment = splitEnvironmentAssignment(words[0]!);
        if (!assignment) break;
        words.shift();
        env[assignment[0]] = assignment[1];
      }
      if (splitEnvironmentAssignment(words[0]!)) {
        throw new Error("environment assignments must be followed by a command");
      }
      const pipe = this.peekOperator();
      const pipe_to_next = PIPE_OPERATORS[pipe ?? ""];
      segments.push({ env, command: words, pipe_to_next: pipe_to_next ?? null });
      if (pipe_to_next === undefined) break;
      this.#index += 1;
    }
    return { kind: "pipeline", pipeline: { segments } };
  }

  private peekOperator(): string | undefined {
    const token = this.#tokens[this.#index];
    return token?.kind === "operator" ? token.value : undefined;
  }
}

const PRECEDENCE: Record<string, number> = {
  "->": 1,
  "~>": 1,
  "|||": 2,
  "|?|": 2,
  "&&": 3,
  "||": 3,
};

const PIPE_OPERATORS: Record<string, PipeOp> = {
  "|>": "Stdout",
  "|&>": "StdoutStderr",
  "|!>": "StderrOnly",
};

function combine(operator: string, left: ExecutionPlan, right: ExecutionPlan): ExecutionPlan {
  switch (operator) {
    case "&&":
    case "->":
      return { kind: "on_success", left, right };
    case "||":
      return { kind: "on_failure", left, right };
    case "~>":
      return { kind: "always", left, right };
    case "|||":
      return { kind: "parallel_all", branches: flatten(operator, left, right) };
    case "|?|":
      return { kind: "any_success", branches: flatten(operator, left, right) };
    default:
      throw new Error(`unsupported Cue operator ${operator}`);
  }
}

function flatten(operator: string, left: ExecutionPlan, right: ExecutionPlan): ExecutionPlan[] {
  const kind = operator === "|||" ? "parallel_all" : "any_success";
  return [
    ...(left.kind === kind ? left.branches : [left]),
    ...(right.kind === kind ? right.branches : [right]),
  ];
}

function splitEnvironmentAssignment(word: string): [string, string] | undefined {
  const equals = word.indexOf("=");
  if (equals <= 0) return undefined;
  const key = word.slice(0, equals);
  if (!ENV_NAME.test(key)) return undefined;
  return [key, word.slice(equals + 1)];
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | undefined;
  const flush = () => {
    if (wordStarted) tokens.push({ kind: "word", value: word });
    word = "";
    wordStarted = false;
  };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (quote === '"' && char === "\\") {
        const escaped = input[index + 1];
        if (escaped === undefined) throw new Error("unterminated Cue word");
        index += 1;
        word +=
          escaped === "n"
            ? "\n"
            : escaped === "t"
              ? "\t"
              : escaped === '"' || escaped === "\\"
                ? escaped
                : `\\${escaped}`;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      wordStarted = true;
      continue;
    }
    if (isCueWhitespace(char)) {
      flush();
      continue;
    }
    const operator = OPERATORS.find((candidate) => input.startsWith(candidate, index));
    if (operator) {
      if (
        CHAIN_OPERATORS.has(operator) &&
        !hasChainOperatorBoundary(input, index, operator.length)
      ) {
        throw new Error(
          `Cue chain operator ${JSON.stringify(operator)} must be surrounded by whitespace`,
        );
      }
      flush();
      tokens.push({ kind: "operator", value: operator });
      index += operator.length - 1;
      continue;
    }
    if (char === "|") {
      throw new Error("bare `|` is not a Cue pipe operator; use `|>` or quote it as an argument");
    }
    if (";<>`".includes(char) || input.startsWith("$(", index)) {
      throw new Error(`shell syntax ${JSON.stringify(char)} is not supported by Cue`);
    }
    wordStarted = true;
    word += char;
  }
  if (quote) throw new Error("unterminated Cue word");
  flush();
  return tokens;
}

const CHAIN_OPERATORS = new Set(["->", "~>", "|||", "|?|"]);

function hasChainOperatorBoundary(input: string, start: number, length: number): boolean {
  const before = input[start - 1];
  const after = input[start + length];
  return (
    (before === undefined || isCueWhitespace(before)) &&
    (after === undefined || isCueWhitespace(after))
  );
}

function isCueWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\r" || value === "\n";
}

function startsWithCueDirective(input: string): boolean {
  return input.trimStart().startsWith(":");
}

function unsupportedCueDirective(directive: string): Error {
  return new Error(
    `Cue directive ${JSON.stringify(directive)} is not supported by the direct execution compiler`,
  );
}

function findCueFileDirective(input: string): string | undefined {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let lineStart = true;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === "\n") {
      lineStart = true;
      continue;
    }
    if (!lineStart) continue;
    if (char === " " || char === "\t" || char === "\r") continue;
    if (char === ":") return input.slice(index).split(/[\s(]/u, 1)[0];
    const operator = CONTINUATION_OPERATORS.find(
      (candidate) =>
        input.startsWith(candidate, index) &&
        isCueWhitespace(input[index + candidate.length] ?? ""),
    );
    if (operator) {
      index += operator.length - 1;
      continue;
    }
    lineStart = false;
    if (char === '"' || char === "'") quote = char;
  }
  return undefined;
}

function normalizeCueFile(input: string): string {
  return input
    .split(/\n/u)
    .map((line, index) => {
      const body = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (index === 0 && body.startsWith("#!")) return "";
      return stripCueFileComment(body);
    })
    .join("\n");
}

function stripCueFileComment(line: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let commentBoundary = true;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === "#" && commentBoundary) return line.slice(0, index).trimEnd();
    if (char === '"' || char === "'") {
      quote = char;
      commentBoundary = false;
    } else {
      commentBoundary = char === " " || char === "\t";
    }
  }
  return line;
}

const CONTINUATION_OPERATORS = ["|&>", "|!>", "|||", "|?|", "->", "~>", "|>", "&&", "||"];

function splitCueFileStatements(input: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let groupDepth = 0;
  const flush = () => {
    const statement = current.trim();
    if (statement) statements.push(statement);
    current = "";
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote === '"') {
      current += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = undefined;
      continue;
    }
    if (quote === "'") {
      current += char;
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") groupDepth += 1;
    else if (char === ")") groupDepth = Math.max(0, groupDepth - 1);
    if (char !== "\n") {
      current += char;
      continue;
    }

    const previousContinues = CONTINUATION_OPERATORS.some((operator) =>
      current.trimEnd().endsWith(operator),
    );
    const next = input.slice(index + 1).trimStart();
    const nextContinues = CONTINUATION_OPERATORS.some((operator) => next.startsWith(operator));
    if (groupDepth > 0 || previousContinues || nextContinues) current += " ";
    else flush();
  }
  flush();
  return statements;
}
