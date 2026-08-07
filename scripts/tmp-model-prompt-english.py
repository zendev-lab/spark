from pathlib import Path
import re


def edit(path: str, pairs: list[tuple[str, str]]) -> None:
    p = Path(path)
    text = p.read_text()
    old = text
    for before, after in pairs:
        text = text.replace(before, after)
    if text != old:
        p.write_text(text)


# Goal driver: localized user notifications remain in i18n; model instructions/context do not.
p = Path("packages/spark-extension/src/extension/spark-command-registration.ts")
text = p.read_text()
text = text.replace(
    'import {\n  goalContextStrings,\n  goalInstructions,\n  goalNotifications,\n  sparkLanguageForProject,\n  type SparkLanguage,\n} from "./spark-i18n.ts";',
    'import { goalNotifications, sparkLanguageForProject, type SparkLanguage } from "./spark-i18n.ts";\nimport { goalContextStrings, goalInstructions } from "./spark-model-prompts.ts";',
)
text = re.sub(r'goalInstructions\((?:language|resolvedLanguage)\)', 'goalInstructions()', text)
text = re.sub(r'goalContextStrings\((?:language|resolvedLanguage)\)', 'goalContextStrings()', text)
p.write_text(text)

# Dynamic model context is factual English-only; no translated policy copy lives here.
p = Path("packages/spark-extension/src/extension/spark-active-context.ts")
text = p.read_text()
text = text.replace(
    'import {\n  activeSparkContextStrings,\n  sparkLanguageForProject,\n  type SparkLanguage,\n} from "./spark-i18n.ts";',
    'import { activeSparkContextStrings } from "./spark-model-prompts.ts";',
)
text = text.replace('  language?: SparkLanguage;\n', '')
text = re.sub(
    r'  const language =\n    input\.language \?\?\n    sparkLanguageForProject\(\{[\s\S]*?\n    \}\);\n  const strings = activeSparkContextStrings\(language\);',
    '  const strings = activeSparkContextStrings();',
    text,
    count=1,
)
p.write_text(text)

# The one language directive is model policy, not localization copy.
edit(
    "packages/spark-extension/src/extension/mode/spark-mode-layer.ts",
    [
        ('import type { SparkLanguage } from "../spark-i18n.ts";\nimport { sparkSystemPromptLanguageDirective } from "../spark-i18n.ts";',
         'import type { SparkLanguage } from "../spark-i18n.ts";\nimport { sparkSystemPromptLanguageDirective } from "../spark-model-prompts.ts";'),
    ],
)

# Tool descriptions/guidelines and context-provider description are model-visible English copy.
edit(
    "packages/spark-extension/src/extension/index.ts",
    [
        ('import {\n  sparkExtensionContextProviderStrings,\n  sparkExtensionToolCopy,\n} from "@zendev-lab/spark-i18n/extension";',
         'import {\n  sparkExtensionContextProviderStrings,\n  sparkExtensionToolCopy,\n} from "./spark-model-prompts.ts";'),
    ],
)

# Active context no longer accepts a model-language option. The independently resolved language is
# still passed to the Mode renderer for the one output-language directive.
p = Path("packages/spark-extension/src/extension/spark-active-injection.ts")
text = p.read_text()
text = re.sub(
    r'(renderActiveSparkContext\(\{[\s\S]*?)\n\s*language,([\s\S]*?\}\))',
    r'\1\2',
    text,
)
p.write_text(text)

# Keep the public extension facade explicit: model-copy APIs live beside the model prompt owner.
# Any remaining imports from spark-i18n of model-copy names are compile-time errors by design.
