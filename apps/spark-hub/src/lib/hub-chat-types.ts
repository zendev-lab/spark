export type HubChatPromptSuggestion = {
  id: string;
  label: string;
  prompt: string;
  meta?: string;
};

export type HubChatContextCard<Type extends string = string> = {
  id: string;
  type: Type;
  kicker: string;
  title: string;
  description: string;
  prompt: string;
  primaryLabel: string;
  href?: string;
  secondaryLabel?: string;
};
